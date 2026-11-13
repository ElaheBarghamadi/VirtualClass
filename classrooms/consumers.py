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

import asyncio
import json
import logging

from django.conf import settings
from channels.db import database_sync_to_async
from channels.layers import get_channel_layer

from .models import Classroom, ClassroomMember
from .ws_security import RateLimiter, SafeJsonWebsocketConsumer, describe_origin, ws_origin_allowed

#: Live caption text is capped and rate-limited (see receive_json).
CAPTION_MAX_CHARS = 200
CAPTION_RATE_LIMIT = 4  # captions per second per connection

#: The only reactions a client may broadcast (validated server-side).
REACTION_KEYS = frozenset({"heart", "clap", "thumbs", "star", "question"})

#: Reaction summary batching.  Reactions stay ephemeral, but every window we
#: post ONE digest line into chat so late joiners/recordings still see the
#: mood.  One group_send per window, zero database writes.
REACTION_SUMMARY_DELAY = 4.0  # seconds per aggregation window
REACTION_SUMMARY_MIN_MEMBERS = 2  # a single reaction is just the bubble
REACTION_SUMMARY_LABELS = {
    "heart": "قلب فرستادند",
    "clap": "تشویق کردند",
    "thumbs": "تأیید کردند",
    "star": "ستاره دادند",
    "question": "گفتند متوجه نشدند",
}
_MAX_SUMMARY_ROOMS = 200  # hard cap on buffered rooms (memory guard)

#: room_code → {"members": {key: set(member_id)}, "task": asyncio.Task | None}
_reaction_windows: dict[str, dict] = {}

#: (room_code, member_id) → the channel names currently open for that member.
#: One person can legitimately hold several sockets (a second tab, a phone, or
#: the new socket of a reconnect arriving before the old one is reaped).  The
#: roster must stay truthful across all of them: «joined» belongs to the first
#: socket and «left» to the last, otherwise closing a spare tab makes a student
#: vanish from everyone's stage while they are still in the room (and splits
#: their attendance into two visits).
_member_channels: dict[tuple[str, int], set[str]] = {}

#: (room_code, member_id) → last media flags that member announced.
#: Media state only ever existed as a live broadcast, so anybody joining later
#: (or reconnecting after a network blip) got a roster without a single
#: ``mic_on``/``camera_on`` flag and — with idle participants hidden from the
#: stage — saw an empty room while the class was in full swing.  Keeping the
#: last announcement makes the snapshot tell the truth; it is dropped as soon
#: as the member's last socket closes, so «camera on» never outlives them.
_media_states: dict[tuple[str, int], dict[str, bool]] = {}

MEDIA_FLAGS = ("mic_on", "camera_on", "screen_sharing")

RTC_SIGNAL_MAX_BYTES = 16 * 1024  # hard cap on relayed SDP/ICE envelopes
RECEIVE_RATE_LIMIT = 20  # client messages per second per connection
from .services import (
    attendance_join,
    attendance_leave,
    member_group,
    participant_payload,
    resolve_scope_member,
    set_hand_raised,
)

logger = logging.getLogger(__name__)


class ClassroomConsumer(SafeJsonWebsocketConsumer):
    """Presence + event consumer for a single classroom."""

    max_message_bytes = 32 * 1024

    async def connect(self) -> None:
        self.room_code: str = self.scope["url_route"]["kwargs"]["room_code"]
        self.group_name = f"classroom_{self.room_code}"
        self.member = None
        self.classroom = None
        self.user = self.scope.get("user")

        # CSWSH defence: a browser handshake from a foreign origin would
        # ride on the victim's cookies — reject it before anything else.
        if not ws_origin_allowed(self.scope):
            logger.warning(
                "ws_origin_rejected room=%s %s",
                self.room_code,
                describe_origin(self.scope),
            )
            await self.close(code=4403)
            return
        self._limiter = RateLimiter(RECEIVE_RATE_LIMIT)
        self._caption_limiter = RateLimiter(CAPTION_RATE_LIMIT)

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

        first_socket = self._register_socket()
        if first_socket:
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
        # A second tab (or a reconnect that beat the old socket's teardown)
        # is the same person: they are already in everybody's roster, and a
        # duplicate «joined» line in chat would be wrong.
        if first_socket:
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
        last_socket = self._unregister_socket()
        if last_socket:
            await self._stop_attendance()
            await self.channel_layer.group_send(
                self.group_name,
                {"type": "presence.user_left",
                 "participant": getattr(self, "_payload_cache", None) or await self._self_payload()},
            )
        await self.channel_layer.group_discard(self.group_name, self.channel_name)
        await self.channel_layer.group_discard(member_group(self.room_code, self.member.id), self.channel_name)

    # ------------------------------------------------------------------
    # Multi-socket bookkeeping (see _member_channels)
    # ------------------------------------------------------------------
    def _register_socket(self) -> bool:
        """Track this socket; True when it is the member's first open one."""
        sockets = _member_channels.setdefault((self.room_code, self.member.id), set())
        sockets.add(self.channel_name)
        return len(sockets) == 1

    def _unregister_socket(self) -> bool:
        """Drop this socket; True when the member has no socket left."""
        key = (self.room_code, self.member.id)
        sockets = _member_channels.get(key)
        if sockets is None:
            return True
        sockets.discard(self.channel_name)
        if sockets:
            return False
        _member_channels.pop(key, None)
        _media_states.pop(key, None)
        return True

    # ------------------------------------------------------------------
    # Client → server
    # ------------------------------------------------------------------
    async def receive_json(self, content: dict, **kwargs) -> None:
        action = content.get("action")

        limiter = getattr(self, "_limiter", None)
        if limiter is not None and not limiter.allow():
            logger.info("rate_limited room=%s action=%r", self.room_code, action)
            return

        if getattr(self, "waiting", False):
            # Not admitted yet — only keep-alive is accepted.
            if action == "ping":
                await self.send_json({"type": "pong"})
            return

        if action in ("raise_hand", "media_state", "rtc_signal", "whiteboard_state",
                      "whiteboard_size", "reaction", "caption"):
            if not await self._member_active_now():
                await self.close(code=4403)
                return

        if action == "reaction":
            # Ephemeral by design: reactions are never stored, they only
            # animate everyone's screen for a couple of seconds.  They are a
            # voice signal like a raised hand, so they ride the same grant: a
            # view-only member sends nothing at all until the owner allows it.
            perms = await self._effective_permissions()
            if not perms.get("can_raise_hand"):
                await self.send_json({"type": "error", "message": "اجازهٔ ارسال واکنش ندارید."})
                return
            key = content.get("reaction")
            if key not in REACTION_KEYS:
                return
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "presence.reaction",
                    "reaction": key,
                    "member_id": self.member.id,
                    "name": getattr(self.member, "participant_name", ""),
                },
            )
            self._note_reaction(key)
            return

        if action == "caption":
            # Speech-to-text happens in the speaker's browser; the server only
            # relays the text to the room.  Never stored, hard length cap and a
            # per-connection throttle so a scripted client cannot flood peers.
            perms = await self._effective_permissions()
            if not perms.get("can_use_microphone"):
                # Captions are the speaker's own words: no microphone grant, no
                # text to relay.  Silently dropped — captions are fire-and-forget.
                return
            text = content.get("text")
            if not isinstance(text, str):
                return
            text = " ".join(text.split())[:CAPTION_MAX_CHARS]
            if not text:
                return
            if not self._caption_limiter.allow():
                return
            await self.channel_layer.group_send(
                self.group_name,
                {
                    "type": "presence.caption",
                    "member_id": self.member.id,
                    "name": getattr(self.member, "participant_name", ""),
                    "text": text,
                    "final": bool(content.get("final")),
                },
            )
            return

        if action == "raise_hand":
            perms = await self._effective_permissions()
            if not perms.get("can_raise_hand"):
                await self.send_json({"type": "error", "message": "اجازهٔ بالا بردن دست ندارید."})
                return
            raised = content.get("raised")
            if type(raised) is not bool:
                await self.send_json({"type": "error", "message": "مقدار دست باید بولی باشد."})
                return
            await self._set_hand_raised(raised)
            return

        if action == "media_state":
            # Cosmetic roster state for THIS user only (never trusted for
            # authorisation — real media rights come from the SFU token).
            state = {key: content.get(key) for key in ("mic_on", "camera_on", "screen_sharing")}
            if any(type(value) is not bool for value in state.values()):
                await self.send_json({"type": "error", "message": "وضعیت رسانه باید بولی باشد."})
                return
            _media_states[(self.room_code, self.member.id)] = state
            payload = await self._self_payload()
            payload.update(state)
            await self.channel_layer.group_send(
                self.group_name, {"type": "presence.media_state", "participant": payload}
            )
            return

        if action == "rtc_signal":
            if not settings.MESH_ENABLED:
                await self.send_json({"type": "error", "message": "رسانهٔ همتا به همتا غیرفعال است."})
                return
            # WebRTC signalling relay (mesh fallback): SDP/ICE envelopes are
            # forwarded to ONE active member of THIS classroom, untouched
            # except a hard size cap.  The server never parses the media
            # payloads and clients can only reach real classmates.
            data = content.get("data")
            to_member_id = content.get("to_member_id")
            if (
                not isinstance(data, dict)
                or isinstance(to_member_id, bool)
                or not isinstance(to_member_id, int)
            ):
                return
            try:
                encoded = json.dumps(data, allow_nan=False, separators=(",", ":")).encode("utf-8")
            except (TypeError, ValueError, RecursionError):
                return
            if len(encoded) > RTC_SIGNAL_MAX_BYTES:
                return
            await self._relay_rtc_signal(to_member_id, data)
            return

        if action == "whiteboard_size":
            # The board is one shared page: its shape is the presenter's call,
            # and every device must agree on it.  Same gate as opening it.
            if not await self._is_authority_now():
                await self.send_json({
                    "type": "error",
                    "message": "فقط مالک، مدیر جلسه یا ارائه‌دهنده می‌تواند اندازهٔ تخته را تغییر دهد.",
                })
                return
            preset = content.get("preset")
            if not isinstance(preset, str):
                await self.send_json({"type": "error", "message": "اندازهٔ تخته نامعتبر است."})
                return
            result = await self._set_whiteboard_size(preset)
            if result is None:
                await self.send_json({"type": "error", "message": "اندازهٔ تخته نامعتبر است."})
            return

        if action == "whiteboard_state":
            # Opening/closing the board switches the view for the WHOLE room,
            # so it belongs to the authority roles.  A student may look at the
            # board (their client opens the view locally) but can never take
            # the class there.
            if not await self._is_authority_now():
                await self.send_json({
                    "type": "error",
                    "message": "فقط مالک، مدیر جلسه یا ارائه‌دهنده می‌تواند تخته را باز یا بسته کند.",
                })
                return
            opened = content.get("open")
            if type(opened) is not bool:
                await self.send_json({"type": "error", "message": "وضعیت تخته باید بولی باشد."})
                return
            await self._set_whiteboard_open(opened)
            return

        if action == "ping":
            await self.send_json({"type": "pong"})
            return

        logger.info("Ignoring unknown classroom action: %r", action)

    # ------------------------------------------------------------------
    # Group event handlers
    # ------------------------------------------------------------------
    # ------------------------------------------------------------ reactions
    def _note_reaction(self, key: str) -> None:
        """Buffer a reaction for the chat digest — O(1), no database work."""
        room = self.room_code
        window = _reaction_windows.get(room)
        if window is None:
            if len(_reaction_windows) >= _MAX_SUMMARY_ROOMS:
                # Drop the oldest room rather than grow without bound.
                _reaction_windows.pop(next(iter(_reaction_windows)), None)
            window = _reaction_windows[room] = {"members": {}, "task": None}
        window["members"].setdefault(key, set()).add(self.member.id)
        task = window.get("task")
        if task is None or task.done():
            window["task"] = asyncio.create_task(self._flush_reaction_summary(room))

    async def _flush_reaction_summary(self, room_code: str) -> None:
        """After the window closes, broadcast a single aggregated digest line."""
        try:
            await asyncio.sleep(REACTION_SUMMARY_DELAY)
        except asyncio.CancelledError:  # pragma: no cover - shutdown path
            _reaction_windows.pop(room_code, None)
            return
        window = _reaction_windows.pop(room_code, None)
        if not window:
            return
        parts = []
        for key, member_ids in window["members"].items():
            count = len(member_ids)
            if count < REACTION_SUMMARY_MIN_MEMBERS:
                continue
            parts.append(f"{count} نفر {REACTION_SUMMARY_LABELS.get(key, 'واکنش دادند')}")
        if not parts:
            return
        channel_layer = get_channel_layer()
        if channel_layer is None:  # pragma: no cover - misconfiguration
            return
        try:
            await channel_layer.group_send(
                f"classroom_chat_{room_code}",
                {"type": "chat.summary", "text": " · ".join(parts)},
            )
        except Exception:  # a channel-layer hiccup must never kill the socket
            logger.warning("reaction_summary_failed room=%s", room_code, exc_info=True)

    async def presence_user_joined(self, event: dict) -> None:
        await self.send_json({"type": "user_joined", "participant": event["participant"]})

    async def presence_user_left(self, event: dict) -> None:
        await self.send_json({"type": "user_left", "participant": event["participant"]})

    async def presence_reaction(self, event: dict) -> None:
        await self.send_json({
            "type": "reaction",
            "reaction": event["reaction"],
            "member_id": event["member_id"],
            "name": event.get("name", ""),
        })

    async def presence_caption(self, event: dict) -> None:
        await self.send_json({
            "type": "caption",
            "member_id": event["member_id"],
            "name": event.get("name", ""),
            "text": event["text"],
            "final": bool(event.get("final")),
        })

    async def presence_media_state(self, event: dict) -> None:
        await self.send_json({"type": "media_state", "participant": event["participant"]})

    async def classroom_event(self, event: dict) -> None:
        """Relay services events and close the room when it is deactivated."""
        payload = event["payload"]
        if payload.get("type") in {"waiting_room_entry", "waiting_room_denied"}:
            if not await self._privileged_now():
                return
        await self.send_json(payload)
        if payload.get("type") == "classroom_deactivated":
            await self.close(code=4403)

    async def classroom_notification(self, event: dict) -> None:
        """Relay targeted notifications and immediately revoke removed sockets."""
        payload = event["payload"]
        await self.send_json(payload)
        if payload.get("event") in {
            "removed", "left", "membership_revoked", "classroom_deactivated", "waiting_room_denied",
        }:
            await self.close(code=4403)

    # ------------------------------------------------------------------
    # DB helpers (all ORM access wrapped in sync contexts)
    # ------------------------------------------------------------------
    @database_sync_to_async
    def _privileged_now(self) -> bool:
        from .permissions import is_privileged
        member = ClassroomMember.objects.filter(
            id=self.member.id, classroom__is_active=True,
        ).first()
        return is_privileged(member)

    @database_sync_to_async
    def _member_active_now(self) -> bool:
        return ClassroomMember.objects.filter(
            id=self.member.id,
            is_active=True,
            in_waiting_room=False,
            classroom__is_active=True,
        ).exists()

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
            participant_payload(m, classroom) for m in members
            if include_waiting or not m.in_waiting_room
        ]
        for participant in participants:
            cached = _media_states.get((self.room_code, participant["member_id"]))
            if cached:
                participant.update(cached)
        state = {
            "is_locked": classroom.is_locked,
            "chat_disabled": classroom.chat_disabled,
            "chat_private": classroom.chat_private,
            "whiteboard_open": classroom.whiteboard_open,
            "whiteboard_width": classroom.whiteboard_width,
            "whiteboard_height": classroom.whiteboard_height,
            "current_file_id": classroom.current_file_id,
            "current_file_name": classroom.current_file.original_name if classroom.current_file else None,
            "current_file_has_pdf": bool(classroom.current_file and classroom.current_file.pdf_version),
            "current_page": classroom.current_page,
        }
        from quizzes.services import active_run, run_payload

        run = active_run(classroom)
        if run is not None:
            state["active_quiz"] = run_payload(run)
        return participants, state

    @database_sync_to_async
    def _self_payload(self) -> dict:
        # The consumer's ``self.classroom`` is a connection-time snapshot.
        # Class-wide permissions can change while the socket stays open, so
        # refresh the related classroom whenever we emit a participant state;
        # otherwise a later media_state could overwrite a fresh grant with
        # stale effective permissions in every peer's roster.
        member = ClassroomMember.objects.filter(id=self.member.id).select_related("user", "classroom").first()
        if member is None:
            return {"identity": "", "name": ""}
        payload = participant_payload(member, member.classroom)
        # Echo our own last announcement so a reconnect does not read as «no
        # camera» in our own roster until the first toggle.
        payload.update(_media_states.get((self.room_code, member.id), {}))
        return payload

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
    def _is_authority_now(self) -> bool:
        """Live OWNER/MODERATOR/PRESENTER check (roles can change mid-session)."""
        from .permissions import is_authority

        member = (
            ClassroomMember.objects.filter(
                id=self.member.id, is_active=True, in_waiting_room=False,
                classroom__is_active=True,
            )
            .select_related("classroom", "user")
            .first()
        )
        return bool(member and is_authority(member))

    @database_sync_to_async
    def _set_hand_raised(self, raised: bool) -> None:
        from .permissions import effective_permissions

        member = ClassroomMember.objects.filter(
            id=self.member.id, is_active=True, in_waiting_room=False,
            classroom__is_active=True,
        ).select_related("classroom", "user").first()
        if member and effective_permissions(member, member.classroom).get("can_raise_hand"):
            set_hand_raised(member.classroom, member, raised)

    @database_sync_to_async
    def _relay_rtc_signal(self, to_member_id: int, data: dict) -> None:
        """Deliver a signalling envelope to one active classmate."""
        from .services import notify_member

        sender = ClassroomMember.objects.filter(
            id=self.member.id, classroom=self.classroom,
            is_active=True, in_waiting_room=False, classroom__is_active=True,
        ).select_related("user").first()
        if sender is None:
            return
        target = ClassroomMember.objects.filter(
            classroom=self.classroom, id=to_member_id, is_active=True,
            in_waiting_room=False, classroom__is_active=True,
        ).first()
        if target is None or target.id == sender.id:
            return
        notify_member(self.room_code, target, {
            "type": "rtc_signal",
            "from_identity": sender.identity,
            "from_member_id": sender.id,
            "data": data,
        })

    @database_sync_to_async
    def _set_whiteboard_size(self, preset: str) -> dict | None:
        from .board import preset_key, size_for
        from .permissions import may_control_board
        from .services import broadcast

        size = size_for(preset)
        if size is None:
            return None
        member = ClassroomMember.objects.filter(
            id=self.member.id, is_active=True, in_waiting_room=False,
            classroom__is_active=True,
        ).select_related("classroom", "user").first()
        if member is None or not may_control_board(member, member.classroom):
            return None
        width, height = size
        classroom = member.classroom
        if classroom.whiteboard_width == width and classroom.whiteboard_height == height:
            return {"width": width, "height": height, "preset": preset_key(width, height)}
        Classroom.objects.filter(id=classroom.id).update(
            whiteboard_width=width, whiteboard_height=height,
        )
        payload = {
            "type": "whiteboard_size",
            "width": width,
            "height": height,
            "preset": preset_key(width, height),
            "by": member.participant_name,
        }
        broadcast(classroom.room_code, payload)
        return {"width": width, "height": height, "preset": payload["preset"]}

    @database_sync_to_async
    def _set_whiteboard_open(self, opened: bool) -> None:
        from .permissions import may_control_board
        from .services import broadcast

        member = ClassroomMember.objects.filter(
            id=self.member.id, is_active=True, in_waiting_room=False,
            classroom__is_active=True,
        ).select_related("classroom", "user").first()
        if member is None or not may_control_board(member, member.classroom):
            return
        Classroom.objects.filter(id=member.classroom_id).update(whiteboard_open=opened)
        broadcast(member.classroom.room_code, {
            "type": "whiteboard_state",
            "open": opened,
            "by": member.participant_name,
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
