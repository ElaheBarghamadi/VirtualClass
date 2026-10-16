"""Admin configuration for whiteboards (platform administrators only).

Boards are user content: previews are deliberately text-only (operations are
JSON), and the inline editor is capped so a huge board can never lock up the
admin.
"""
from django.contrib import admin
from django.utils.html import format_html

from .models import Whiteboard, WhiteboardEvent


class WhiteboardEventInline(admin.TabularInline):
    model = WhiteboardEvent
    extra = 0
    fields = ("seq", "kind", "page", "actor", "operation", "created_at")
    readonly_fields = ("seq", "kind", "page", "actor", "operation", "created_at")
    ordering = ("-seq",)
    max_num = 25
    can_delete = False

    def has_add_permission(self, request, obj=None):  # noqa: D102
        return False


@admin.register(Whiteboard)
class WhiteboardAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "classroom",
        "page_count",
        "revision",
        "compacted_before",
        "snapshot_seq",
        "updated_at",
    )
    list_filter = ("updated_at",)
    search_fields = ("classroom__title", "classroom__room_code")
    autocomplete_fields = ("classroom",)
    readonly_fields = ("revision", "compacted_before", "snapshot_seq", "created_at", "updated_at")
    inlines = (WhiteboardEventInline,)

    @admin.display(description="عملیات ذخیره‌شده")
    def stored_events(self, obj: Whiteboard) -> int:
        return obj.events.count()

    def page_summary(self, obj: Whiteboard) -> str:
        return format_html("{}", str(obj.page_styles()))


@admin.register(WhiteboardEvent)
class WhiteboardEventAdmin(admin.ModelAdmin):
    list_display = ("id", "whiteboard", "seq", "kind", "scope", "page", "actor", "created_at")
    list_filter = ("kind", "scope", "created_at")
    search_fields = ("whiteboard__classroom__room_code", "actor_identity")
    date_hierarchy = "created_at"
    ordering = ("-seq",)
    readonly_fields = ("whiteboard", "seq", "kind", "scope", "actor", "actor_identity", "operation", "page", "created_at")
