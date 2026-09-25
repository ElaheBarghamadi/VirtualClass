"""WebSocket consumer for classroom chat.

Endpoint: ``/ws/classroom/<room_code>/chat/``

Flow:  browser WebSocket → Channels → this consumer → DB + group broadcast.

Authorization notes
-------------------
* membership + ``can_send_messages`` are re-evaluated **per message**
  against the database — classroom settings (e.g. ``chat_disabled``) or
  per-member flags changed mid-session take effect immediately;
* ``delete_message`` is restricted to OWNER/MODERATOR and soft-deletes;
* a modified client script can never grant extra rights.
"""
from __future__ import annotations

import logging

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from classrooms.models import Classroom, ClassroomMember
from classrooms.permissions import effective_permissions, is_privileged
from classrooms.services import resolve_scope_member
from classrooms.ws_security import RateLimiter, ws_origin_allowed

from .models import ChatMessage

logger = logging.getLogger(__name__)

HISTORY_LIMIT = 100
MAX_MESSAGE_LENGTH = 1000
SEND_RATE_LIMIT = 10  # messages per second per connection


class ChatConsumer(AsyncJsonWebsocketConsumer):
    """Real-time classroom chat with persistent history and moderation."""

    async def connect(self) -> None:
        self.room_code: str = self.scope["url_route"]["kwargs"]["room_code"]
        self.group_name = f"classroom_chat_{self.room_code}"
        self.classroom = None
        self.member = None
        self.user = self.scope.get("user")
        self.authenticated = bool(self.user is not None and getattr(self.user, "is_authenticated", False))

        # CSWSH defence — see classrooms.ws_security.
        if not ws_origin_allowed(self.scope):
            logger.warning("ws_origin_rejected room=%s", self.room_code)
            await self.close(code=4403)
            return
        self._limiter = RateLimiter(SEND_RATE_LIMIT)

        self.classroom, self.member = await self._load_membership()
        if self.member is None:
            await self.close(code=4401 if not getattr(self.user, "is_authenticated", False) and not self.scope.get("session") else 4403)
            return
        if self.member.in_waiting_room:
            await self.close(code=4403)
            return

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        await self.send_json({"type": "chat_history", "messages": await self._load_history()})

    async def disconnect(self, code: int) -> None:
        if getattr(self, "member", None) is not None:
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content: dict, **kwargs) -> None:
        action = content.get("action")

        if action == "send_message":
            limiter = getattr(self, "_limiter", None)
            if limiter is not None and not limiter.allow():
                await self.send_json({"type": "error", "message": "آهسته‌تر پیام بفرستید."})
                return
            await self._handle_send(content)
        elif action == "delete_message":
            await self._handle_delete(content)
        else:
            logger.info("Ignoring unknown chat action: %r", action)

    # ------------------------------------------------------------------
    async def _handle_send(self, content: dict) -> None:
        # Re-check permissions live: settings may have changed mid-session.
        allowed = await self._can_send_now()
        if not allowed:
            await self.send_json({"type": "error", "message": "شما اجازهٔ ارسال پیام ندارید."})
            return

        message = str(content.get("message", "")).strip()
        if not message:
            return
        message = message[:MAX_MESSAGE_LENGTH]

        payload = await self._save_message(message)
        await self.channel_layer.group_send(
            self.group_name, {"type": "chat.message", "message": payload}
        )

    async def _handle_delete(self, content: dict) -> None:
        privileged = await self._is_privileged_now()
        if not privileged:
            await self.send_json({"type": "error", "message": "فقط مدیر می‌تواند پیام حذف کند."})
            return
        try:
            message_id = int(content.get("message_id"))
        except (TypeError, ValueError):
            return
        deleted = await self._soft_delete(message_id)
        if deleted:
            await self.channel_layer.group_send(
                self.group_name, {"type": "chat.deleted", "message_id": message_id}
            )
            logger.info("chat_message_deleted", extra={"room_code": self.room_code, "message_id": message_id})

    # -- group handlers --------------------------------------------------
    async def chat_message(self, event: dict) -> None:
        await self.send_json({"type": "chat_message", "message": event["message"]})

    async def chat_deleted(self, event: dict) -> None:
        await self.send_json({"type": "chat_deleted", "message_id": event["message_id"]})

    # -- helpers -----------------------------------------------------------
    @database_sync_to_async
    def _load_membership(self):
        return resolve_scope_member(self.scope, self.room_code)

    @database_sync_to_async
    def _can_send_now(self) -> bool:
        # Single query: the member row + its classroom in one round trip.
        member = (
            ClassroomMember.objects.filter(id=self.member.id)
            .select_related("classroom", "user")
            .first()
        )
        if member is None:
            return False
        return effective_permissions(member, member.classroom)["can_send_messages"]

    @database_sync_to_async
    def _is_privileged_now(self) -> bool:
        member = ClassroomMember.objects.filter(id=self.member.id).first()
        return is_privileged(member)

    @database_sync_to_async
    def _load_history(self) -> list[dict]:
        qs = ChatMessage.objects.filter(classroom=self.classroom).select_related("sender")
        return [m.to_dict() for m in list(qs.order_by("-created_at")[:HISTORY_LIMIT])[::-1]]

    @database_sync_to_async
    def _save_message(self, message: str) -> dict:
        member = ClassroomMember.objects.filter(id=self.member.id).select_related("user").first()
        return ChatMessage.objects.create(
            classroom=self.classroom,
            sender=member.user if member and member.user_id else None,
            sender_member=member,
            sender_name=(member.participant_name if member else "")[:80],
            sender_identity=(member.identity if member else "")[:48],
            message=message,
        ).to_dict()

    @database_sync_to_async
    def _soft_delete(self, message_id: int) -> bool:
        return ChatMessage.objects.filter(
            id=message_id, classroom=self.classroom
        ).update(is_deleted=True) > 0
