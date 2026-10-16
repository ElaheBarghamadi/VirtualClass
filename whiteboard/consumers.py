"""WebSocket consumer for the collaborative whiteboard.

Endpoint: ``/ws/classroom/<room_code>/whiteboard/?since=<seq>``

Protocol
--------
client → server::

    {"action": "op",     "op":  {...}}          # one operation
    {"action": "ops",    "ops": [{...}, ...]}   # batch (≤ 64, atomic)
    {"action": "resync", "since": 128}          # send me the tail from here
    {"action": "snapshot", "seq": 900, "ops": [...]}   # publish flattened board
    {"action": "presence"}                      # refresh my roster entry
    {"action": "ping", "t": 1234}               # latency probe

server → client::

    {"type": "whiteboard_history", ...}   # first frame: metadata + ops to replay
    {"type": "whiteboard_operation", ...} # one accepted (or relayed) operation
    {"type": "presence", ...}             # participant joined / left / changed
    {"type": "error", ...}                # rejection (carries the op ids)
    {"type": "pong", "t": ...}

Authorization: only active members may read the board; only members with an
effective ``can_use_whiteboard`` may change it.  Permissions are re-checked
inside the persistence transaction, so a revocation mid-session takes effect
for the very next operation.
"""
from __future__ import annotations

import logging
import time
from collections import deque
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.layers import get_channel_layer

from classrooms.services import member_group, resolve_scope_member
from classrooms.ws_security import (
    RateLimiter,
    SafeJsonWebsocketConsumer,
    ws_origin_allowed,
)

from . import services
from .protocol import (
    BATCH_COST_FREE,
    EPHEMERAL_OP_TYPES,
    MAX_BATCH_OPS,
    MAX_OP_BYTES,
    MAX_POINTS,
    RATE_LIMIT_OPS,
    validate_op,
)

logger = logging.getLogger(__name__)

CLOSED_UNAUTHENTICATED = 4401
CLOSED_FORBIDDEN = 4403

#: How long a permission/membership answer may be reused.
#:
#: Pointers and in-progress strokes arrive many times per second and used to
#: cost three database round trips each before they were relayed, which is what
#: made everyone else's board lag behind the person drawing.  The answer is now
#: cached for a few seconds and thrown away on the spot whenever the member is
#: actually notified about a change, so a revocation still takes effect
#: immediately and the live path costs no queries at all.
PERMISSION_TTL = 3.0

#: A frame that took longer than this is logged: it is the number to look at
#: when "the board lags for everybody" needs a cause.
SLOW_FRAME_MS = 250


class WhiteboardConsumer(SafeJsonWebsocketConsumer):
    """Validates, stores and relays structured whiteboard operations."""


    # ------------------------------------------------------------------ #
    # Connection lifecycle
    # ------------------------------------------------------------------ #
    async def connect(self) -> None:
        self.room_code: str = self.scope["url_route"]["kwargs"]["room_code"]
        self.group_name = f"classroom_wb_{self.room_code}"
        self.member_group_name = ""
        self.member = None
        self.classroom = None
        self.last_seq = 0
        self.can_draw = False
        self.since = self._query_int("since")

        user = self.scope.get("user")
        authenticated = bool(user is not None and getattr(user, "is_authenticated", False))

        if not ws_origin_allowed(self.scope):
            logger.warning("ws_origin_rejected room=%s", self.room_code)
            await self.close(code=CLOSED_FORBIDDEN)
            return

        self._limiter = RateLimiter(RATE_LIMIT_OPS)
        # Sequences this connection broadcast itself.  They are the only frames
        # allowed through the watermark check below: a client has to hear its
        # own operation come back, because that echo is what turns its
        # optimistic stroke into a confirmed one (and adopts any normalisation
        # the server applied).
        self._own_seqs: deque[int] = deque(maxlen=128)
        # cached (is_active, can_draw) for the hot path — see PERMISSION_TTL
        self._perm_checked_at = 0.0
        self._member_is_active = True
        self._perm_can_draw = False
        self.classroom, self.member = await self._load_membership()
        if self.member is None or self.classroom is None:
            await self.close(code=CLOSED_UNAUTHENTICATED if not authenticated else CLOSED_FORBIDDEN)
            return
        if not self.member.is_active or self.member.in_waiting_room:
            await self.close(code=CLOSED_FORBIDDEN)
            return

        snapshot = await self._load_snapshot(self.since)
        if snapshot is None:
            await self.close(code=CLOSED_FORBIDDEN)
            return

        self.member_group_name = member_group(self.room_code, self.member.id)
        # Join before reading is re-sent so no operation can slip through the
        # window between "snapshot taken" and "socket is listening"; the client
        # de-duplicates by sequence number.
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.channel_layer.group_add(self.member_group_name, self.channel_name)
        await self.accept()

        self.last_seq = snapshot["seq"]
        self.can_draw = snapshot["you"]["can_draw"]
        # the frame we just sent already carries a fresh answer, so the live
        # lane never needs a query for it
        self._member_is_active = True
        self._perm_can_draw = self.can_draw
        self._perm_checked_at = time.monotonic()
        await self.send_json(snapshot)
        await self._broadcast_presence("join")

    async def disconnect(self, code: int) -> None:
        if self.member is None:
            return
        try:
            await self.channel_layer.group_discard(self.group_name, self.channel_name)
            await self.channel_layer.group_discard(
                self.member_group_name or member_group(self.room_code, self.member.id),
                self.channel_name,
            )
        finally:
            await self._broadcast_presence("leave")

    # ------------------------------------------------------------------ #
    # Frame handling
    # ------------------------------------------------------------------ #
    async def receive_json(self, content: dict, **kwargs) -> None:
        action = content.get("action")
        if action == "ping":
            await self.send_json({"type": "pong", "t": content.get("t")})
            return
        if action == "presence":
            await self._refresh_permissions()
            await self._broadcast_presence("update")
            return
        if action == "resync":
            await self._handle_resync(content)
            return
        if action == "snapshot":
            await self._handle_snapshot(content)
            return
        if action in {"op", "ops"}:
            await self._handle_ops(content)
            return
        # Unknown actions are ignored on purpose: a newer client may speak a
        # dialect this build does not know yet.

    async def _handle_resync(self, content: dict) -> None:
        if not self._limiter.allow():
            await self._error("تعداد درخواست‌ها زیاد است؛ کمی صبر کنید.", "rate-limited")
            return
        snapshot = await self._load_snapshot(self._as_int(content.get("since"), 0))
        if snapshot is None:
            await self.close(code=CLOSED_FORBIDDEN)
            return
        self.last_seq = snapshot["seq"]
        self.can_draw = snapshot["you"]["can_draw"]
        await self.send_json(snapshot)

    async def _handle_snapshot(self, content: dict) -> None:
        if not self._limiter.allow(BATCH_COST_FREE):
            await self._error("تعداد درخواست‌ها زیاد است؛ کمی صبر کنید.", "rate-limited")
            return
        seq = self._as_int(content.get("seq"), -1)
        reason = await self._store_snapshot(seq, content.get("ops"))
        if reason is None:
            await self.send_json({"type": "snapshot_stored", "seq": seq})
            return
        if reason == "forbidden":
            await self.close(code=CLOSED_FORBIDDEN)
            return
        logger.info("whiteboard_snapshot_rejected room=%s reason=%s", self.room_code, reason)
        await self.send_json({"type": "snapshot_rejected", "seq": seq, "reason": reason})

    async def _handle_ops(self, content: dict) -> None:
        if content.get("action") == "op":
            ops = [content.get("op")]
        else:
            ops = content.get("ops")
        if not isinstance(ops, list) or not ops:
            await self._error("عملیات تخته نامعتبر است.", "invalid-op")
            return
        if len(ops) > MAX_BATCH_OPS:
            await self._error("تعداد عملیات یک پیام بیش از حد مجاز است.", "batch-too-large")
            return

        cost = max(1, len(ops) // BATCH_COST_FREE)
        if not self._limiter.allow(cost):
            logger.info("whiteboard_rate_limited room=%s", self.room_code)
            await self._error("تعداد عملیات بیش از حد مجاز است؛ کمی صبر کنید.", "rate-limited")
            return

        started = time.monotonic()
        ids = [op.get("id") for op in ops if isinstance(op, dict) and op.get("id")]
        for op in ops:
            live = isinstance(op, dict) and bool(op.get("live"))
            reason = validate_op(op, live=live)
            if reason:
                logger.info("whiteboard_op_rejected room=%s reason=%s", self.room_code, reason)
                await self._error("عملیات تخته نامعتبر است.", "invalid-op", ids)
                return

        # Classify by position: two identical operations in one batch must
        # never be able to drop each other (``op not in list`` compares values).
        is_ephemeral = [
            op.get("type") in EPHEMERAL_OP_TYPES or bool(op.get("live"))
            for op in ops
        ]
        ephemeral = [op for op, flag in zip(ops, is_ephemeral) if flag]
        persistent = [op for op, flag in zip(ops, is_ephemeral) if not flag]

        # ---- live lane: pointers and in-progress strokes --------------------
        # These are worthless a moment later, so they are relayed straight from
        # the cached membership and never touch the database.  A viewer's
        # pointers are dropped silently (no error frame per mouse move, which
        # used to spam a toast and a round trip for every pixel of movement).
        if ephemeral:
            active, can_draw = await self._cached_permissions()
            if not active:
                await self.close(code=CLOSED_FORBIDDEN)
                return
            if can_draw:
                for op in ephemeral:
                    await self._relay_ephemeral(op)

        if not persistent:
            self._log_slow_frame(started, len(ops), "ephemeral")
            return

        # The permission is re-checked *inside* the write transaction (the only
        # authoritative place), so no second round trip is needed out here.
        try:
            result = await self._persist(persistent)
        except services.OpRejected as exc:
            logger.info("whiteboard_op_rejected room=%s reason=%s", self.room_code, exc.reason)
            await self._error("عملیات تخته نامعتبر است.", exc.reason, ids)
            return
        if result is None:
            self.can_draw = False
            self._perm_checked_at = 0.0  # the cached answer was wrong
            await self._error("شما اجازهٔ استفاده از تخته را ندارید.", "forbidden", ids)
            return
        self._perm_can_draw = True

        stored, board_state = result
        server_ms = round((time.monotonic() - started) * 1000)
        for op, seq, event_id in stored:
            self.last_seq = max(self.last_seq, seq)
            self._own_seqs.append(seq)
            await self._broadcast(
                op,
                seq=seq,
                event_id=event_id,
                board=self._meta_for(op, board_state),
                server_ms=server_ms,
            )
        self._log_slow_frame(started, len(ops), "persistent")

    # ------------------------------------------------------------------ #
    # Group handlers
    # ------------------------------------------------------------------ #
    async def whiteboard_operation(self, event: dict) -> None:
        payload = {
            "type": "whiteboard_operation",
            "op": event["op"],
            "seq": event.get("seq", 0),
            "event_id": event.get("event_id"),
            "ephemeral": bool(event.get("ephemeral")),
            "live": bool(event.get("live")),
            "actor_identity": event.get("actor_identity", ""),
            "actor_name": event.get("actor_name", ""),
        }
        if event.get("board"):
            payload["board"] = event["board"]
        if event.get("server_ms") is not None:
            payload["server_ms"] = int(event["server_ms"])
        if payload["ephemeral"]:
            # A mirror of our own pointer/stroke is pure waste: the live lane
            # can be the busiest traffic on the board (a streamed stroke carries
            # up to MAX_LIVE_POINTS points), and the sender has it on screen
            # already.
            if event.get("sender") == self.channel_name:
                return
        else:
            # The snapshot/operation race on (re)connect is resolved by
            # sequence: everything at or below the watermark is already in the
            # client — except our own operation, whose echo is exactly how the
            # client confirms it.
            if payload["seq"] <= self.last_seq and payload["seq"] not in self._own_seqs:
                return
            self.last_seq = max(self.last_seq, payload["seq"])
        await self.send_json(payload)

    async def board_presence(self, event: dict) -> None:
        participant = event.get("participant") or {}
        if participant.get("identity") == getattr(self.member, "identity", None):
            return
        await self.send_json(
            {
                "type": "presence",
                "action": event.get("action", "update"),
                "participant": participant,
            }
        )

    async def classroom_notification(self, event: dict) -> None:
        payload = event["payload"]
        # anything that can carry a permission change invalidates the cached
        # answer used by the live lane, so a lock-out is immediate
        event_name = str(payload.get("event") or "")
        if event_name or payload.get("type") == "notification":
            self._invalidate_permissions()
        await self.send_json(payload)
        if payload.get("event") in {
            "removed",
            "left",
            "membership_revoked",
            "classroom_deactivated",
        }:
            await self.close(code=CLOSED_FORBIDDEN)

    # ------------------------------------------------------------------ #
    # Outgoing helpers
    # ------------------------------------------------------------------ #
    async def _broadcast(
        self, op: dict, *, seq: int, event_id: int | None = None, board=None, server_ms: int | None = None
    ) -> None:
        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "whiteboard.operation",
                "op": op,
                "seq": seq,
                "event_id": event_id,
                "ephemeral": False,
                "live": False,
                "actor_identity": self.member.identity,
                "actor_name": self.member.participant_name,
                "board": board,
                # how long the server spent accepting this op — the client
                # reports it in __wb.diag() so a slow server is not mistaken
                # for a slow network
                "server_ms": server_ms,
            },
        )

    async def _relay_ephemeral(self, op: dict) -> None:
        live = bool(op.get("live"))
        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "whiteboard.operation",
                "op": op,
                "seq": self.last_seq,
                "event_id": None,
                "ephemeral": True,
                "live": live,
                "actor_identity": self.member.identity,
                "actor_name": self.member.participant_name,
                # our own channel skips the mirror (see whiteboard_operation)
                "sender": self.channel_name,
            },
        )

    async def _broadcast_presence(self, action: str) -> None:
        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "board.presence",
                "action": action,
                "participant": {
                    "identity": self.member.identity,
                    "member_id": self.member.id,
                    "name": self.member.participant_name,
                    "can_draw": bool(self.can_draw),
                    "role": self.member.role,
                    "is_guest": bool(self.member.is_guest),
                },
            },
        )

    async def _error(self, message: str, code: str = "", ops: list | None = None) -> None:
        payload = {"type": "error", "message": message}
        if code:
            payload["code"] = code
        if ops:
            payload["ops"] = [op for op in ops if op]
        await self.send_json(payload)

    @staticmethod
    def _meta_for(op: dict, board_state: dict) -> dict:
        if op.get("type") in {"page_add", "page_dup", "page_remove", "page_setup"}:
            return board_state
        return {"page_count": board_state["page_count"]}

    # ------------------------------------------------------------------ #
    # Hot-path helpers
    # ------------------------------------------------------------------ #
    async def _cached_permissions(self) -> tuple[bool, bool]:
        """``(is_active, can_draw)`` without hitting the database every frame.

        The answer is reused for :data:`PERMISSION_TTL` seconds and dropped the
        moment the member is notified about a permission change, so live
        traffic (cursors, in-progress strokes) costs no queries while a
        revocation still lands within a frame or two.
        """
        now = time.monotonic()
        if now - self._perm_checked_at > PERMISSION_TTL:
            result = await self._membership_now()
            if result is None:
                return False, False
            self._member_is_active, self._perm_can_draw = result
            self._perm_checked_at = now
        return self._member_is_active, self._perm_can_draw

    def _invalidate_permissions(self) -> None:
        self._perm_checked_at = 0.0

    def _log_slow_frame(self, started: float, count: int, kind: str) -> None:
        elapsed = (time.monotonic() - started) * 1000
        if elapsed >= SLOW_FRAME_MS:
            logger.warning(
                "whiteboard_slow_frame room=%s kind=%s ops=%d ms=%.0f",
                self.room_code, kind, count, elapsed,
            )

    # ------------------------------------------------------------------ #
    # Database helpers (all synchronous work lives in whiteboard.services)
    # ------------------------------------------------------------------ #
    @database_sync_to_async
    def _load_membership(self):
        return resolve_scope_member(self.scope, self.room_code)

    @database_sync_to_async
    def _load_snapshot(self, since: int) -> dict | None:
        member = services.active_member(self.member.id)
        if member is None or member.classroom_id != getattr(self.classroom, "id", None):
            return None
        perms = services.board_permissions(member)
        payload = services.board_snapshot(member.classroom, since=since, member=member)
        payload["you"] = {
            "identity": member.identity,
            "member_id": member.id,
            "name": member.participant_name,
            "role": member.role,
            "is_guest": bool(member.is_guest),
            "can_draw": perms["can_draw"],
            "can_present": perms["can_present"],
        }
        layer = get_channel_layer()
        payload["limits"] = {
            "max_op_bytes": MAX_OP_BYTES,
            "max_points": MAX_POINTS,
            "batch": MAX_BATCH_OPS,
            # Which broadcast layer the server is running on.  An in-memory
            # layer only reaches sockets inside this very process, so with more
            # than one worker the class sees one another's strokes late or not
            # at all — the client shows a hint instead of pretending.
            "layer": "redis" if layer and "Redis" in type(layer).__name__ else (
                "memory" if layer else "none"
            ),
        }
        return payload

    @database_sync_to_async
    def _membership_now(self) -> tuple[bool, bool] | None:
        """One query for both answers the hot path needs."""
        member = services.active_member(self.member.id)
        if member is None:
            return None
        return True, bool(services.board_permissions(member)["can_draw"])

    @database_sync_to_async
    def _member_active_now(self) -> bool:
        return services.active_member(self.member.id) is not None

    @database_sync_to_async
    def _can_draw_now(self) -> bool:
        member = services.active_member(self.member.id)
        return bool(member and services.board_permissions(member)["can_draw"])

    async def _refresh_permissions(self) -> None:
        self.can_draw = await self._can_draw_now()
        self._perm_can_draw = self.can_draw
        self._perm_checked_at = time.monotonic()

    @database_sync_to_async
    def _persist(self, ops: list[dict]):
        member = services.active_member(self.member.id)
        if member is None:
            return None
        return services.persist_ops(member, ops)

    @database_sync_to_async
    def _store_snapshot(self, seq: int, ops) -> str | None:
        member = services.active_member(self.member.id)
        if member is None:
            return "forbidden"
        return services.store_snapshot(member, seq, ops)

    # ------------------------------------------------------------------ #
    # Query string helpers
    # ------------------------------------------------------------------ #
    def _query(self, key: str) -> str:
        raw = (self.scope.get("query_string") or b"").decode("latin-1")
        values = parse_qs(raw, keep_blank_values=False).get(key) or []
        return values[0] if values else ""

    def _query_int(self, key: str) -> int:
        return self._as_int(self._query(key), 0)

    @staticmethod
    def _as_int(value, default: int) -> int:
        try:
            if value is None:
                return default
            return int(value)
        except (TypeError, ValueError):
            return default
