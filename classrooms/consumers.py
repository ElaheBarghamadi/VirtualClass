"""WebSocket consumer for classroom presence/events.

Endpoint: ``/ws/classroom/<room_code>/``

Handles the connection lifecycle (connect / disconnect / receive) and
broadcasts simple real-time events — currently ``user_joined`` and
``user_left`` plus a full ``participant_list`` snapshot.  Media (audio,
video, screen share) will be transported by WebRTC in a later phase; this
socket only carries lightweight JSON events and future WebRTC signaling.
"""
from __future__ import annotations

import json
import logging

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .models import Classroom, ClassroomMember
from .services import get_active_member

logger = logging.getLogger(__name__)


class ClassroomConsumer(AsyncJsonWebsocketConsumer):
    """Presence consumer: tracks who is currently inside a classroom."""

    async def connect(self) -> None:
        self.room_code: str = self.scope["url_route"]["kwargs"]["room_code"]
        self.group_name = f"classroom_{self.room_code}"
        self.member = None
        self.user = self.scope.get("user")

        if self.user is None or not self.user.is_authenticated:
            await self.close(code=4401)  # unauthorized
            return

        # Server-side authorisation: only active members may connect.
        self.member = await self._load_active_member()
        if self.member is None:
            await self.close(code=4403)  # forbidden
            return

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        # Send the current snapshot to the newly connected client first,
        # then broadcast the join event to everyone (including this client).
        participants = await self._participant_snapshot()
        await self.send_json({"type": "participant_list", "participants": participants})
        await self.channel_layer.group_send(
            self.group_name,
            {
                "type": "presence.user_joined",
                "participant": await self._self_payload(),
            },
        )

    async def disconnect(self, code: int) -> None:
        if getattr(self, "member", None) is not None:
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "presence.user_left",
                    "participant": await self._self_payload(),
                },
            )
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive_json(self, content: dict, **kwargs) -> None:
        """Client → server events.  Media never travels over this socket."""
        action = content.get("action")
        if action == "ping":
            await self.send_json({"type": "pong"})
        else:
            logger.info("Ignoring unknown classroom action: %r", action)

    # -- group event handlers --------------------------------------------------
    async def presence_user_joined(self, event: dict) -> None:
        await self.send_json({"type": "user_joined", "participant": event["participant"]})

    async def presence_user_left(self, event: dict) -> None:
        await self.send_json({"type": "user_left", "participant": event["participant"]})

    # -- helpers ---------------------------------------------------------------
    @database_sync_to_async
    def _load_active_member(self):
        classroom = Classroom.objects.filter(
            room_code=self.room_code, is_active=True
        ).first()
        if classroom is None:
            return None
        return get_active_member(classroom, self.user)

    @database_sync_to_async
    def _participant_snapshot(self) -> list[dict]:
        """Full snapshot.  All ORM access happens inside this sync wrapper."""
        from .services import active_members

        classroom = Classroom.objects.filter(room_code=self.room_code).first()
        if classroom is None:
            return []
        return [self._participant_payload(m) for m in active_members(classroom)]

    @database_sync_to_async
    def _self_payload(self) -> dict:
        """Payload for this connection's own user (refreshed inside sync context)."""
        member = ClassroomMember.objects.filter(
            classroom__room_code=self.room_code, user=self.user
        ).first()
        return self._participant_payload(member)

    @staticmethod
    def _participant_payload(member) -> dict:
        """Public participant data — no sensitive fields are ever exposed."""
        return {
            "user_id": member.user_id,
            "name": member.user.name,
            "role": member.role,
            "role_label": member.get_role_display(),
            # Placeholders for future live media states (updated via events):
            "mic_on": False,
            "camera_on": False,
            "screen_sharing": False,
            "hand_raised": False,
            "muted_by_moderator": False,
        }
