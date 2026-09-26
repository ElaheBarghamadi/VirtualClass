"""Classroom domain models.

Design notes
------------
* ``room_code`` is a cryptographically random public identifier — classroom
  URLs are never sequential/predictable.
* Classroom passwords are stored **hashed** using Django's password
  hashing utilities; the raw value is never persisted.
* ``ClassroomMember`` carries role + capability flags + live moderation
  state (muted, waiting room, hand raised, ban).
* ``ClassroomSession`` separates the permanent classroom from an actual
  live meeting; ``AttendanceRecord`` supports multiple joins/leaves.
* ``SharedFile`` stores uploads; validation lives in
  :mod:`classrooms.file_validation` (extension + magic-byte sniffing).
"""
from __future__ import annotations

import secrets
import uuid

from django.conf import settings
from django.contrib.auth.hashers import check_password, make_password
from django.db import models
from django.db.models.signals import post_delete
from django.dispatch import receiver
from django.utils import timezone

from .permissions import Role, apply_role_defaults, permission_fields

ROOM_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
ROOM_CODE_LENGTH = 11


def generate_room_code(length: int = ROOM_CODE_LENGTH) -> str:
    """Return a cryptographically secure random room code (e.g. ``a8K29xP7mQ2``)."""
    return "".join(secrets.choice(ROOM_CODE_ALPHABET) for _ in range(length))


def classroom_upload_path(instance: "SharedFile", filename: str) -> str:
    """Randomised upload path — the stored name never trusts the client."""
    return f"classrooms/{instance.classroom.room_code}/{uuid.uuid4().hex}_{filename}"


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
    room_code = models.CharField(max_length=32, unique=True, editable=False, db_index=True, verbose_name="کد کلاس")
    password = models.CharField(max_length=255, blank=True, null=True, verbose_name="رمز کلاس (هش‌شده)")
    is_password_protected = models.BooleanField(default=False, verbose_name="محافظت با رمز")
    is_active = models.BooleanField(default=True, verbose_name="فعال")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="تاریخ ایجاد")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="تاریخ به‌روزرسانی")

    # -- phase 2: room-wide settings (all server-enforced) ---------------------
    is_locked = models.BooleanField(default=False, verbose_name="کلاس قفل است")
    enable_waiting_room = models.BooleanField(default=False, verbose_name="اتاق انتظار")
    allow_student_chat = models.BooleanField(default=True, verbose_name="گفتگوی دانش‌آموز")
    allow_student_mic = models.BooleanField(default=True, verbose_name="میکروفون دانش‌آموز")
    allow_student_camera = models.BooleanField(default=True, verbose_name="دوربین دانش‌آموز")
    allow_student_screen_share = models.BooleanField(default=False, verbose_name="اشتراک صفحه دانش‌آموز")
    allow_student_whiteboard = models.BooleanField(default=False, verbose_name="تختهٔ دانش‌آموز")
    allow_file_upload = models.BooleanField(default=True, verbose_name="بارگذاری فایل (غیر مالک)")
    chat_disabled = models.BooleanField(default=False, verbose_name="قطع کامل گفتگو")

    # -- phase 3: customization & guest access ----------------------------------
    allow_guests = models.BooleanField(default=True, verbose_name="ورود مهمان با لینک")
    accent_color = models.CharField(max_length=7, blank=True, verbose_name="رنگ اصلی کلاس")
    welcome_message = models.TextField(blank=True, verbose_name="پیام خوش‌آمدگویی")
    logo = models.ImageField(upload_to="classroom_logos/", blank=True, null=True, verbose_name="لوگوی کلاس")
    show_chat_default = models.BooleanField(default=True, verbose_name="نمایش گفتگو به‌صورت پیش‌فرض")
    whiteboard_open = models.BooleanField(default=False, verbose_name="تختهٔ سفید باز است")

    # -- presentation state (synced over WebSocket) ----------------------------
    current_file = models.ForeignKey(
        "SharedFile",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
        verbose_name="فایل در حال ارائه",
    )
    current_page = models.PositiveIntegerField(default=1, verbose_name="صفحهٔ جاری")

    class Meta:
        verbose_name = "کلاس"
        verbose_name_plural = "کلاس‌ها"
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=("owner", "created_at"), name="cls_owner_created_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.title} ({self.room_code})"

    # -- password handling -----------------------------------------------------
    def set_password(self, raw_password: str | None) -> None:
        if raw_password:
            self.password = make_password(raw_password)
            self.is_password_protected = True
        else:
            self.password = None
            self.is_password_protected = False

    def check_password(self, raw_password: str) -> bool:
        if not self.is_password_protected:
            return True
        if not self.password or not raw_password:
            return False
        return check_password(raw_password, self.password)

    def save(self, *args, **kwargs) -> None:
        if not self.room_code:
            self.room_code = generate_room_code()
        super().save(*args, **kwargs)

    @property
    def active_member_count(self) -> int:
        return self.members.filter(is_active=True).count()


class ClassroomMember(models.Model):
    """A participant in a classroom: role, capabilities, live state.

    A member is either a **registered user** (``user`` set) or a **guest**
    (``is_guest`` + ``guest_uid`` + ``display_name``).  Guests get no
    permanent Django account; they are bound to the browser session that
    created them.  Everything else (roles, permission flags, moderation
    state, host controls) is shared between both kinds.
    """

    classroom = models.ForeignKey(Classroom, on_delete=models.CASCADE, related_name="members", verbose_name="کلاس")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="classroom_memberships",
        verbose_name="کاربر",
    )
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.STUDENT, verbose_name="نقش")
    joined_at = models.DateTimeField(default=timezone.now, verbose_name="زمان عضویت")
    is_active = models.BooleanField(default=True, verbose_name="عضویت فعال")

    # -- guest identity (never expose the internal pk to clients) ---------------
    is_guest = models.BooleanField(default=False, verbose_name="مهمان")
    guest_uid = models.CharField(max_length=32, null=True, blank=True, unique=True, verbose_name="شناسهٔ مهمان")
    guest_ip = models.GenericIPAddressField(null=True, blank=True, verbose_name="IP مهمان هنگام ورود")
    display_name = models.CharField(max_length=60, blank=True, verbose_name="نام نمایشی")

    # -- granular capabilities (server-side source of truth) --------------------
    can_use_microphone = models.BooleanField(default=True, verbose_name="اجازه میکروفون")
    can_use_camera = models.BooleanField(default=True, verbose_name="اجازه دوربین")
    can_share_screen = models.BooleanField(default=False, verbose_name="اجازه اشتراک صفحه")
    can_use_whiteboard = models.BooleanField(default=False, verbose_name="اجازه تخته سفید")
    can_send_messages = models.BooleanField(default=True, verbose_name="اجازه ارسال پیام")
    can_upload_files = models.BooleanField(default=False, verbose_name="اجازه بارگذاری فایل")
    can_raise_hand = models.BooleanField(default=True, verbose_name="اجازه بالا بردن دست")
    can_present = models.BooleanField(default=False, verbose_name="اجازه ارائه")

    # -- live moderation / presence state ---------------------------------------
    muted = models.BooleanField(default=False, verbose_name="بی‌صدا توسط مدیر")
    camera_disabled = models.BooleanField(default=False, verbose_name="دوربین غیرفعال توسط مدیر")
    in_waiting_room = models.BooleanField(default=False, verbose_name="در اتاق انتظار")
    hand_raised_at = models.DateTimeField(null=True, blank=True, verbose_name="زمان بالا بردن دست")
    banned_until = models.DateTimeField(null=True, blank=True, verbose_name="ممنوعیت تا")

    class Meta:
        verbose_name = "عضو کلاس"
        verbose_name_plural = "اعضای کلاس"
        constraints = [
            # One membership per registered user per classroom.  Guests are
            # unique by guest_uid instead (global unique index above).
            models.UniqueConstraint(
                fields=("classroom", "user"),
                condition=models.Q(user__isnull=False),
                name="unique_classroom_member",
            ),
        ]
        ordering = ("role", "joined_at")
        indexes = [
            models.Index(fields=("classroom", "is_active"), name="mbr_class_active_idx"),
            models.Index(fields=("classroom", "role"), name="mbr_class_role_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.participant_name} – {self.get_role_display()} @ {self.classroom.room_code}"

    def save(self, *args, **kwargs) -> None:
        if self._state.adding:
            apply_role_defaults(self)
            if self.is_guest and not self.guest_uid:
                self.guest_uid = secrets.token_urlsafe(16)
        super().save(*args, **kwargs)

    # -- identity helpers ---------------------------------------------------------
    @property
    def participant_name(self) -> str:
        """Display name: explicit override → account name → guest label."""
        if self.display_name:
            return self.display_name
        if self.user_id:
            return self.user.name
        return "مهمان"

    @property
    def identity(self) -> str:
        """Stable public identity for clients (never the database pk)."""
        return f"g:{self.guest_uid}" if self.is_guest else f"u:{self.user_id}"

    def permissions_dict(self) -> dict[str, bool]:
        """Serialisable view of this member's stored capability flags."""
        return {field: getattr(self, field) for field in permission_fields()}


class ClassroomSession(models.Model):
    """One live meeting inside a permanent classroom."""

    class Status(models.TextChoices):
        SCHEDULED = "SCHEDULED", "زمان‌بندی‌شده"
        LIVE = "LIVE", "در حال برگزاری"
        ENDED = "ENDED", "پایان‌یافته"

    classroom = models.ForeignKey(Classroom, on_delete=models.CASCADE, related_name="sessions", verbose_name="کلاس")
    host = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="hosted_sessions", verbose_name="میزبان"
    )
    title = models.CharField(max_length=200, blank=True, verbose_name="عنوان جلسه")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.SCHEDULED, verbose_name="وضعیت")
    timezone_name = models.CharField(max_length=64, default="UTC", verbose_name="منطقهٔ زمانی")
    scheduled_start = models.DateTimeField(null=True, blank=True, verbose_name="شروع برنامه‌ریزی‌شده")
    scheduled_end = models.DateTimeField(null=True, blank=True, verbose_name="پایان برنامه‌ریزی‌شده")
    started_at = models.DateTimeField(null=True, blank=True, verbose_name="زمان شروع")
    ended_at = models.DateTimeField(null=True, blank=True, verbose_name="زمان پایان")

    class Meta:
        verbose_name = "جلسه"
        verbose_name_plural = "جلسه‌ها"
        ordering = ("-scheduled_start", "-id")
        indexes = [
            models.Index(fields=("classroom", "status"), name="sess_class_status_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.classroom.room_code} – {self.get_status_display()}"

    @property
    def duration_seconds(self) -> int | None:
        if self.started_at and self.ended_at:
            return int((self.ended_at - self.started_at).total_seconds())
        return None


class AttendanceRecord(models.Model):
    """One join→leave interval for a user within a session.

    Multiple rows per user/session are expected (reconnects, re-joins).
    """

    session = models.ForeignKey(ClassroomSession, on_delete=models.CASCADE, related_name="attendance", verbose_name="جلسه")
    member = models.ForeignKey(ClassroomMember, on_delete=models.CASCADE, related_name="attendance", verbose_name="عضو")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="attendance_records",
        verbose_name="کاربر",
    )
    joined_at = models.DateTimeField(default=timezone.now, db_index=True, verbose_name="زمان ورود")
    left_at = models.DateTimeField(null=True, blank=True, verbose_name="زمان خروج")

    class Meta:
        verbose_name = "رکورد حضور"
        verbose_name_plural = "رکوردهای حضور"
        ordering = ("joined_at",)
        indexes = [
            models.Index(fields=("session", "user"), name="att_session_user_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.user_id} @ session {self.session_id}"

    @property
    def duration_seconds(self) -> int | None:
        end = self.left_at or timezone.now()
        return int((end - self.joined_at).total_seconds())


class SharedFile(models.Model):
    """A file shared inside a classroom (uploads validated server-side)."""

    classroom = models.ForeignKey(Classroom, on_delete=models.CASCADE, related_name="files", verbose_name="کلاس")
    session = models.ForeignKey(
        ClassroomSession, null=True, blank=True, on_delete=models.SET_NULL, related_name="files", verbose_name="جلسه"
    )
    uploader = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="uploaded_files", verbose_name="بارگذار"
    )
    file = models.FileField(upload_to=classroom_upload_path, verbose_name="فایل")
    # Server-side PDF conversion (LibreOffice) so Office documents can be
    # presented in the browser; empty when conversion is unavailable.
    pdf_version = models.FileField(upload_to=classroom_upload_path, null=True, blank=True,
                                   verbose_name="نسخهٔ PDF")
    original_name = models.CharField(max_length=255, verbose_name="نام اصلی")
    size = models.PositiveBigIntegerField(verbose_name="اندازه (بایت)")
    content_type = models.CharField(max_length=128, verbose_name="نوع محتوا")
    uploaded_at = models.DateTimeField(auto_now_add=True, verbose_name="زمان بارگذاری")

    class Meta:
        verbose_name = "فایل اشتراکی"
        verbose_name_plural = "فایل‌های اشتراکی"
        ordering = ("-uploaded_at",)
        indexes = [
            models.Index(fields=("classroom", "uploaded_at"), name="file_class_uploaded_idx"),
        ]

    def __str__(self) -> str:
        return self.original_name

    @property
    def size_display(self) -> str:
        size = float(self.size)
        for unit in ("B", "KB", "MB", "GB"):
            if size < 1024 or unit == "GB":
                return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
            size /= 1024
        return f"{size:.1f} GB"

    @property
    def type_icon(self) -> str:
        """Human-friendly glyph per format, used by the files panel."""
        ext = self.original_name.rsplit(".", 1)[-1].lower() if "." in self.original_name else ""
        return {
            "pdf": "📄", "png": "🖼️", "jpg": "🖼️", "jpeg": "🖼️",
            "docx": "📝", "pptx": "📽️", "xlsx": "📊", "zip": "📦",
        }.get(ext, "📎")


# ---------------------------------------------------------------------------
# Storage hygiene — whenever a SharedFile row goes away (UI delete, admin,
# or classroom cascade) the physical file leaves storage too.  Django never
# deletes FileField content by itself.
# ---------------------------------------------------------------------------
@receiver(post_delete, sender=SharedFile)
def _remove_shared_file_from_storage(sender, instance: SharedFile, **kwargs) -> None:
    try:
        instance.file.delete(save=False)
    except Exception:  # storage hiccup must not break the delete itself
        pass
