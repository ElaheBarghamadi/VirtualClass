"""Classroom and membership models.

Design notes
------------
* ``room_code`` is a cryptographically random public identifier — classroom
  URLs are never sequential/predictable.
* Classroom passwords are stored **hashed** using Django's password
  hashing utilities; the raw value is never persisted.
* ``ClassroomMember`` carries both a role and per-member capability
  flags.  Role-based defaults come from :mod:`classrooms.permissions`,
  so nothing is hard-coded in views/consumers.
"""
from __future__ import annotations

import secrets

from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.db import models
from django.utils import timezone

from .permissions import Role, apply_role_defaults, permission_fields

ROOM_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
ROOM_CODE_LENGTH = 11


def generate_room_code(length: int = ROOM_CODE_LENGTH) -> str:
    """Return a cryptographically secure random room code (e.g. ``a8K29xP7mQ2``)."""
    return "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(length))


class Classroom(models.Model):
    """A virtual classroom identified by a unique, unguessable room code."""

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="owned_classrooms",
        verbose_name="مالک کلاس",
    )
    title = models.CharField(max_length=200, verbose_name="عنوان کلاس")
    description = models.TextField(blank=True, verbose_name="توضیحات")
    room_code = models.CharField(
        max_length=32,
        unique=True,
        editable=False,
        db_index=True,
        verbose_name="کد کلاس",
    )
    password = models.CharField(
        max_length=255,
        blank=True,
        null=True,
        verbose_name="رمز کلاس (هش‌شده)",
    )
    is_password_protected = models.BooleanField(default=False, verbose_name="محافظت با رمز")
    is_active = models.BooleanField(default=True, verbose_name="فعال")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="تاریخ ایجاد")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="تاریخ به‌روزرسانی")

    class Meta:
        verbose_name = "کلاس"
        verbose_name_plural = "کلاس‌ها"
        ordering = ("-created_at",)

    def __str__(self) -> str:
        return f"{self.title} ({self.room_code})"

    # -- password handling ---------------------------------------------------
    def set_password(self, raw_password: str | None) -> None:
        """Hash and store the classroom password (or clear it)."""
        if raw_password:
            self.password = make_password(raw_password)
            self.is_password_protected = True
        else:
            self.password = None
            self.is_password_protected = False

    def check_password(self, raw_password: str) -> bool:
        """Verify a raw password against the stored hash."""
        if not self.is_password_protected:
            return True
        if not self.password or not raw_password:
            return False
        return check_password(raw_password, self.password)

    def save(self, *args, **kwargs) -> None:
        if not self.room_code:
            self.room_code = generate_room_code()
        super().save(*args, **kwargs)

    # -- helpers --------------------------------------------------------------
    @property
    def active_member_count(self) -> int:
        return self.members.filter(is_active=True).count()


class ClassroomMember(models.Model):
    """A user's membership in a classroom, with role + capability flags."""

    classroom = models.ForeignKey(
        Classroom,
        on_delete=models.CASCADE,
        related_name="members",
        verbose_name="کلاس",
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="classroom_memberships",
        verbose_name="کاربر",
    )
    role = models.CharField(
        max_length=20,
        choices=Role.choices,
        default=Role.STUDENT,
        verbose_name="نقش",
    )
    joined_at = models.DateTimeField(default=timezone.now, verbose_name="زمان عضویت")
    is_active = models.BooleanField(default=True, verbose_name="عضویت فعال")

    # -- granular capabilities (server-side source of truth) ------------------
    can_use_microphone = models.BooleanField(default=True, verbose_name="اجازه استفاده از میکروفون")
    can_use_camera = models.BooleanField(default=True, verbose_name="اجازه استفاده از دوربین")
    can_share_screen = models.BooleanField(default=False, verbose_name="اجازه اشتراک صفحه")
    can_use_whiteboard = models.BooleanField(default=False, verbose_name="اجازه استفاده از تخته سفید")
    can_send_messages = models.BooleanField(default=True, verbose_name="اجازه ارسال پیام")
    can_upload_files = models.BooleanField(default=False, verbose_name="اجازه بارگذاری فایل")
    can_raise_hand = models.BooleanField(default=True, verbose_name="اجازه بالا بردن دست")

    class Meta:
        verbose_name = "عضو کلاس"
        verbose_name_plural = "اعضای کلاس"
        constraints = [
            models.UniqueConstraint(
                fields=("classroom", "user"), name="unique_classroom_member"
            ),
        ]
        ordering = ("role", "joined_at")

    def __str__(self) -> str:
        return f"{self.user} – {self.get_role_display()} @ {self.classroom.room_code}"

    def save(self, *args, **kwargs) -> None:
        # New memberships receive sensible defaults for their role.
        if self._state.adding:
            apply_role_defaults(self)
        super().save(*args, **kwargs)

    def permissions_dict(self) -> dict[str, bool]:
        """Serialisable view of this member's capability flags."""
        return {field: getattr(self, field) for field in permission_fields()}
