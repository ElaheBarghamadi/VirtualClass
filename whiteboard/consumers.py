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
import re

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from classrooms.models import Classroom, ClassroomMember
from classrooms.permissions import effective_permissions
from classrooms.services import resolve_scope_member

from .models import Whiteboard, WhiteboardEvent

logger = logging.getLogger(__name__)

MAX_OP_BYTES = 64 * 1024
HISTORY_LIMIT = 2000
VALID_OP_TYPES = {"draw", "text", "remove", "clear", "page_add", "page_setup", "page_go", "laser"}
# Laser pointers are ephemeral: relayed to the group, never persisted.
EPHEMERAL_OP_TYPES = {"laser"}
VALID_GRIDS = {"none", "grid", "dots"}
VALID_TOOLS = {"pen", "highlighter", "eraser", "line", "arrow", "rectangle", "circle"}


class WhiteboardConsumer(AsyncJsonWebsocketConsumer):
    """Relay + persistence for structured whiteboard operations."""

    async def connect(self) -> None:
        self.room_code: str = self.scope["url_route"]["kwargs"]["room_code"]
        self.group_name = f"classroom_wb_{self.room_code}"
        self.classroom = None
        self.member = None
        self.user = self.scope.get("user")
        self.authenticated = bool(self.user is not None and getattr(self.user, "is_authenticated", False))

        self.classroom, self.member = await self._load_membership()
        if self.member is None:
            await self.close(code=4401 if not getattr(self.user, "is_authenticated", False) and not self.scope.get("session") else 4403)
            return
        if self.member.in_waiting_room:
            await self.close(code=4403)
            return

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        # Snapshot first, then live operations.  ``seq`` lets the client
        # discard anything already contained in the snapshot.
        history, seq = await self._load_history()
        self.last_seq = seq
        await self.send_json({"type": "whiteboard_history", "events": history, "seq": seq})

    async def disconnect(self, code: int) -> None:
        if getattr(self, "member", None) is not None:
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content: dict, **kwargs) -> None:
        if content.get("action") != "op":
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

        op, seq = await self._persist(op)
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

    # -- validation -------------------------------------------------------------
    @staticmethod
    def _normalise_page(op) -> int:
        """Clamp the page number carried by an op (1..999, default 1)."""
        try:
            page = int(op.get("page", 1))
        except (TypeError, ValueError):
            return 1
        return max(1, min(999, page))

    @classmethod
    def _valid_op(cls, op) -> bool:
        if not isinstance(op, dict) or op.get("type") not in VALID_OP_TYPES:
            return False
        try:
            if len(json.dumps(op, separators=(",", ":"))) > MAX_OP_BYTES:
                return False
        except (TypeError, ValueError):
            return False
        if op["type"] == "draw" and op.get("tool") not in VALID_TOOLS:
            return False
        if op["type"] == "draw" and not isinstance(op.get("points"), list):
            return False
        if op["type"] == "text" and not isinstance(op.get("text"), str):
            return False
        if op["type"] == "text" and len(op.get("text", "")) > 500:
            return False
        if op["type"] == "page_add":
            # page_add must carry the new page number
            if not isinstance(op.get("page"), int) or op["page"] < 2:
                return False
        if op["type"] == "page_setup":
            color, grid = op.get("color"), op.get("grid")
            if color is None and grid is None:
                return False
            if color is not None and not re.fullmatch(r"#[0-9a-fA-F]{6}", str(color)):
                return False
            if grid is not None and grid not in VALID_GRIDS:
                return False
        if op["type"] == "page_go":
            if not isinstance(op.get("page"), int) or op["page"] < 1:
                return False
        if op["type"] == "laser":
            if not isinstance(op.get("x"), (int, float)) or not isinstance(op.get("y"), (int, float)):
                return False
        return True

    # -- DB helpers ---------------------------------------------------------------
    @database_sync_to_async
    def _load_membership(self):
        return resolve_scope_member(self.scope, self.room_code)

    @database_sync_to_async
    def _can_draw_now(self) -> bool:
        # Single query: the member row + its classroom in one round trip.
        member = (
            ClassroomMember.objects.filter(id=self.member.id)
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
        events = list(
            board.events.select_related("actor").order_by("id")[:HISTORY_LIMIT]
        )
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
    def _persist(self, op: dict) -> tuple[dict, int]:
        board, _ = Whiteboard.objects.get_or_create(classroom=self.classroom)
        page = self._normalise_page(op)
        op = {**op, "page": page}
        if op.get("type") == "clear":
            # Compaction: a clear invalidates everything before it on
            # THIS page only — other pages keep their content, and the
            # page_add marker stays so the page itself survives.
            board.events.filter(page=page).exclude(operation__type__in=["page_add", "page_setup"]).delete()
        member = ClassroomMember.objects.filter(id=self.member.id).first()
        event = WhiteboardEvent.objects.create(
            whiteboard=board,
            actor=member.user if member and member.user_id else None,
            actor_identity=(member.identity if member else "")[:48],
            operation=op,
            page=page,
        )
        board.save(update_fields=["updated_at"])
        op = dict(op)
        op["event_id"] = event.id
        return op, event.id
