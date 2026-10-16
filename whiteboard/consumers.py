"""WebSocket consumer for the collaborative whiteboard.

Endpoint: ``/ws/classroom/<room_code>/whiteboard/``

Protocol
--------
client → server:  ``{"action": "op", "op": {...}}`` where ``op`` is a
    structured drawing operation (never a canvas image):
    ``{"type": "draw", "tool": "pen", "points": [...], "color": ...,
       "width": ..., "id": ...}``
    ``{"type": "text", "x":.., "y":.., "text":.., ...}``
    ``{"type": "remove", "id": ...}``
    ``{"type": "clear"}``

server → client:  ``whiteboard_history`` (on connect), then one
    ``whiteboard_operation`` per accepted operation.

Authorization: only active members with effective ``can_use_whiteboard``
may mutate the board (re-checked per operation).  ``clear`` additionally
requires the operation to pass the same permission check; history is
compacted server-side on clear.
"""
from __future__ import annotations

import json
import logging
import math
import re

from channels.db import database_sync_to_async
from django.db import transaction

from classrooms.models import ClassroomMember
from classrooms.permissions import effective_permissions
from classrooms.services import member_group, resolve_scope_member
from classrooms.ws_security import RateLimiter, SafeJsonWebsocketConsumer, ws_origin_allowed

from .models import Whiteboard, WhiteboardEvent

logger = logging.getLogger(__name__)

MAX_OP_BYTES = 64 * 1024
OP_RATE_LIMIT = 40  # ops per second per connection (lasers included)
HISTORY_LIMIT = 2000
VALID_OP_TYPES = {"draw", "text", "remove", "clear", "page_add", "page_setup", "page_go", "laser"}
# Laser pointers are ephemeral: relayed to the group, never persisted.
EPHEMERAL_OP_TYPES = {"laser"}
VALID_GRIDS = {"none", "grid", "dots"}
VALID_TOOLS = {"pen", "highlighter", "eraser", "line", "arrow", "rectangle", "circle"}


class WhiteboardConsumer(SafeJsonWebsocketConsumer):
    """Relay + persistence for structured whiteboard operations."""

    max_message_bytes = 128 * 1024

    async def connect(self) -> None:
        self.room_code: str = self.scope["url_route"]["kwargs"]["room_code"]
        self.group_name = f"classroom_wb_{self.room_code}"
        self.classroom = None
        self.member = None
        self.user = self.scope.get("user")
        self.authenticated = bool(self.user is not None and getattr(self.user, "is_authenticated", False))

        # CSWSH defence — see classrooms.ws_security.
        if not ws_origin_allowed(self.scope):
            logger.warning("ws_origin_rejected room=%s", self.room_code)
            await self.close(code=4403)
            return
        self._limiter = RateLimiter(OP_RATE_LIMIT)

        self.classroom, self.member = await self._load_membership()
        if self.member is None:
            await self.close(code=4401 if not getattr(self.user, "is_authenticated", False) and not self.scope.get("session") else 4403)
            return
        if self.member.in_waiting_room:
            await self.close(code=4403)
            return

        self.member_group_name = member_group(self.room_code, self.member.id)
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.channel_layer.group_add(self.member_group_name, self.channel_name)
        await self.accept()

        # Snapshot first, then live operations.  ``seq`` lets the client
        # discard anything already contained in the snapshot.
        history, seq = await self._load_history()
        self.last_seq = seq
        await self.send_json({"type": "whiteboard_history", "events": history, "seq": seq})

    async def disconnect(self, code: int) -> None:
        if getattr(self, "member", None) is not None:
            await self.channel_layer.group_discard(self.group_name, self.channel_name)
            await self.channel_layer.group_discard(
                getattr(self, "member_group_name", member_group(self.room_code, self.member.id)),
                self.channel_name,
            )

    async def receive_json(self, content: dict, **kwargs) -> None:
        if content.get("action") != "op":
            return
        if not await self._member_active_now():
            await self.close(code=4403)
            return

        limiter = getattr(self, "_limiter", None)
        if limiter is not None and not limiter.allow():
            logger.info("whiteboard_rate_limited room=%s", self.room_code)
            return

        op = content.get("op")
        if not self._valid_op(op):
            await self.send_json({"type": "error", "message": "عملیات تخته نامعتبر است."})
            return

        # Permission re-checked live — settings can change mid-session.
        if not await self._can_draw_now():
            await self.send_json({"type": "error", "message": "شما اجازهٔ استفاده از تخته را ندارید."})
            return

        if op.get("type") in EPHEMERAL_OP_TYPES:
            # Fire-and-forget relay: no DB write, no seq movement.
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "whiteboard.operation",
                    "op": {**op, "page": self._normalise_page(op)},
                    "seq": getattr(self, "last_seq", 0),
                    "ephemeral": True,
                    "actor_identity": self.member.identity,
                    "actor_name": self.member.participant_name,
                },
            )
            return

        persisted = await self._persist(op)
        if persisted is None:
            await self.send_json({"type": "error", "message": "شما اجازهٔ استفاده از تخته را ندارید."})
            return
        op, seq = persisted
        self.last_seq = seq
        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "whiteboard.operation",
                "op": op,
                "seq": seq,
                "actor_identity": self.member.identity,
                "actor_name": self.member.participant_name,
            },
        )

    # -- group handler -------------------------------------------------------
    async def whiteboard_operation(self, event: dict) -> None:
        # Guard against the snapshot/operation race on (re)connect.
        # Ephemeral ops (laser) carry no seq and skip the guard.
        if not event.get("ephemeral"):
            if event.get("seq", 0) <= getattr(self, "last_seq", 0):
                return
            self.last_seq = event["seq"]
        await self.send_json({
            "type": "whiteboard_operation",
            "op": event["op"],
            "seq": event["seq"],
            "ephemeral": bool(event.get("ephemeral")),
            "actor_identity": event.get("actor_identity", ""),
            "actor_name": event.get("actor_name", ""),
        })

    async def classroom_notification(self, event: dict) -> None:
        payload = event["payload"]
        await self.send_json(payload)
        if payload.get("event") in {"removed", "left", "membership_revoked", "classroom_deactivated"}:
            await self.close(code=4403)

    # -- validation -------------------------------------------------------------
    @staticmethod
    def _normalise_page(op) -> int:
        """Clamp a validated page number (1..999, default 1)."""
        page = op.get("page", 1)
        return max(1, min(999, page)) if isinstance(page, int) and not isinstance(page, bool) else 1

    @staticmethod
    def _finite_number(value, *, normalized: bool = False) -> bool:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        limit = 2 if normalized else 1_000_000
        if isinstance(value, int):
            return -limit <= value <= limit
        return math.isfinite(value) and -limit <= value <= limit

    @staticmethod
    def _valid_color(value) -> bool:
        return isinstance(value, str) and re.fullmatch(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})", value) is not None

    @classmethod
    def _valid_op(cls, op) -> bool:
        if not isinstance(op, dict) or not isinstance(op.get("type"), str) or op["type"] not in VALID_OP_TYPES:
            return False
        try:
            encoded = json.dumps(op, allow_nan=False, separators=(",", ":")).encode("utf-8")
            if len(encoded) > MAX_OP_BYTES:
                return False
        except (TypeError, ValueError, UnicodeError, RecursionError):
            return False

        if "id" in op and (
            not isinstance(op["id"], str) or not op["id"] or len(op["id"]) > 128
        ):
            return False
        if "page" in op and (
            isinstance(op["page"], bool)
            or not isinstance(op["page"], int)
            or not 1 <= op["page"] <= 999
        ):
            return False
        if "file_id" in op and (
            isinstance(op["file_id"], bool)
            or not isinstance(op["file_id"], int)
            or op["file_id"] <= 0
        ):
            return False

        normalized = op.get("norm", False)
        if type(normalized) is bool:
            normalized = normalized
        elif type(normalized) is int and normalized in (0, 1):
            normalized = bool(normalized)
        else:
            return False

        if "color" in op and op["color"] is not None and not cls._valid_color(op["color"]):
            return False
        if "width" in op and (
            not cls._finite_number(op["width"])
            or not 0 < op["width"] <= 512
        ):
            return False

        op_type = op["type"]
        if op_type == "draw":
            tool = op.get("tool")
            if not isinstance(tool, str) or tool not in VALID_TOOLS:
                return False
            if tool in {"rectangle", "circle"}:
                if not cls._finite_number(op.get("left"), normalized=normalized):
                    return False
                if not cls._finite_number(op.get("top"), normalized=normalized):
                    return False
                if tool == "rectangle":
                    w = op.get("w", op.get("width"))
                    h = op.get("h", op.get("height"))
                    if not cls._finite_number(w, normalized=normalized) or w < 0:
                        return False
                    if not cls._finite_number(h, normalized=normalized) or h < 0:
                        return False
                else:
                    rx, ry = op.get("rx"), op.get("ry")
                    if not cls._finite_number(rx, normalized=normalized) or rx < 0:
                        return False
                    if not cls._finite_number(ry, normalized=normalized) or ry < 0:
                        return False
            else:
                points = op.get("points")
                if not isinstance(points, list) or not 2 <= len(points) <= 4096:
                    return False
                for point in points:
                    if (
                        not isinstance(point, (list, tuple)) or len(point) != 2
                        or not all(cls._finite_number(v, normalized=normalized) for v in point)
                    ):
                        return False

        elif op_type == "text":
            text = op.get("text")
            if not isinstance(text, str) or len(text) > 500:
                return False
            if not cls._finite_number(op.get("x"), normalized=normalized):
                return False
            if not cls._finite_number(op.get("y"), normalized=normalized):
                return False
            if "size" in op and (
                not cls._finite_number(op["size"])
                or not 1 <= op["size"] <= 1000
            ):
                return False

        elif op_type == "remove":
            if not isinstance(op.get("id"), str) or not op["id"]:
                return False

        elif op_type == "page_add":
            page = op.get("page")
            if isinstance(page, bool) or not isinstance(page, int) or not 2 <= page <= 999:
                return False

        elif op_type == "page_setup":
            color, grid = op.get("color"), op.get("grid")
            if color is None and grid is None:
                return False
            if color is not None and not cls._valid_color(color):
                return False
            if grid is not None and (not isinstance(grid, str) or grid not in VALID_GRIDS):
                return False

        elif op_type == "page_go":
            page = op.get("page")
            if isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= 999:
                return False

        elif op_type == "laser":
            if not cls._finite_number(op.get("x"), normalized=normalized):
                return False
            if not cls._finite_number(op.get("y"), normalized=normalized):
                return False

        return True

    # -- DB helpers ---------------------------------------------------------------
    @database_sync_to_async
    def _load_membership(self):
        return resolve_scope_member(self.scope, self.room_code)

    @database_sync_to_async
    def _member_active_now(self) -> bool:
        return ClassroomMember.objects.filter(
            id=self.member.id, is_active=True, in_waiting_room=False,
            classroom__is_active=True,
        ).exists()

    @database_sync_to_async
    def _can_draw_now(self) -> bool:
        # Single query: the member row + its classroom in one round trip.
        member = (
            ClassroomMember.objects.filter(
                id=self.member.id, is_active=True, in_waiting_room=False,
                classroom__is_active=True,
            )
            .select_related("classroom", "user")
            .first()
        )
        if member is None:
            return False
        return effective_permissions(member, member.classroom)["can_use_whiteboard"]

    @database_sync_to_async
    def _load_history(self) -> tuple[list[dict], int]:
        """Return replayable operations plus the sequence watermark."""
        board, _ = Whiteboard.objects.get_or_create(classroom=self.classroom)
        # Keep the newest tail, then restore chronological order for replay.
        events = list(
            board.events.select_related("actor").order_by("-id")[:HISTORY_LIMIT]
        )[::-1]
        history = [
            {
                "id": e.id,
                "op": e.operation,
                "actor_identity": e.actor_identity,
                "actor_name": e.actor.name if e.actor else None,
            }
            for e in events
        ]
        seq = events[-1].id if events else 0
        return history, seq

    @database_sync_to_async
    def _persist(self, op: dict) -> tuple[dict, int] | None:
        # Re-check inside the persistence transaction as a permission grant
        # can be revoked between the async preflight and this DB write.
        with transaction.atomic():
            member = (
                ClassroomMember.objects.select_for_update(of=("self",))
                .filter(
                    id=self.member.id, is_active=True, in_waiting_room=False,
                    classroom__is_active=True,
                )
                .select_related("classroom", "user")
                .first()
            )
            if member is None or not effective_permissions(member, member.classroom)["can_use_whiteboard"]:
                return None

            board, _ = Whiteboard.objects.get_or_create(classroom=member.classroom)
            page = self._normalise_page(op)
            op = {**op, "page": page}
            if op.get("type") == "clear":
                # Compaction: a clear invalidates prior ops on THIS page and
                # file scope only. Page markers remain replayable.
                qs = board.events.filter(page=page)
                if op.get("file_id"):
                    qs = qs.filter(operation__file_id=op["file_id"])
                else:
                    qs = qs.filter(operation__file_id__isnull=True)
                qs.exclude(operation__type__in=["page_add", "page_setup"]).delete()
            event = WhiteboardEvent.objects.create(
                whiteboard=board,
                actor=member.user if member.user_id else None,
                actor_identity=member.identity[:48],
                operation=op,
                page=page,
            )
            board.save(update_fields=["updated_at"])
            op = dict(op)
            op["event_id"] = event.id
            return op, event.id
