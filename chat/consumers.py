"""WebSocket consumer for classroom chat.

Endpoint: ``/ws/classroom/<room_code>/chat/``

Flow:  browser WebSocket → Channels → this consumer → DB + group broadcast.

Authorization notes
-------------------
* membership + ``can_send_messages`` are re-evaluated **per message**
  against the database — classroom settings (e.g. ``chat_disabled`` or the
  owner's ``chat_private`` mode) or per-member flags changed mid-session take
  effect immediately;
* ``delete_message`` is restricted to OWNER/MODERATOR and soft-deletes;
* a modified client script can never grant extra rights.
"""
from __future__ import annotations

import logging

from channels.db import database_sync_to_async
from django.db.models import Q

from classrooms.models import ClassroomMember
from classrooms.permissions import effective_permissions, is_privileged
from classrooms.services import member_group, resolve_scope_member
from classrooms.ws_security import RateLimiter, SafeJsonWebsocketConsumer, describe_origin, ws_origin_allowed

from .models import ChatMessage

logger = logging.getLogger(__name__)

HISTORY_LIMIT = 100
MAX_MESSAGE_LENGTH = 1000
SEND_RATE_LIMIT = 10  # messages per second per connection
REPLY_SNIPPET = 160


class ChatConsumer(SafeJsonWebsocketConsumer):
    """Real-time classroom chat with persistent history and moderation."""

    max_message_bytes = 16 * 1024

    async def connect(self) -> None:
        self.room_code: str = self.scope["url_route"]["kwargs"]["room_code"]
        self.group_name = f"classroom_chat_{self.room_code}"
        # Hosts get a second group: private messages are only ever delivered
        # there (plus the author/audience member groups), never to the room.
        # Host team group: private messages are only ever delivered here (plus
        # the author's member group and the student a thread is addressed to).
        self.private_group = f"classroom_chat_{self.room_code}_private"
        self.classroom = None
        self.member = None
        self.user = self.scope.get("user")
        self.authenticated = bool(self.user is not None and getattr(self.user, "is_authenticated", False))

        # CSWSH defence — see classrooms.ws_security.
        if not ws_origin_allowed(self.scope):
            logger.warning(
                "ws_origin_rejected room=%s %s",
                self.room_code,
                describe_origin(self.scope),
            )
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

        self.member_group_name = member_group(self.room_code, self.member.id)
        self.is_host = await self._is_privileged_now()
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.channel_layer.group_add(self.member_group_name, self.channel_name)
        if self.is_host:
            await self.channel_layer.group_add(self.private_group, self.channel_name)
        await self.accept()
        await self.send_json({"type": "chat_history", "messages": await self._load_history()})

    async def disconnect(self, code: int) -> None:
        if getattr(self, "member", None) is not None:
            await self.channel_layer.group_discard(self.group_name, self.channel_name)
            await self.channel_layer.group_discard(
                getattr(self, "member_group_name", member_group(self.room_code, self.member.id)),
                self.channel_name,
            )
            if getattr(self, "is_host", False):
                await self.channel_layer.group_discard(self.private_group, self.channel_name)

    async def receive_json(self, content: dict, **kwargs) -> None:
        action = content.get("action")

        if action in ("send_message", "delete_message") and not await self._member_active_now():
            await self.close(code=4403)
            return

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

        # Privacy is decided *here*, never by the browser: a student cannot make
        # a message public, and nobody can turn a private thread public by
        # answering it.  See ``_save_message`` for the rule.
        reply_to = _as_positive_int(content.get("reply_to"))
        host = await self._is_privileged_now()
        payload = await self._save_message(
            message, reply_to=reply_to, private=content.get("private") is True
        )
        if payload is None:
            await self.send_json({"type": "error", "message": "شما اجازهٔ ارسال پیام ندارید."})
            return
        if not payload.get("is_private"):
            await self.channel_layer.group_send(
                self.group_name, {"type": "chat.message", "message": payload}
            )
            return
        # Private: hosts + the author, and the student the thread belongs to.
        await self.channel_layer.group_send(
            self.private_group, {"type": "chat.message", "message": payload}
        )
        # Hosts received it through ``private_group``; the student who wrote it
        # needs their own copy, and a thread addressed to a student reaches
        # them too.  Classmates are never in any of these groups.
        targets: set[str] = set() if host else {self.member_group_name}
        audience_member_id = await self._audience_member_id(payload)
        if audience_member_id:
            targets.add(member_group(self.room_code, audience_member_id))
        for group in targets:
            await self.channel_layer.group_send(
                group, {"type": "chat.message", "message": payload}
            )

    async def _handle_delete(self, content: dict) -> None:
        privileged = await self._is_privileged_now()
        if not privileged:
            await self.send_json({"type": "error", "message": "فقط مدیر می‌تواند پیام حذف کند."})
            return
        raw_id = content.get("message_id")
        if isinstance(raw_id, bool) or not isinstance(raw_id, (int, str)):
            return
        try:
            message_id = int(raw_id)
        except ValueError:
            return
        if message_id <= 0:
            return
        info = await self._soft_delete(message_id)
        if info:
            # Public messages live in the room group.  A private note is only in
            # the hosts' group plus the member groups of its author and of the
            # student the thread belongs to — route the deletion there, exactly
            # where the message itself was delivered.
            targets = {self.private_group} if info["private"] else {self.group_name}
            for member_id in {info["author"], info["audience"]} - {None}:
                targets.add(member_group(self.room_code, member_id))
            for group in targets:
                await self.channel_layer.group_send(
                    group, {"type": "chat.deleted", "message_id": message_id}
                )
            logger.info("chat_message_deleted", extra={"room_code": self.room_code, "message_id": message_id})

    # -- group handlers --------------------------------------------------
    async def chat_message(self, event: dict) -> None:
        await self.send_json({"type": "chat_message", "message": event["message"]})

    async def chat_deleted(self, event: dict) -> None:
        await self.send_json({"type": "chat_deleted", "message_id": event["message_id"]})

    async def chat_summary(self, event: dict) -> None:
        """Aggregated reaction digest from the presence consumer (ephemeral)."""
        text = str(event.get("text", "")).strip()
        if text:
            await self.send_json({"type": "reaction_summary", "text": text})

    async def classroom_notification(self, event: dict) -> None:
        payload = event["payload"]
        await self.send_json(payload)
        if payload.get("event") in {"removed", "left", "membership_revoked", "classroom_deactivated"}:
            await self.close(code=4403)

    # -- helpers -----------------------------------------------------------
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
    def _can_send_now(self) -> bool:
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
        return effective_permissions(member, member.classroom)["can_send_messages"]

    @database_sync_to_async
    def _is_privileged_now(self) -> bool:
        member = ClassroomMember.objects.filter(
            id=self.member.id, is_active=True, in_waiting_room=False,
            classroom__is_active=True,
        ).first()
        return is_privileged(member)

    @database_sync_to_async
    def _load_history(self) -> list[dict]:
        return [m.to_dict() for m in _visible_messages(self.classroom, self.member)]

    @database_sync_to_async
    def _save_message(
        self, message: str, *, private: bool = False, reply_to: int | None = None
    ) -> dict | None:
        member = ClassroomMember.objects.filter(
            id=self.member.id, is_active=True, in_waiting_room=False,
            classroom__is_active=True,
        ).select_related("classroom", "user").first()
        if member is None or not effective_permissions(member, member.classroom)["can_send_messages"]:
            return None
        host = is_privileged(member)
        parent = None
        if reply_to:
            parent = (
                ChatMessage.objects.filter(id=reply_to, classroom=member.classroom)
                .select_related("sender")
                .first()
            )
            # Only answer something you are allowed to see.
            if parent is not None and not _can_read(parent, member, host):
                parent = None
        # Who reads this line, in order of precedence:
        #   * the client asked for privacy (a host note, or an old client) —
        #     honoured for everybody, it can only narrow the audience;
        #   * the owner turned the room's chat private and this is a student —
        #     classmates must never see what a student writes;
        #   * this answers a private message — a reply may quote its parent,
        #     so it inherits the thread even after the room flips back to
        #     public.  Without this a host's «جواب شما» on a private question
        #     would have broadcast the question to the whole class.
        private = bool(
            private
            or (member.classroom.chat_private and not host)
            or (parent is not None and parent.is_private)
        )
        audience = None
        if private:
            if not host:
                # A student's private message belongs to them and the hosts.
                audience = member
            elif parent is not None and parent.is_private:
                # A host answering a private message keeps the thread private
                # *to that student* instead of dropping back to staff-only.
                candidate = parent.audience_member or parent.sender_member
                audience = candidate if candidate is not None and candidate.id != member.id else None
        return ChatMessage.objects.create(
            classroom=member.classroom,
            sender=member.user if member.user_id else None,
            sender_member=member,
            sender_name=member.participant_name[:80],
            sender_identity=member.identity[:48],
            message=message,
            reply_to=parent,
            is_private=private,
            audience_member=audience,
        ).to_dict()

    @database_sync_to_async
    def _audience_member_id(self, payload: dict) -> int | None:
        return ChatMessage.objects.filter(id=payload.get("id")).values_list(
            "audience_member_id", flat=True
        ).first()

    @database_sync_to_async
    def _soft_delete(self, message_id: int) -> dict | None:
        """Soft-delete one message and report where its deletion must go."""
        member = ClassroomMember.objects.filter(
            id=self.member.id, is_active=True, in_waiting_room=False,
            classroom__is_active=True,
        ).first()
        if not is_privileged(member):
            return None
        message = ChatMessage.objects.filter(
            id=message_id, classroom=self.classroom
        ).values("is_private", "sender_member_id", "audience_member_id").first()
        if message is None:
            return None
        ChatMessage.objects.filter(id=message_id, classroom=self.classroom).update(
            is_deleted=True
        )
        return {
            "private": message["is_private"],
            "author": message["sender_member_id"],
            "audience": message["audience_member_id"],
        }


# ---------------------------------------------------------------------------
# visibility helpers (kept next to the consumer so both sides agree)
# ---------------------------------------------------------------------------
def _can_read(message: ChatMessage, member: ClassroomMember, host: bool) -> bool:
    if not message.is_private:
        return True
    if host:
        return True
    return member.id in {message.audience_member_id, message.sender_member_id}


def _visible_messages(classroom, member: ClassroomMember, limit: int = HISTORY_LIMIT):
    """Newest ``limit`` messages this member may read, oldest first.

    Public messages are for everybody.  A private message is readable by the
    host team, its author and the student the thread belongs to — a student
    never receives another student's private note (the row is not even sent
    over the socket, so devtools cannot reveal it).
    """
    host = is_privileged(member)
    qs = ChatMessage.objects.filter(classroom=classroom).select_related("sender", "reply_to")
    if not host:
        qs = qs.filter(
            Q(is_private=False)
            | Q(sender_member_id=member.id)
            | Q(audience_member_id=member.id)
        )
    return list(qs.order_by("-created_at")[:limit])[::-1]


def _as_positive_int(raw) -> int | None:
    if isinstance(raw, bool) or raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None
