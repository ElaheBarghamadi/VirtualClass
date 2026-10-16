"""Whiteboard data model.

The board is stored as an **ordered log of operations** (``WhiteboardEvent``)
plus a small amount of board level metadata (page count, per page background,
compaction watermark).  Rendering happens in the browser, so the database only
ever holds JSON — no images, no canvas snapshots, no binary blobs.

* ``revision`` is a strictly increasing sequence number handed out to every
  stored operation.  It survives ``clear`` (unlike the row ids of the old
  design), which makes incremental reconnect/resync exact.
* ``compacted_before`` remembers the newest sequence dropped by a ``clear`` so
  a client that has been away too long is told to replay from scratch.
"""
from __future__ import annotations

from django.conf import settings
from django.db import models

from .protocol import MAX_PAGES, VALID_GRIDS

DEFAULT_PAGE_STYLE: dict = {"color": "#ffffff", "grid": "none"}


class Whiteboard(models.Model):
    """The (single, current) whiteboard of a classroom."""

    classroom = models.OneToOneField(
        "classrooms.Classroom",
        on_delete=models.CASCADE,
        related_name="whiteboard",
        verbose_name="کلاس",
    )
    page_count = models.PositiveIntegerField(default=1, verbose_name="تعداد صفحه")
    pages = models.JSONField(default=dict, blank=True, verbose_name="تنظیمات صفحه‌ها")
    revision = models.BigIntegerField(default=0, verbose_name="شمارهٔ آخرین عملیات")
    compacted_before = models.BigIntegerField(default=0, verbose_name="کوتاه‌سازی تا شماره")
    #: Flattened copy of the board published by a fully synced client, and the
    #: sequence it represents.  Lets the server drop log rows without ever
    #: losing what is drawn on the board.
    snapshot_ops = models.JSONField(default=list, blank=True, verbose_name="تصویر فشرده")
    snapshot_seq = models.BigIntegerField(default=0, verbose_name="شمارهٔ تصویر فشرده")
    created_at = models.DateTimeField(auto_now_add=True, null=True, verbose_name="ساخته‌شده")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="آخرین تغییر")

    class Meta:
        verbose_name = "تخته سفید"
        verbose_name_plural = "تخته‌های سفید"

    def __str__(self) -> str:
        return f"whiteboard:{self.classroom_id}"

    # -- page helpers ------------------------------------------------------- #
    def page_style(self, page: int) -> dict:
        """Background/settings of one page (always returns a full dict)."""
        style = (self.pages or {}).get(str(page)) or {}
        merged = dict(DEFAULT_PAGE_STYLE)
        color = style.get("color")
        if isinstance(color, str):
            merged["color"] = color
        grid = style.get("grid")
        if isinstance(grid, str) and grid in VALID_GRIDS:
            merged["grid"] = grid
        return merged

    def page_styles(self) -> dict[int, dict]:
        return {page: self.page_style(page) for page in range(1, self.page_count + 1)}

    def set_page_style(self, page: int, **changes) -> None:
        styles = dict(self.pages or {})
        current = dict(styles.get(str(page)) or {})
        current.update({key: value for key, value in changes.items() if value is not None})
        styles[str(page)] = current
        self.pages = styles

    def shift_pages(self, start: int, delta: int) -> None:
        """Renumber the background entries of every page >= ``start``.

        ``page_count`` is *not* touched here: the caller decides what the new
        page count is (an insert and a delete move it differently).
        """
        styles = {}
        for key, value in (self.pages or {}).items():
            try:
                page = int(key)
            except (TypeError, ValueError):
                continue
            shifted = page + delta if page >= start else page
            if 1 <= shifted <= MAX_PAGES:
                styles[str(shifted)] = value
        self.pages = styles


class WhiteboardEvent(models.Model):
    """One stored operation of the board log."""

    class Scope(models.TextChoices):
        BOARD = "board", "تخته"
        FILE = "file", "ارائه"

    whiteboard = models.ForeignKey(
        Whiteboard, on_delete=models.CASCADE, related_name="events", verbose_name="تخته"
    )
    seq = models.BigIntegerField(default=0, db_index=True, verbose_name="ترتیب")
    kind = models.CharField(max_length=24, default="", db_index=True, verbose_name="نوع")
    scope = models.CharField(
        max_length=8, choices=Scope.choices, default=Scope.BOARD, verbose_name="دامنه"
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
    page = models.PositiveIntegerField(default=1, db_index=True, verbose_name="صفحه")
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="زمان")

    class Meta:
        verbose_name = "رویداد تخته"
        verbose_name_plural = "رویدادهای تخته"
        ordering = ("seq", "id")
        constraints = [
            models.UniqueConstraint(fields=("whiteboard", "seq"), name="wb_event_seq_unique"),
        ]
        indexes = [
            models.Index(fields=("whiteboard", "seq"), name="wb_board_seq_idx"),
            models.Index(fields=("whiteboard", "page", "seq"), name="wb_board_page_seq_idx"),
        ]

    def __str__(self) -> str:
        return f"{self.whiteboard_id}@{self.seq}:{self.kind}"
