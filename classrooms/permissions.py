"""Central permission architecture for classrooms.

Everything role/capability related lives here so that views, consumers and
APIs never hard-code permission logic.

Two layers
----------
1. **Member flags** (``ClassroomMember.can_*``) — per-participant grants,
   editable by the owner/moderator, seeded from the role matrix below.
2. **Classroom settings** — room-wide switches owned by the host
   (``Classroom.allow_student_*`` etc.).

``effective_permissions()`` combines both layers and is the ONLY source of
truth used by consumers, media-token generation and the API.  The browser
never decides anything: it only receives the effective result.
"""
from __future__ import annotations

from dataclasses import dataclass, fields as dc_fields
from typing import TYPE_CHECKING

from django.db.models import TextChoices

if TYPE_CHECKING:
    from .models import Classroom, ClassroomMember


class Role(TextChoices):
    """Roles a user can hold inside a classroom."""

    OWNER = "OWNER", "مالک"
    MODERATOR = "MODERATOR", "مدیر جلسه"
    PRESENTER = "PRESENTER", "ارائه‌دهنده"
    STUDENT = "STUDENT", "دانش‌آموز"
    GUEST = "GUEST", "مهمان"


PRIVILEGED_ROLES = {Role.OWNER, Role.MODERATOR}


@dataclass(frozen=True)
class PermissionDefaults:
    """Default capability set for a role. Extend by adding fields here."""

    can_use_microphone: bool
    can_use_camera: bool
    can_share_screen: bool
    can_use_whiteboard: bool
    can_send_messages: bool
    can_upload_files: bool
    can_raise_hand: bool
    can_present: bool


# Role → default capabilities.  OWNER gets everything; STUDENT gets a
# conservative baseline.  Individual members can later be granted more.
ROLE_DEFAULTS: dict[str, PermissionDefaults] = {
    Role.OWNER: PermissionDefaults(
        can_use_microphone=True,
        can_use_camera=True,
        can_share_screen=True,
        can_use_whiteboard=True,
        can_send_messages=True,
        can_upload_files=True,
        can_raise_hand=True,
        can_present=True,
    ),
    Role.MODERATOR: PermissionDefaults(
        can_use_microphone=True,
        can_use_camera=True,
        can_share_screen=True,
        can_use_whiteboard=True,
        can_send_messages=True,
        can_upload_files=True,
        can_raise_hand=True,
        can_present=True,
    ),
    Role.PRESENTER: PermissionDefaults(
        can_use_microphone=True,
        can_use_camera=True,
        can_share_screen=True,
        can_use_whiteboard=True,
        can_send_messages=True,
        can_upload_files=False,
        can_raise_hand=True,
        can_present=True,
    ),
    Role.STUDENT: PermissionDefaults(
        can_use_microphone=True,
        can_use_camera=True,
        can_share_screen=False,
        can_use_whiteboard=False,
        can_send_messages=True,
        can_upload_files=False,
        can_raise_hand=True,
        can_present=False,
    ),
    # Guests: conservative defaults; the owner can grant more per member.
    Role.GUEST: PermissionDefaults(
        can_use_microphone=True,
        can_use_camera=True,
        can_share_screen=False,
        can_use_whiteboard=False,
        can_send_messages=True,
        can_upload_files=False,
        can_raise_hand=True,
        can_present=False,
    ),
}


def permission_fields() -> list[str]:
    """Names of all capability flags (single source of truth)."""
    return [f.name for f in dc_fields(PermissionDefaults)]


def defaults_for_role(role: str) -> PermissionDefaults:
    """Return the default capability set for a role (falls back to STUDENT)."""
    return ROLE_DEFAULTS.get(role, ROLE_DEFAULTS[Role.STUDENT])


def apply_role_defaults(member: "ClassroomMember") -> None:
    """Populate a member's capability flags from their role's defaults."""
    for name, value in vars(defaults_for_role(member.role)).items():
        setattr(member, name, value)


def member_can(member: "ClassroomMember" | None, capability: str) -> bool:
    """Simple stored-flag check (role independent of classroom settings).

    Prefer :func:`effective_permissions` for anything enforcement related.
    """
    if member is None or not member.is_active:
        return False
    if capability not in permission_fields():
        raise ValueError(f"Unknown capability: {capability!r}")
    return bool(getattr(member, capability, False))


def is_privileged(member: "ClassroomMember" | None) -> bool:
    """True for OWNER/MODERATOR — participants who may manage the session."""
    return member is not None and member.is_active and member.role in PRIVILEGED_ROLES


def effective_permissions(member: "ClassroomMember" | None, classroom: "Classroom") -> dict[str, bool]:
    """Combine member flags with classroom-wide settings.

    This is the authoritative capability map — used for:
      * WebSocket authorization (chat / whiteboard / raise-hand)
      * LiveKit media-token grants (publish rights)
      * the payload rendered into the room page

    Rules:
      * inactive/missing membership → everything False
      * ``allow_student_*`` classroom switches only restrict STUDENTs
      * ``allow_file_upload`` restricts everyone except the OWNER
      * moderator actions (``muted`` / ``camera_disabled``) always win
      * ``chat_disabled`` silences everyone except OWNER/MODERATOR
    """
    if member is None or not member.is_active:
        return {name: False for name in permission_fields()}

    perms = member.permissions_dict()

    if member.role in {Role.STUDENT, Role.GUEST}:
        perms["can_send_messages"] &= classroom.allow_student_chat
        perms["can_share_screen"] &= classroom.allow_student_screen_share
        perms["can_use_whiteboard"] &= classroom.allow_student_whiteboard
        perms["can_use_microphone"] &= classroom.allow_student_mic
        perms["can_use_camera"] &= classroom.allow_student_camera

    # File upload: gated by the room setting for everyone except the owner,
    # and never available to guests.
    if member.is_guest:
        perms["can_upload_files"] = False
    elif member.role != Role.OWNER:
        perms["can_upload_files"] &= classroom.allow_file_upload

    if classroom.chat_disabled and member.role not in PRIVILEGED_ROLES:
        perms["can_send_messages"] = False

    # Moderator enforcement always wins over grants.
    if member.muted:
        perms["can_use_microphone"] = False
    if member.camera_disabled:
        perms["can_use_camera"] = False

    return perms
