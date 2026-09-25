"""Admin configuration for chat messages."""
from django.contrib import admin

from .models import ChatMessage


@admin.register(ChatMessage)
class ChatMessageAdmin(admin.ModelAdmin):
    list_display = ("sender", "classroom", "short_message", "created_at")
    list_filter = ("created_at", "classroom")
    search_fields = ("message", "sender__username", "classroom__room_code", "classroom__title")
    autocomplete_fields = ("sender", "classroom")
    date_hierarchy = "created_at"

    @admin.display(description="پیام")
    def short_message(self, obj: ChatMessage) -> str:
        return obj.message[:60]
