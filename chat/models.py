"""Chat models.

Messages are persisted so history survives reconnects; real-time delivery
happens over WebSockets (see :mod:`chat.consumers`).
"""
from django.conf import settings
from django.db import models


class ChatMessage(models.Model):
    """A single classroom chat message."""

    classroom = models.ForeignKey(
        "classrooms.Classroom",
        on_delete=models.CASCADE,
        related_name="chat_messages",
        verbose_name="کلاس",
    )
    # Either a registered sender (``sender``) or a guest/registered member
    # (``sender_member``); the display name is denormalised so history
    # stays readable regardless of account state.
    sender = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="chat_messages",
        verbose_name="فرستنده",
    )
    sender_member = models.ForeignKey(
        "classrooms.ClassroomMember",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="chat_messages",
        verbose_name="عضو فرستنده",
    )
    sender_name = models.CharField(max_length=80, default="", verbose_name="نام فرستنده")
    sender_identity = models.CharField(max_length=48, default="", verbose_name="شناسهٔ فرستنده")
    message = models.TextField(verbose_name="متن پیام")
    # -- threads & channels ---------------------------------------------------
    reply_to = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="replies", verbose_name="پاسخ به",
    )
    # A private message never leaves the hosts (and, when a student wrote it,
    # that student).  ``audience_member`` is the one participant outside the
    # host team who may read it: the student it belongs to.
    is_private = models.BooleanField(default=False, db_index=True, verbose_name="خصوصی")
    audience_member = models.ForeignKey(
        "classrooms.ClassroomMember", null=True, blank=True,
        on_delete=models.SET_NULL, related_name="private_chat_messages",
        verbose_name="مخاطب",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="زمان ارسال")
    # Moderation: privileged users can soft-delete a message; the row is
    # kept so the audit trail (and future automated moderation) survives.
    is_deleted = models.BooleanField(default=False, verbose_name="حذف‌شده توسط مدیر")

    class Meta:
        verbose_name = "پیام گفتگو"
        verbose_name_plural = "پیام‌های گفتگو"
        ordering = ("created_at",)
        indexes = [
            models.Index(fields=("classroom", "created_at"), name="chat_class_created_idx"),
            models.Index(
                fields=("classroom", "is_private", "created_at"),
                name="chat_private_idx",
            ),
        ]

    def to_dict(self) -> dict:
        """JSON-safe representation sent over the WebSocket."""
        quoted = None
        parent = self.reply_to
        if parent is not None:
            quoted = {
                "id": parent.id,
                "sender_name": parent.sender_name or "?",
                "message": "" if parent.is_deleted else parent.message[:160],
                "is_deleted": parent.is_deleted,
            }
        return {
            "id": self.id,
            "sender_identity": self.sender_identity,
            "sender_name": self.sender_name or (self.sender.name if self.sender_id else "?"),
            "message": "" if self.is_deleted else self.message,
            "is_deleted": self.is_deleted,
            "created_at": self.created_at.isoformat(),
            "is_private": self.is_private,
            "reply_to": quoted,
        }

    def __str__(self) -> str:
        return f"{self.sender_name or self.sender_id} @ {self.classroom.room_code}: {self.message[:40]}"
