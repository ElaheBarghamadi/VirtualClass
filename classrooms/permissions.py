"""Central permission architecture for classrooms.

Everything role/capability related lives here so that views, consumers and
APIs never hard-code permission logic.  Adding a new capability later means:

1. add a BooleanField to ``ClassroomMember``;
2. add its default to the role matrix below.

The rest of the codebase reads capabilities through ``member.permissions_dict()``
or the helper functions in this module.
"""
from __future__ import annotations

from dataclasses import dataclass, fields as dc_fields
from typing import TYPE_CHECKING

from django.db.models import TextChoices

if TYPE_CHECKING:
    from .models import ClassroomMember


class Role(TextChoices):
    """Roles a user can hold inside a classroom."""

    OWNER = "OWNER", "مالک"
    MODERATOR = "MODERATOR", "مدیر جلسه"
    PRESENTER = "PRESENTER", "ارائه‌دهنده"
    STUDENT = "STUDENT", "دانش‌آموز"


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
    ),
    Role.MODERATOR: PermissionDefaults(
        can_use_microphone=True,
        can_use_camera=True,
        can_share_screen=True,
        can_use_whiteboard=True,
        can_send_messages=True,
        can_upload_files=True,
        can_raise_hand=True,
    ),
    Role.PRESENTER: PermissionDefaults(
        can_use_microphone=True,
        can_use_camera=True,
        can_share_screen=True,
        can_use_whiteboard=True,
        can_send_messages=True,
        can_upload_files=False,
        can_raise_hand=True,
    ),
    Role.STUDENT: PermissionDefaults(
        can_use_microphone=True,
        can_use_camera=True,
        can_share_screen=False,
        can_use_whiteboard=False,
        can_send_messages=True,
        can_upload_files=False,
        can_raise_hand=True,
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
    """Server-side capability check used by consumers and API.

    Returns ``False`` for missing/inactive memberships — never trust the
    client for any of these decisions.
    """
    if member is None or not member.is_active:
        return False
    if capability not in permission_fields():
        raise ValueError(f"Unknown capability: {capability!r}")
    return bool(getattr(member, capability, False))


def is_privileged(member: "ClassroomMember" | None) -> bool:
    """True for OWNER/MODERATOR — participants who may manage the session."""
    return member is not None and member.is_active and member.role in {Role.OWNER, Role.MODERATOR}
