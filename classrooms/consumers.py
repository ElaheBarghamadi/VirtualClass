"""WebSocket consumer for classroom presence, events and notifications.

Endpoint: ``/ws/classroom/<room_code>/``

Protocol (server → client)
--------------------------
* ``participant_list``      full snapshot (sent on connect / reconnect)
* ``user_joined`` / ``user_left``
* ``raise_hand`` / ``lower_hand``
* ``notification``          targeted (per-user) message
* ``permission_changed`` / ``role_changed`` / ``participant_muted`` /
  ``mute_all`` / ``participant_removed`` / ``settings_changed`` /
  ``classroom_locked`` / ``classroom_unlocked`` / ``session_started`` /
  ``session_ended`` / ``presentation_changed``
  (all relayed verbatim from :mod:`classrooms.services` broadcasts)

Protocol (client → server)
--------------------------
* ``{"action": "raise_hand", "raised": true|false}``
* ``{"action": "media_state", "mic_on": bool, "camera_on": bool,
     "screen_sharing": bool}``  (cosmetic presence info for the roster)
* ``{"action": "ping"}``

Media (audio/video/screen) never travels through this socket — it is
transported by WebRTC via the LiveKit SFU.  Reconnection is handled by
the client simply reconnecting; the server re-sends a fresh snapshot,
so state restores automatically.
"""
from __future__ import annotations

import json
import logging

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer

from .models import Classroom, ClassroomMember

RTC_SIGNAL_MAX_BYTES = 16 * 1024  # hard cap on relayed SDP/ICE envelopes
from .services import (
    attendance_join,
    attendance_leave,
    member_group,
    participant_payload,
    resolve_scope_member,
    set_hand_raised,
)

logger = logging.getLogger(__name__)


class ClassroomConsumer(AsyncJsonWebsocketConsumer):
    """Presence + event consumer for a single classroom."""

    async def connect(self) -> None:
        self.room_code: str = self.scope["url_route"]["kwargs"]["room_code"]
        self.group_name = f"classroom_{self.room_code}"
        self.member = None
        self.classroom = None
        self.user = self.scope.get("user")

        # Server-side authorisation: only active members (registered or
        # session-bound guests) may connect.
        self.classroom, self.member = await self._load_membership()
        if self.member is None:
            code = 4403
            if self.user is None or not getattr(self.user, "is_authenticated", False):
                code = 4401 if not self.scope.get("session") else 4403
            await self.close(code=code)
            return
        # Waiting-room members get a restricted connection: their personal
        # notification group ONLY (so the waiting page can receive the
        # approve/deny notification).  They never join the room group, so
        # they see no roster and nobody sees them until admission.
        self.waiting = bool(self.member.in_waiting_room)
        if self.waiting:
            await self.channel_layer.group_add(member_group(self.room_code, self.member.id), self.channel_name)
            await self.accept()
            return

        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.channel_layer.group_add(member_group(self.room_code, self.member.id), self.channel_name)
        await self.accept()

        await self._start_attendance()

        # Cache the public payload once: identity/name never change during a
        # connection, so join and leave broadcasts need no extra queries.
        self._payload_cache = await self._self_payload()

        # Fresh snapshot first (makes reconnection seamless), then the
        # join broadcast for everybody — including this client.
        participants, classroom_state = await self._snapshot()
        await self.send_json({
            "type": "participant_list",
            "participants": participants,
            "classroom": classroom_state,
        })
        await self.channel_layer.group_send(
            self.group_name,
            {"type": "presence.user_joined", "participant": self._payload_cache},
        )

    async def disconnect(self, code: int) -> None:
        if getattr(self, "member", None) is None:
            return
        if getattr(self, "waiting", False):
            # Restricted waiting-room connection: personal group only.
            await self.channel_layer.group_discard(member_group(self.room_code, self.member.id), self.channel_name)
            return
        await self._stop_attendance()
        await self.channel_layer.group_send(
            self.group_name,
            {"type": "presence.user_left",
             "participant": getattr(self, "_payload_cache", None) or await self._self_payload()},
        )
        await self.channel_layer.group_discard(self.group_name, self.channel_name)
        await self.channel_layer.group_discard(member_group(self.room_code, self.member.id), self.channel_name)

    # ------------------------------------------------------------------
    # Client → server
    # ------------------------------------------------------------------
    async def receive_json(self, content: dict, **kwargs) -> None:
        action = content.get("action")

        if getattr(self, "waiting", False):
            # Not admitted yet — only keep-alive is accepted.
            if action == "ping":
                await self.send_json({"type": "pong"})
            return

        if action == "raise_hand":
            perms = await self._effective_permissions()
            if not perms.get("can_raise_hand"):
                await self.send_json({"type": "error", "message": "اجازهٔ بالا بردن دست ندارید."})
                return
            raised = bool(content.get("raised"))
            await self._set_hand_raised(raised)
            return

        if action == "media_state":
            # Cosmetic roster state for THIS user only (never trusted for
            # authorisation — real media rights come from the SFU token).
            payload = await self._self_payload()
            payload.update({
                "mic_on": bool(content.get("mic_on")),
                "camera_on": bool(content.get("camera_on")),
                "screen_sharing": bool(content.get("screen_sharing")),
            })
            await self.channel_layer.group_send(
                self.group_name, {"type": "presence.media_state", "participant": payload}
            )
            return

        if action == "rtc_signal":
            # WebRTC signalling relay (mesh fallback): SDP/ICE envelopes are
            # forwarded to ONE active member of THIS classroom, untouched
            # except a hard size cap.  The server never parses the media
            # payloads and clients can only reach real classmates.
            data = content.get("data")
            to_member_id = content.get("to_member_id")
            if not isinstance(data, dict) or not isinstance(to_member_id, int):
                return
            if len(json.dumps(data)) > RTC_SIGNAL_MAX_BYTES:
                return
            await self._relay_rtc_signal(to_member_id, data)
            return

        if action == "whiteboard_state":
            perms = await self._effective_permissions()
            if not perms.get("can_use_whiteboard"):
                await self.send_json({"type": "error", "message": "اجازهٔ استفاده از تخته را ندارید."})
                return
            opened = bool(content.get("open"))
            await self._set_whiteboard_open(opened)
            return

        if action == "ping":
            await self.send_json({"type": "pong"})
            return

        logger.info("Ignoring unknown classroom action: %r", action)

    # ------------------------------------------------------------------
    # Group event handlers
    # ------------------------------------------------------------------
    async def presence_user_joined(self, event: dict) -> None:
        await self.send_json({"type": "user_joined", "participant": event["participant"]})

    async def presence_user_left(self, event: dict) -> None:
        await self.send_json({"type": "user_left", "participant": event["participant"]})

    async def presence_media_state(self, event: dict) -> None:
        await self.send_json({"type": "media_state", "participant": event["participant"]})

    async def classroom_event(self, event: dict) -> None:
        """Relay a services-layer broadcast verbatim to the client."""
        await self.send_json(event["payload"])

    async def classroom_notification(self, event: dict) -> None:
        """Relay a targeted notification to one participant."""
        await self.send_json(event["payload"])

    # ------------------------------------------------------------------
    # DB helpers (all ORM access wrapped in sync contexts)
    # ------------------------------------------------------------------
    @database_sync_to_async
    def _load_membership(self):
        return resolve_scope_member(self.scope, self.room_code)

    @database_sync_to_async
    def _snapshot(self) -> tuple[list[dict], dict]:
        """Participants + classroom state in ONE database round trip.

        Hosts/moderators also receive waiting-room members so a page
        refresh restores the pending list; regular members never see it.
        """
        from .permissions import is_privileged

        classroom = (
            Classroom.objects.select_related("current_file")
            .filter(room_code=self.room_code)
            .first()
        )
        if classroom is None:
            return [], {}
        include_waiting = is_privileged(self.member)
        members = (
            ClassroomMember.objects.filter(classroom=classroom, is_active=True)
            .select_related("user")
            .order_by("role", "joined_at")
        )
        participants = [
            participant_payload(m) for m in members
            if include_waiting or not m.in_waiting_room
        ]
        state = {
            "is_locked": classroom.is_locked,
            "chat_disabled": classroom.chat_disabled,
            "whiteboard_open": classroom.whiteboard_open,
            "current_file_id": classroom.current_file_id,
            "current_file_name": classroom.current_file.original_name if classroom.current_file else None,
            "current_page": classroom.current_page,
        }
        return participants, state

    @database_sync_to_async
    def _self_payload(self) -> dict:
        member = ClassroomMember.objects.filter(id=self.member.id).select_related("user").first()
        return participant_payload(member) if member else {"identity": "", "name": ""}

    @database_sync_to_async
    def _effective_permissions(self) -> dict:
        from .permissions import effective_permissions

        # Single query: member + classroom together (live values).
        member = (
            ClassroomMember.objects.filter(id=self.member.id)
            .select_related("classroom", "user")
            .first()
        )
        if member is None:
            return {}
        return effective_permissions(member, member.classroom)

    @database_sync_to_async
    def _set_hand_raised(self, raised: bool) -> None:
        set_hand_raised(self.classroom, self.member, raised)

    @database_sync_to_async
    def _relay_rtc_signal(self, to_member_id: int, data: dict) -> None:
        """Deliver a signalling envelope to one active classmate."""
        from .services import notify_member

        target = ClassroomMember.objects.filter(
            classroom=self.classroom, id=to_member_id, is_active=True, in_waiting_room=False
        ).first()
        if target is None or target.id == self.member.id:
            return
        notify_member(self.room_code, target, {
            "type": "rtc_signal",
            "from_identity": self.member.identity,
            "from_member_id": self.member.id,
            "data": data,
        })

    @database_sync_to_async
    def _set_whiteboard_open(self, opened: bool) -> None:
        from .services import broadcast

        Classroom.objects.filter(room_code=self.room_code).update(whiteboard_open=opened)
        broadcast(self.room_code, {
            "type": "whiteboard_state",
            "open": opened,
            "by": self.member.participant_name,
        })

    @database_sync_to_async
    def _start_attendance(self) -> None:
        member = ClassroomMember.objects.filter(id=self.member.id).first()
        if member and not member.in_waiting_room:
            attendance_join(self.classroom, member)

    @database_sync_to_async
    def _stop_attendance(self) -> None:
        member = ClassroomMember.objects.filter(id=self.member.id).first()
        attendance_leave(self.classroom, member)
