"""Business logic for classrooms — shared by views, consumers and API.

Keeping this layer separate means HTTP views stay thin and WebSocket
consumers reuse exactly the same rules (membership, passwords, roles,
locks, bans, waiting room).  Every host action lives here, performs its
authorisation check, persists the change and then broadcasts an event.
"""
from __future__ import annotations

import logging
import re
from datetime import timedelta

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db import transaction
from django.utils import timezone

from .models import AttendanceRecord, Classroom, ClassroomMember, ClassroomSession
from .permissions import (
    PRIVILEGED_ROLES,
    Role,
    apply_role_defaults,
    effective_permissions,
    is_privileged,
    permission_fields,
)

logger = logging.getLogger("classrooms.services")

User = get_user_model()

# Broadcast channel group names ------------------------------------------------
def classroom_group(room_code: str) -> str:
    return f"classroom_{room_code}"


def member_group(room_code: str, member_id: int) -> str:
    """Per-participant group inside a classroom, for targeted notifications."""
    return f"classroom_{room_code}_member_{member_id}"


class ClassroomAccessError(Exception):
    """Raised when a user is not allowed to access/join a classroom."""


class WrongClassroomPassword(ClassroomAccessError):
    """Raised when the supplied classroom password is incorrect."""


class ClassroomLocked(ClassroomAccessError):
    """Raised when the classroom is locked by its owner."""


class UserBanned(ClassroomAccessError):
    """Raised when the user is temporarily banned from this classroom."""


class TooManyAttempts(ClassroomAccessError):
    """Raised when password guessing is rate-limited."""


class PermissionDenied(Exception):
    """Raised when the acting user may not perform a host action."""


# ---------------------------------------------------------------------------
# Rate limiting for classroom passwords (cache backed: Redis in production)
# ---------------------------------------------------------------------------
PASSWORD_MAX_ATTEMPTS = 5
PASSWORD_LOCK_SECONDS = 120
# Per-IP cap: rotating guest names / accounts must not yield unlimited
# guesses against one classroom's password.
PASSWORD_MAX_ATTEMPTS_IP = 15
PASSWORD_LOCK_SECONDS_IP = 300


def _attempts_key(classroom: Classroom, who) -> str:
    """Rate-limit key — works for User objects and guest name strings."""
    return f"classpw:{classroom.id}:{getattr(who, 'id', who)}"


def _attempts_key_ip(classroom: Classroom, ip: str) -> str:
    return f"classpw-ip:{classroom.id}:{ip}"


def register_failed_password(classroom: Classroom, who) -> None:
    key = _attempts_key(classroom, who)
    try:
        cache.incr(key)
    except ValueError:
        cache.set(key, 1, PASSWORD_LOCK_SECONDS)


def password_attempts_blocked(classroom: Classroom, who) -> bool:
    return (cache.get(_attempts_key(classroom, who)) or 0) >= PASSWORD_MAX_ATTEMPTS


def reset_password_attempts(classroom: Classroom, who) -> None:
    cache.delete(_attempts_key(classroom, who))


def register_failed_password_ip(classroom: Classroom, ip: str) -> None:
    if not ip:
        return
    key = _attempts_key_ip(classroom, ip)
    try:
        cache.incr(key)
    except ValueError:
        cache.set(key, 1, PASSWORD_LOCK_SECONDS_IP)


def password_attempts_blocked_ip(classroom: Classroom, ip: str) -> bool:
    if not ip:
        return False
    return (cache.get(_attempts_key_ip(classroom, ip)) or 0) >= PASSWORD_MAX_ATTEMPTS_IP


# ---------------------------------------------------------------------------
# Classroom lifecycle
# ---------------------------------------------------------------------------
@transaction.atomic
def create_classroom(
    owner: User,
    title: str,
    description: str = "",
    password: str | None = None,
    is_password_protected: bool = False,
) -> Classroom:
    """Create a classroom and register the owner with the OWNER role."""
    classroom = Classroom(owner=owner, title=title, description=description)
    classroom.set_password(password if is_password_protected else None)
    classroom.save()
    ClassroomMember.objects.create(classroom=classroom, user=owner, role=Role.OWNER, is_active=True)
    logger.info("classroom_created", extra={"room_code": classroom.room_code, "owner_id": owner.id})
    return classroom


def get_member(classroom: Classroom, user: User) -> ClassroomMember | None:
    return ClassroomMember.objects.filter(classroom=classroom, user=user).select_related("user").first()


def get_active_member(classroom: Classroom, user: User) -> ClassroomMember | None:
    # select_related keeps participant_name usable from async consumers
    return (
        ClassroomMember.objects.filter(classroom=classroom, user=user, is_active=True)
        .select_related("user")
        .first()
    )


def get_guest_member(classroom: Classroom, guest_uid: str) -> ClassroomMember | None:
    """Resolve a guest by the uid stored in THEIR session (never trusted
    from any other source)."""
    if not guest_uid:
        return None
    return ClassroomMember.objects.filter(
        classroom=classroom, guest_uid=guest_uid, is_guest=True, is_active=True
    ).first()


def resolve_member(request, classroom: Classroom) -> ClassroomMember | None:
    """The participant behind an HTTP request: registered user or session guest."""
    user = getattr(request, "user", None)
    if user is not None and user.is_authenticated:
        return get_active_member(classroom, user)
    return get_guest_member(classroom, request.session.get(guest_session_key(classroom)))


def guest_session_key(classroom: Classroom) -> str:
    return f"guest_member_{classroom.room_code}"


def resolve_scope_member(scope, room_code: str):
    """Resolve (classroom, member) from a WebSocket scope.

    Registered users come from ``scope['user']`` (session cookie via
    AuthMiddlewareStack); guests from the guest uid stored in THEIR
    Django session (SessionMiddlewareStack).  Nothing from the message
    payload is ever trusted.
    """
    classroom = Classroom.objects.filter(room_code=room_code, is_active=True).first()
    if classroom is None:
        return None, None
    user = scope.get("user")
    if user is not None and getattr(user, "is_authenticated", False):
        return classroom, get_active_member(classroom, user)
    session = scope.get("session")
    guest_uid = session.get(guest_session_key(classroom)) if session else None
    return classroom, get_guest_member(classroom, guest_uid)


def is_banned(member: ClassroomMember | None) -> bool:
    return bool(member and member.banned_until and member.banned_until > timezone.now())


# ---------------------------------------------------------------------------
# Guest display names
# ---------------------------------------------------------------------------
GUEST_NAME_MIN = 2
GUEST_NAME_MAX = 40


def validate_display_name(raw: str) -> str:
    """Trim + length rules; strip anything that looks like markup.

    Names are escaped at every render point (Django autoescape / JS
    textContent), and angle brackets are additionally removed here so a
    stored name can never smuggle HTML into any consumer of the data.
    """
    name = re.sub(r"[<>]", "", str(raw or "")).strip()
    name = re.sub(r"\s+", " ", name)
    if len(name) < GUEST_NAME_MIN:
        raise ValidationError(f"نام باید حداقل {GUEST_NAME_MIN} نویسه باشد.")
    if len(name) > GUEST_NAME_MAX:
        raise ValidationError(f"نام نمی‌تواند بیشتر از {GUEST_NAME_MAX} نویسه باشد.")
    return name


def unique_display_name(classroom: Classroom, name: str) -> str:
    """«Ali», then «Ali (2)», «Ali (3)» … within the classroom."""
    members = ClassroomMember.objects.filter(classroom=classroom).select_related("user")
    existing = {m.participant_name for m in members}
    if name not in existing:
        return name
    i = 2
    while f"{name} ({i})" in existing:
        i += 1
    return f"{name} ({i})"


@transaction.atomic
def join_classroom_guest(classroom: Classroom, raw_name: str, raw_password: str = "") -> ClassroomMember:
    """Join as a guest — no Django account is created.

    Same gates as registered joins: active classroom → guests allowed →
    not locked → password (rate-limited, keyed by name+room) → optional
    waiting room.
    """
    if not classroom.is_active:
        raise ClassroomAccessError("این کلاس غیرفعال است.")
    if not classroom.allow_guests:
        raise ClassroomAccessError("ورود به این کلاس فقط برای کاربران ثبت‌نام‌شده ممکن است.")
    if classroom.is_locked:
        raise ClassroomLocked("کلاس توسط میزبان قفل شده است.")

    name = validate_display_name(raw_name)

    if classroom.is_password_protected:
        if password_attempts_blocked(classroom, name):  # type: ignore[arg-type]
            raise TooManyAttempts("تلاش‌های ناموفق بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.")
        if not classroom.check_password(raw_password):
            register_failed_password(classroom, name)  # type: ignore[arg-type]
            raise WrongClassroomPassword("رمز کلاس اشتباه است.")
        reset_password_attempts(classroom, name)  # type: ignore[arg-type]

    member = ClassroomMember.objects.create(
        classroom=classroom,
        user=None,
        role=Role.GUEST,
        is_guest=True,
        display_name=unique_display_name(classroom, name),
        is_active=True,
        in_waiting_room=classroom.enable_waiting_room,
    )
    broadcast(classroom.room_code, {
        "type": "waiting_room_entry" if member.in_waiting_room else "user_joined",
        "participant": participant_payload(member),
    })
    logger.info(
        "guest_joined",
        extra={"room_code": classroom.room_code, "guest": member.guest_uid, "waiting": member.in_waiting_room},
    )
    return member


def _password_already_verified(classroom: Classroom, user: User) -> bool:
    """An active member passed the password gate when they first joined."""
    if not classroom.is_password_protected:
        return True
    return bool(
        ClassroomMember.objects.filter(classroom=classroom, user=user, is_active=True).exists()
    )


@transaction.atomic
def join_classroom(classroom: Classroom, user: User, raw_password: str = "") -> ClassroomMember:
    """Join (or re-activate membership in) a classroom.

    Server-side checks, in order: active classroom → not banned → not
    locked (existing members may re-enter) → password (rate-limited).
    New students go to the waiting room when the owner enabled it.
    """
    if not classroom.is_active:
        raise ClassroomAccessError("این کلاس غیرفعال است.")

    existing = get_member(classroom, user)
    returning_member = existing is not None and existing.is_active

    if is_banned(existing):
        raise UserBanned("ورود شما به این کلاس موقتاً مسدود است.")

    if classroom.is_locked and not returning_member:
        raise ClassroomLocked("کلاس توسط میزبان قفل شده است.")

    if not _password_already_verified(classroom, user):
        if password_attempts_blocked(classroom, user):
            raise TooManyAttempts("تلاش‌های ناموفق بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.")
        if not classroom.check_password(raw_password):
            register_failed_password(classroom, user)
            raise WrongClassroomPassword("رمز کلاس اشتباه است.")
        reset_password_attempts(classroom, user)

    if existing is None:
        waiting = classroom.enable_waiting_room
        member = ClassroomMember.objects.create(
            classroom=classroom,
            user=user,
            role=Role.STUDENT,
            is_active=True,
            in_waiting_room=waiting,
        )
        broadcast(classroom.room_code, {
            "type": "waiting_room_entry" if waiting else "user_joined",
            "participant": participant_payload(member),
        })
        logger.info(
            "participant_joined",
            extra={"room_code": classroom.room_code, "user_id": user.id, "waiting": waiting},
        )
    else:
        member = existing
        member.is_active = True
        member.banned_until = None
        member.save(update_fields=["is_active", "banned_until"])
    return member


def leave_classroom(classroom: Classroom, user: User) -> None:
    ClassroomMember.objects.filter(classroom=classroom, user=user).update(is_active=False)


def active_members(classroom: Classroom) -> list[ClassroomMember]:
    return list(
        ClassroomMember.objects.filter(classroom=classroom, is_active=True)
        .select_related("user")
        .order_by("role", "joined_at")
    )


# ---------------------------------------------------------------------------
# Broadcasting helpers
# ---------------------------------------------------------------------------
def broadcast(room_code: str, payload: dict) -> None:
    """Send an event to everyone connected to the classroom."""
    payload = {**payload, "type": payload.get("type", "event")}
    async_to_sync(get_channel_layer().group_send)(
        classroom_group(room_code), {"type": "classroom.event", "payload": payload}
    )


def notify_member(room_code: str, member: ClassroomMember, payload: dict) -> None:
    """Send a targeted notification to a single participant (user or guest)."""
    payload = {**payload, "type": payload.get("type", "notification")}
    async_to_sync(get_channel_layer().group_send)(
        member_group(room_code, member.id), {"type": "classroom.notification", "payload": payload}
    )


def participant_payload(member: ClassroomMember) -> dict:
    """Public participant data — no sensitive fields are ever exposed.

    ``identity`` is the client-side key (``u:<id>`` / ``g:<uid>``); the
    database pk only appears as ``member_id`` for host-control endpoints,
    which re-validate everything server-side.
    """
    return {
        "member_id": member.id,
        "identity": member.identity,
        "user_id": member.user_id,
        "is_guest": member.is_guest,
        "name": member.participant_name,
        "role": member.role,
        "role_label": member.get_role_display(),
        "muted": member.muted,
        "camera_disabled": member.camera_disabled,
        "hand_raised": member.hand_raised_at is not None,
        "hand_raised_at": member.hand_raised_at.isoformat() if member.hand_raised_at else None,
        "in_waiting_room": member.in_waiting_room,
        "joined_at": member.joined_at.isoformat(),
    }


# ---------------------------------------------------------------------------
# Host actions — each validates the operator, mutates, then broadcasts
# ---------------------------------------------------------------------------
def _require_privileged(classroom: Classroom, operator: User) -> ClassroomMember:
    member = get_active_member(classroom, operator)
    if not is_privileged(member):
        raise PermissionDenied("شما اجازهٔ این عملیات را ندارید.")
    return member


def _require_owner(classroom: Classroom, operator: User) -> ClassroomMember:
    member = get_active_member(classroom, operator)
    if member is None or member.role != Role.OWNER:
        raise PermissionDenied("این عملیات فقط برای مالک کلاس مجاز است.")
    return member


def _target_member(classroom: Classroom, member_id: int) -> ClassroomMember:
    member = ClassroomMember.objects.filter(id=member_id, classroom=classroom).select_related("user").first()
    if member is None:
        raise ClassroomAccessError("عضو مورد نظر یافت نشد.")
    return member


def _can_manage(actor: ClassroomMember, target: ClassroomMember) -> bool:
    """Owner manages everyone (except themselves); moderators manage non-privileged."""
    if actor.id == target.id:
        return False
    if actor.role == Role.OWNER:
        return True
    return target.role not in PRIVILEGED_ROLES


def set_member_permission(classroom: Classroom, operator: User, member_id: int, permission: str, value: bool) -> None:
    actor = _require_privileged(classroom, operator)
    if permission not in permission_fields():
        raise ValueError(f"Unknown permission: {permission!r}")
    target = _target_member(classroom, member_id)
    if not _can_manage(actor, target):
        raise PermissionDenied("اجازهٔ مدیریت این عضو را ندارید.")
    setattr(target, permission, bool(value))
    if permission == "can_use_microphone" and value:
        target.muted = False  # granting mic rights lifts a moderator mute
    if permission == "can_use_camera" and value:
        target.camera_disabled = False
    target.save()
    perms = effective_permissions(target, classroom)
    notify_member(classroom.room_code, target, {
        "type": "notification",
        "text": f"دسترسی «{permission}» شما {'فعال' if perms[permission] else 'غیرفعال'} شد.",
        "level": "info",
    })
    broadcast(classroom.room_code, {
        "type": "permission_changed",
        "member_id": target.id,
        "identity": target.identity,
        "user_id": target.user_id,
        "permission": permission,
        "value": bool(value),
    })
    logger.info("permission_changed", extra={"room_code": classroom.room_code, "target": target.user_id, "permission": permission})


def set_member_role(classroom: Classroom, owner: User, member_id: int, role: str) -> None:
    """Role assignment is OWNER-only (spec: owner assigns MODERATOR/PRESENTER)."""
    _require_owner(classroom, owner)
    if role not in Role.values or role == Role.OWNER:
        raise ValueError("نقش نامعتبر است.")
    target = _target_member(classroom, member_id)
    if target.role == Role.OWNER:
        raise PermissionDenied("نقش مالک قابل تغییر نیست.")
    target.role = role
    apply_role_defaults(target)
    target.save()
    notify_member(classroom.room_code, target, {
        "type": "notification",
        "text": f"نقش شما به «{target.get_role_display()}» تغییر کرد.",
        "level": "success",
        "event": "role_changed",
    })
    broadcast(classroom.room_code, {
        "type": "role_changed",
        "member_id": target.id,
        "identity": target.identity,
        "user_id": target.user_id,
        "role": role,
        "role_label": target.get_role_display(),
    })
    logger.info("role_changed", extra={"room_code": classroom.room_code, "target": target.user_id, "role": role})


def set_member_muted(classroom: Classroom, operator: User, member_id: int, muted: bool) -> None:
    actor = _require_privileged(classroom, operator)
    target = _target_member(classroom, member_id)
    if not _can_manage(actor, target):
        raise PermissionDenied("اجازهٔ مدیریت این عضو را ندارید.")
    target.muted = bool(muted)
    target.save(update_fields=["muted"])
    if muted:
        notify_member(classroom.room_code, target, {
            "type": "notification", "text": "میکروفون شما توسط مدیر بی‌صدا شد.",
            "level": "warning", "event": "muted",
        })
    broadcast(classroom.room_code, {
        "type": "participant_muted", "member_id": target.id, "identity": target.identity,
        "user_id": target.user_id, "muted": bool(muted),
    })


def request_unmute(classroom: Classroom, operator: User, member_id: int) -> None:
    """Ask a muted participant to unmute (notification only)."""
    _require_privileged(classroom, operator)
    target = _target_member(classroom, member_id)
    notify_member(classroom.room_code, target, {
        "type": "notification", "text": "میزبان از شما خواست میکروفون را روشن کنید.",
        "level": "info", "event": "unmute_requested",
    })


def mute_all(classroom: Classroom, operator: User) -> int:
    actor = _require_privileged(classroom, operator)
    targets = ClassroomMember.objects.filter(classroom=classroom, is_active=True).exclude(id=actor.id)
    count = targets.update(muted=True)
    for member in targets.select_related("user"):
        notify_member(classroom.room_code, member, {
            "type": "notification", "text": "همهٔ شرکت‌کنندگان توسط میزبان بی‌صدا شدند.",
            "level": "warning", "event": "muted",
        })
    broadcast(classroom.room_code, {"type": "mute_all", "except_member_id": actor.id})
    return count


def remove_member(classroom: Classroom, operator: User, member_id: int, ban_minutes: int = 0) -> None:
    """Remove a participant; optionally ban re-entry for N minutes."""
    actor = _require_privileged(classroom, operator)
    target = _target_member(classroom, member_id)
    if not _can_manage(actor, target):
        raise PermissionDenied("اجازهٔ مدیریت این عضو را ندارید.")
    target.is_active = False
    target.in_waiting_room = False
    target.hand_raised_at = None
    if ban_minutes > 0:
        target.banned_until = timezone.now() + timedelta(minutes=ban_minutes)
    target.save(update_fields=["is_active", "in_waiting_room", "hand_raised_at", "banned_until"])
    notify_member(classroom.room_code, target, {
        "type": "notification", "text": "شما از کلاس خارج شدید.", "level": "error", "event": "removed",
    })
    broadcast(classroom.room_code, {
        "type": "participant_removed", "member_id": target.id, "identity": target.identity,
        "user_id": target.user_id,
    })
    logger.info("participant_removed", extra={"room_code": classroom.room_code, "target": target.user_id})


def approve_waiting_room(classroom: Classroom, operator: User, member_id: int) -> None:
    actor = _require_privileged(classroom, operator)
    target = _target_member(classroom, member_id)
    if not _can_manage(actor, target) and actor.role != Role.OWNER:
        raise PermissionDenied()
    target.in_waiting_room = False
    target.save(update_fields=["in_waiting_room"])
    notify_member(classroom.room_code, target, {
        "type": "notification", "text": "ورود شما تأیید شد؛ در حال ورود به کلاس…",
        "level": "success", "event": "waiting_room_approved",
    })
    # Keep every roster (all hosts) in sync — the waiting entry is now cleared.
    broadcast(classroom.room_code, {
        "type": "waiting_room_approved",
        "member_id": target.id,
        "identity": target.identity,
        "participant": participant_payload(target),
    })


def deny_waiting_room(classroom: Classroom, operator: User, member_id: int) -> None:
    actor = _require_privileged(classroom, operator)
    target = _target_member(classroom, member_id)
    if not _can_manage(actor, target) and actor.role != Role.OWNER:
        raise PermissionDenied()
    target.is_active = False
    target.in_waiting_room = False
    target.save(update_fields=["is_active", "in_waiting_room"])
    notify_member(classroom.room_code, target, {
        "type": "notification", "text": "درخواست ورود شما رد شد.", "level": "error", "event": "waiting_room_denied",
    })
    # Without this the denied entry would linger in every host's roster.
    broadcast(classroom.room_code, {
        "type": "waiting_room_denied",
        "member_id": target.id,
        "identity": target.identity,
    })


def set_classroom_locked(classroom: Classroom, owner: User, locked: bool) -> None:
    _require_owner(classroom, owner)
    classroom.is_locked = bool(locked)
    classroom.save(update_fields=["is_locked", "updated_at"])
    broadcast(classroom.room_code, {
        "type": "classroom_locked" if locked else "classroom_unlocked",
        "text": "کلاس قفل شد؛ ورود اعضای جدید مسدود است." if locked else "قفل کلاس باز شد.",
    })


SETTING_FIELDS = (
    "enable_waiting_room",
    "allow_student_chat",
    "allow_student_mic",
    "allow_student_camera",
    "allow_student_screen_share",
    "allow_student_whiteboard",
    "allow_file_upload",
    "chat_disabled",
)


def update_settings(classroom: Classroom, owner: User, values: dict) -> None:
    _require_owner(classroom, owner)
    applied = {k: bool(v) for k, v in values.items() if k in SETTING_FIELDS}
    for field, value in applied.items():
        setattr(classroom, field, value)
    classroom.save(update_fields=[*applied.keys(), "updated_at"])
    broadcast(classroom.room_code, {"type": "settings_changed", "settings": applied})


def set_presentation(classroom: Classroom, operator: User, file_id: int | None, page: int) -> None:
    """Presenter picks the shared material and page; state syncs to all."""
    actor = get_active_member(classroom, operator)
    # effective_permissions is the single source of truth — checking the
    # stored flag as well would lock out members whose row predates the
    # can_present field (stale default=False), e.g. owners of old classrooms.
    if actor is None or not effective_permissions(actor, classroom)["can_present"]:
        raise PermissionDenied("شما اجازهٔ ارائه ندارید.")
    if file_id is not None:
        # strict int — a bool/str/float from JSON must not become "file 1"
        if isinstance(file_id, bool) or not isinstance(file_id, int):
            raise ValueError("file_id نامعتبر است.")
        shared = classroom.files.filter(id=file_id).first()
        if shared is None:
            raise ClassroomAccessError("فایل انتخاب‌شده متعلق به این کلاس نیست.")
        classroom.current_file = shared
    else:
        classroom.current_file = None
    # clamp: unbounded values would overflow a PostgreSQL IntegerField
    classroom.current_page = max(1, min(9999, int(page or 1)))
    classroom.save(update_fields=["current_file", "current_page", "updated_at"])
    broadcast(classroom.room_code, {
        "type": "presentation_changed",
        "file_id": classroom.current_file_id,
        "file_name": classroom.current_file.original_name if classroom.current_file else None,
        "has_pdf": bool(classroom.current_file and classroom.current_file.pdf_version),
        "page": classroom.current_page,
    })


MAX_FILES_PER_CLASSROOM = 100  # per-classroom cap so shared storage stays bounded


def delete_shared_file(classroom: Classroom, member: ClassroomMember | None, file_id: int) -> None:
    """Remove a shared file — privileged members may delete any file,
    anyone else only their own upload.

    Also cleans up after itself: the physical file leaves storage, and if
    the deleted file was the one being presented, the presentation is
    cleared and everyone is told.
    """
    from .models import SharedFile

    if member is None or not member.is_active or member.in_waiting_room:
        raise PermissionDenied("شما اجازهٔ مدیریت فایل‌ها را ندارید.")
    shared = SharedFile.objects.filter(classroom=classroom, id=file_id).first()
    if shared is None:
        raise ClassroomAccessError("فایل یافت نشد.")
    is_uploader = bool(member.user_id) and member.user_id == shared.uploader_id
    if not (is_privileged(member) or is_uploader):
        raise PermissionDenied("فقط مدیر کلاس یا بارگذار می‌تواند این فایل را حذف کند.")

    was_presenting = classroom.current_file_id == shared.id
    name, fid = shared.original_name, shared.id
    shared.file.delete(save=False)  # physical copy (no-op if already gone)
    shared.delete()

    if was_presenting:
        classroom.current_file = None
        classroom.current_page = 1
        classroom.save(update_fields=["current_file", "current_page", "updated_at"])
        broadcast(classroom.room_code, {
            "type": "presentation_changed", "file_id": None, "file_name": None, "page": 1,
        })
    broadcast(classroom.room_code, {"type": "file_deleted", "file_id": fid, "name": name})
    logger.info("file_deleted", extra={"room_code": classroom.room_code, "file_id": fid})


def set_hand_raised(classroom: Classroom, member: ClassroomMember, raised: bool) -> None:
    member.hand_raised_at = timezone.now() if raised else None
    member.save(update_fields=["hand_raised_at"])
    payload = participant_payload(member)
    broadcast(classroom.room_code, {
        "type": "raise_hand" if raised else "lower_hand",
        "participant": payload,
    })


# ---------------------------------------------------------------------------
# Sessions & attendance
# ---------------------------------------------------------------------------
def get_live_session(classroom: Classroom) -> ClassroomSession | None:
    return ClassroomSession.objects.filter(classroom=classroom, status=ClassroomSession.Status.LIVE).first()


@transaction.atomic
def start_session(classroom: Classroom, host: User, session: ClassroomSession | None = None) -> ClassroomSession:
    """Start a scheduled session, or create an ad-hoc live one."""
    _require_privileged(classroom, host)
    live = get_live_session(classroom)
    if live is not None:
        return live
    if session is None:
        session = ClassroomSession(classroom=classroom, host=host, title="جلسهٔ جاری")
    elif session.classroom_id != classroom.id:
        raise ClassroomAccessError("جلسه متعلق به این کلاس نیست.")
    session.status = ClassroomSession.Status.LIVE
    session.started_at = timezone.now()
    session.ended_at = None
    session.save()
    broadcast(classroom.room_code, {"type": "session_started", "session_id": session.id})
    logger.info("session_started", extra={"room_code": classroom.room_code, "session_id": session.id})
    return session


def end_session(session: ClassroomSession, host: User) -> ClassroomSession:
    _require_privileged(session.classroom, host)
    if session.status == ClassroomSession.Status.LIVE:
        session.status = ClassroomSession.Status.ENDED
        session.ended_at = timezone.now()
        session.save(update_fields=["status", "ended_at"])
        # Close any still-open attendance intervals.
        AttendanceRecord.objects.filter(session=session, left_at__isnull=True).update(left_at=session.ended_at)
        broadcast(session.classroom.room_code, {"type": "session_ended", "session_id": session.id})
        logger.info("session_ended", extra={"room_code": session.classroom.room_code, "session_id": session.id})
    return session


def attendance_join(classroom: Classroom, member: ClassroomMember) -> AttendanceRecord | None:
    """Open an attendance interval if a session is live (guests included)."""
    session = get_live_session(classroom)
    if session is None or member is None or member.in_waiting_room:
        return None
    return AttendanceRecord.objects.create(session=session, member=member, user=member.user)


def attendance_leave(classroom: Classroom, member: ClassroomMember) -> None:
    """Close this participant's open attendance intervals for the live session."""
    session = get_live_session(classroom)
    if session is None or member is None:
        return
    AttendanceRecord.objects.filter(session=session, member=member, left_at__isnull=True).update(
        left_at=timezone.now()
    )


def attendance_summary(session: ClassroomSession) -> list[dict]:
    """Per-participant totals for a session (multiple intervals aggregated)."""
    from django.db.models import Count

    rows = (
        session.attendance.select_related("member", "member__user")
        .values("member_id")
        .annotate(joins=Count("id"))
        .order_by("member_id")
    )
    result = []
    for row in rows:
        member = ClassroomMember.objects.filter(id=row["member_id"]).select_related("user").first()
        intervals = list(
            AttendanceRecord.objects.filter(session=session, member_id=row["member_id"]).values_list(
                "joined_at", "left_at"
            )
        )
        total = 0
        for joined, left in intervals:
            end = left or timezone.now()
            total += int((end - joined).total_seconds())
        result.append({
            "member_id": row["member_id"],
            "username": member.participant_name if member else "—",
            "joins": row["joins"],
            "total_seconds": total,
        })
    return result
