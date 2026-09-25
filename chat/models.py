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
    sender = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="chat_messages",
        verbose_name="فرستنده",
    )
    message = models.TextField(verbose_name="متن پیام")
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
        ]

    def __str__(self) -> str:
        return f"{self.sender} @ {self.classroom.room_code}: {self.message[:40]}"

    def to_dict(self) -> dict:
        """JSON-safe representation sent over the WebSocket."""
        return {
            "id": self.id,
            "sender_id": self.sender_id,
            "sender_name": self.sender.name,
            "message": "" if self.is_deleted else self.message,
            "is_deleted": self.is_deleted,
            "created_at": self.created_at.isoformat(),
        }
