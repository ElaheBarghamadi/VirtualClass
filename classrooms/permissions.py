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

#: Roles that own the *shared surface*: opening/closing the whiteboard, adding
#: and switching its pages, driving the slide deck and locking annotation.
#: A STUDENT/GUEST never gets this, no matter which per-member flags they hold:
#: the owner grants a student *ink*, never the room.
AUTHORITY_ROLES = frozenset({Role.OWNER, Role.MODERATOR, Role.PRESENTER})

#: Whiteboard operations that change the page structure instead of the ink on
#: it.  Authority only — a granted student may write, not reorganise the board.
BOARD_STRUCTURE_OPS = frozenset({"clear", "page_add", "page_delete", "page_go", "page_setup"})


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
    # Students and guests start strictly view-only: not one capability, not
    # even chat or a raised hand.  Everything they may do is an explicit,
    # revocable per-member grant the owner makes from the participants panel
    # (``services.set_member_permission``); nothing in the room is handed out
    # by role, by a room-wide switch or by a URL.  The structural powers —
    # opening/closing the board, moving pages, driving the deck — are never
    # grantable at all (see ``AUTHORITY_ROLES``).
    Role.STUDENT: PermissionDefaults(
        can_use_microphone=False,
        can_use_camera=False,
        can_share_screen=False,
        can_use_whiteboard=False,
        can_send_messages=False,
        can_upload_files=False,
        can_raise_hand=False,
        can_present=False,
    ),
    Role.GUEST: PermissionDefaults(
        can_use_microphone=False,
        can_use_camera=False,
        can_share_screen=False,
        can_use_whiteboard=False,
        can_send_messages=False,
        can_upload_files=False,
        can_raise_hand=False,
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


def is_admitted(member: "ClassroomMember" | None, classroom: "Classroom") -> bool:
    """An active member may access classroom resources only after admission."""
    return bool(member and member.classroom_id == classroom.id and classroom.is_active
                and member.is_active and not member.in_waiting_room)


def is_privileged(member: "ClassroomMember" | None) -> bool:
    """True for OWNER/MODERATOR — participants who may manage the session."""
    return member is not None and member.is_active and not member.in_waiting_room and member.role in PRIVILEGED_ROLES


def is_authority(member: "ClassroomMember" | None) -> bool:
    """True for OWNER/MODERATOR/PRESENTER — the roles that own the board.

    This is the *structural* question (may this participant open the board,
    add a page, move the class to page 4), which is deliberately narrower than
    "may write": a student can be granted ink without ever being able to
    reorganise what everybody is looking at.
    """
    return member is not None and member.is_active and not member.in_waiting_room and member.role in AUTHORITY_ROLES


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
    if not is_admitted(member, classroom):
        return {name: False for name in permission_fields()}

    # OWNER is authoritative in their own classroom: always the full
    # capability set, regardless of stale stored flags (e.g. members
    # created before a capability field existed and backfilled False).
    if member.role == Role.OWNER:
        perms = {name: True for name in permission_fields()}
    else:
        perms = member.permissions_dict()

    if member.role in {Role.STUDENT, Role.GUEST}:
        # Participation switches (talk / show yourself / type) — a room-wide
        # switch can only take these away.
        perms["can_send_messages"] &= classroom.allow_student_chat
        perms["can_use_microphone"] &= classroom.allow_student_mic
        perms["can_use_camera"] &= classroom.allow_student_camera
        # Shared *content* is never granted by a room-wide switch: screen
        # sharing and the whiteboard are per-member grants the owner makes by
        # hand (participants panel).  The old ``allow_student_whiteboard`` /
        # ``allow_student_screen_share`` switches handed both to every student
        # at once, which is exactly what a view-only student must not get.
        # The two legacy fields stay on the model for existing databases but no
        # longer widen anything.

    # File upload: gated by the room setting for everyone except the owner,
    # and never available to guests.
    if member.is_guest:
        perms["can_upload_files"] = False
    elif member.role != Role.OWNER:
        perms["can_upload_files"] &= classroom.allow_file_upload

    if classroom.chat_disabled and member.role not in PRIVILEGED_ROLES:
        perms["can_send_messages"] = False

    # Moderator enforcement always wins over grants — except for the
    # OWNER, who is authoritative in their own classroom and can never be
    # silenced by a stale moderation flag.
    if member.muted and member.role != Role.OWNER:
        perms["can_use_microphone"] = False
    if member.camera_disabled and member.role != Role.OWNER:
        perms["can_use_camera"] = False

    return perms


def may_control_board(member: "ClassroomMember" | None, classroom: "Classroom") -> bool:
    """Opening/closing the board and changing its pages — authority only."""
    if not is_admitted(member, classroom):
        return False
    return is_authority(member)


def may_write_board(member: "ClassroomMember" | None, classroom: "Classroom", op: dict | None = None) -> bool:
    """May ``op`` put ink on the board?

    Layers, in order:

    1. the member must be admitted and hold ``can_use_whiteboard`` — a per-member
       grant (owner/moderator/presenter have it by role; a student only after
       the owner grants it by hand);
    2. page-structure operations (clear / add / delete page / move the class to
       another page / change the page background) need an AUTHORITY role, so a
       granted student can write but cannot reorganise the board;
    3. writing on shared material is still writing: a granted non-authority
       member may annotate the slide on screen only while the presenter has
       annotation open.  There is no "anybody may annotate" bypass any more.
    """
    if not is_admitted(member, classroom):
        return False
    if not effective_permissions(member, classroom)["can_use_whiteboard"]:
        return False
    op = op or {}
    if op.get("type") in BOARD_STRUCTURE_OPS:
        return is_authority(member)
    if op.get("file_id") is not None and not is_authority(member):
        return bool(classroom.annotation_open and classroom.current_file_id == op.get("file_id"))
    return True
