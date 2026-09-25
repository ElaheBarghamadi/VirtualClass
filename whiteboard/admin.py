"""Admin configuration for whiteboards (platform administrators only)."""
from django.contrib import admin

from .models import Whiteboard, WhiteboardEvent


class WhiteboardEventInline(admin.TabularInline):
    model = WhiteboardEvent
    extra = 0
    fields = ("actor", "operation", "created_at")
    readonly_fields = ("created_at",)
    max_num = 20


@admin.register(Whiteboard)
class WhiteboardAdmin(admin.ModelAdmin):
    list_display = ("id", "classroom", "updated_at")
    search_fields = ("classroom__title", "classroom__room_code")
    autocomplete_fields = ("classroom",)
    inlines = (WhiteboardEventInline,)


@admin.register(WhiteboardEvent)
class WhiteboardEventAdmin(admin.ModelAdmin):
    list_display = ("id", "whiteboard", "actor", "created_at")
    list_filter = ("created_at",)
    search_fields = ("whiteboard__classroom__room_code",)
