"""Business logic for classrooms — shared by views, consumers and API.

Keeping this layer separate means HTTP views stay thin and WebSocket
consumers reuse exactly the same rules (membership, passwords, roles).
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import transaction

from .models import Classroom, ClassroomMember
from .permissions import Role

User = get_user_model()


class ClassroomAccessError(Exception):
    """Raised when a user is not allowed to access/join a classroom."""


class WrongClassroomPassword(ClassroomAccessError):
    """Raised when the supplied classroom password is incorrect."""


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
    ClassroomMember.objects.create(
        classroom=classroom, user=owner, role=Role.OWNER, is_active=True
    )
    return classroom


def get_member(classroom: Classroom, user: User) -> ClassroomMember | None:
    """Return the membership row for a user (active or not), or ``None``."""
    return ClassroomMember.objects.filter(classroom=classroom, user=user).first()


def get_active_member(classroom: Classroom, user: User) -> ClassroomMember | None:
    """Return only an *active* membership, or ``None``."""
    return ClassroomMember.objects.filter(
        classroom=classroom, user=user, is_active=True
    ).first()


@transaction.atomic
def join_classroom(classroom: Classroom, user: User, raw_password: str = "") -> ClassroomMember:
    """Join (or re-activate membership in) a classroom.

    Raises ``WrongClassroomPassword`` when the classroom requires a
    password and the supplied one is wrong.  Password verification is
    always performed server-side.
    """
    if not classroom.is_active:
        raise ClassroomAccessError("این کلاس غیرفعال است.")
    if classroom.is_password_protected and not classroom.check_password(raw_password):
        raise WrongClassroomPassword("رمز کلاس اشتباه است.")

    member, _created = ClassroomMember.objects.update_or_create(
        classroom=classroom,
        user=user,
        defaults={"is_active": True},
    )
    return member


def leave_classroom(classroom: Classroom, user: User) -> None:
    """Mark a membership inactive (history is preserved)."""
    ClassroomMember.objects.filter(classroom=classroom, user=user).update(is_active=False)


def active_members(classroom: Classroom) -> list[ClassroomMember]:
    """All active members, ordered by role."""
    return list(
        ClassroomMember.objects.filter(classroom=classroom, is_active=True)
        .select_related("user")
        .order_by("role", "joined_at")
    )
