"""Whiteboard models — an event-sourced, operation-based design.

The board state is a **sequence of structured operations** (JSON), not
raster images: nothing binary is stored, replays are cheap, and the same
operations that sync live users are the ones persisted.  A ``clear``
operation compacts history (older rows are dropped), keeping the table
small.
"""
from django.conf import settings
from django.db import models


class Whiteboard(models.Model):
    """The (single, current) whiteboard of a classroom."""

    classroom = models.OneToOneField(
        "classrooms.Classroom",
        on_delete=models.CASCADE,
        related_name="whiteboard",
        verbose_name="کلاس",
    )
    updated_at = models.DateTimeField(auto_now=True, verbose_name="آخرین تغییر")

    class Meta:
        verbose_name = "تخته سفید"
        verbose_name_plural = "تخته‌های سفید"

    def __str__(self) -> str:
        return f"whiteboard:{self.classroom.room_code}"


class WhiteboardEvent(models.Model):
    """One drawing operation, e.g. ``{"tool": "pen", "points": [...]}``.

    Operation payloads are validated (type, size) by the consumer before
    being persisted here.
    """

    whiteboard = models.ForeignKey(
        Whiteboard, on_delete=models.CASCADE, related_name="events", verbose_name="تخته"
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="whiteboard_events",
        verbose_name="کاربر",
    )
    actor_identity = models.CharField(max_length=48, default="", verbose_name="شناسهٔ کاربر")
    operation = models.JSONField(verbose_name="عملیات")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="زمان")

    class Meta:
        verbose_name = "رویداد تخته"
        verbose_name_plural = "رویدادهای تخته"
        ordering = ("id",)
        indexes = [
            models.Index(fields=("whiteboard", "id"), name="wb_board_id_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.whiteboard_id}:{self.operation.get('type', '?')}"
