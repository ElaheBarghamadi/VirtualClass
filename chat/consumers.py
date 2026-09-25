"""WebSocket consumer for classroom chat.

Endpoint: ``/ws/classroom/<room_code>/chat/``

Flow:  browser WebSocket → Channels → this consumer → DB + group broadcast.

Permissions (e.g. ``can_send_messages``) are enforced **server-side**
against the member's stored capabilities — a modified client script can
never grant extra rights.
"""
from __future__ import annotations

import logging

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from classrooms.models import Classroom
from classrooms.permissions import member_can
from classrooms.services import get_active_member

from .models import ChatMessage

logger = logging.getLogger(__name__)

HISTORY_LIMIT = 50
MAX_MESSAGE_LENGTH = 1000


class ChatConsumer(AsyncJsonWebsocketConsumer):
    """Real-time classroom chat with persistent history."""

    async def connect(self) -> None:
        self.room_code: str = self.scope["url_route"]["kwargs"]["room_code"]
        self.group_name = f"classroom_chat_{self.room_code}"
        self.classroom = None
        self.member = None
        self.user = self.scope.get("user")

        if self.user is None or not self.user.is_authenticated:
            await self.close(code=4401)
            return

        self.classroom, self.member = await self._load_membership()
        if self.member is None:
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
        if action != "send_message":
            logger.info("Ignoring unknown chat action: %r", action)
            return

        # Server-side capability check — never trust the client.
        if not member_can(self.member, "can_send_messages"):
            await self.send_json({"type": "error", "message": "شما اجازه ارسال پیام ندارید."})
            return

        message = str(content.get("message", "")).strip()
        if not message:
            return
        message = message[:MAX_MESSAGE_LENGTH]

        payload = await self._save_message(message)
        await self.channel_layer.group_send(
            self.group_name, {"type": "chat.message", "message": payload}
        )

    # -- group handlers ---------------------------------------------------------
    async def chat_message(self, event: dict) -> None:
        await self.send_json({"type": "chat_message", "message": event["message"]})

    # -- helpers ------------------------------------------------------------------
    @database_sync_to_async
    def _load_membership(self):
        classroom = Classroom.objects.filter(room_code=self.room_code, is_active=True).first()
        if classroom is None:
            return None, None
        return classroom, get_active_member(classroom, self.user)

    @database_sync_to_async
    def _load_history(self) -> list[dict]:
        qs = ChatMessage.objects.filter(classroom=self.classroom).select_related("sender")
        return [m.to_dict() for m in list(qs.order_by("-created_at")[:HISTORY_LIMIT])[::-1]]

    @database_sync_to_async
    def _save_message(self, message: str) -> dict:
        return ChatMessage.objects.create(
            classroom=self.classroom, sender=self.user, message=message
        ).to_dict()
