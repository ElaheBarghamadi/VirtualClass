"""Admin configuration — for platform administrators only.

Classroom owners manage their classrooms through the application UI,
not through Django Admin.
"""
from django.contrib import admin

from .models import AttendanceRecord, Classroom, ClassroomMember, ClassroomSession, SharedFile


class ClassroomMemberInline(admin.TabularInline):
    model = ClassroomMember
    extra = 0
    autocomplete_fields = ("user",)
    fields = ("user", "role", "is_active", "muted", "in_waiting_room", "joined_at")


class ClassroomSessionInline(admin.TabularInline):
    model = ClassroomSession
    extra = 0
    fields = ("title", "status", "host", "scheduled_start", "started_at", "ended_at")


@admin.register(Classroom)
class ClassroomAdmin(admin.ModelAdmin):
    list_display = ("title", "room_code", "owner", "is_password_protected", "is_locked", "is_active", "created_at")
    list_filter = ("is_active", "is_password_protected", "is_locked", "enable_waiting_room", "created_at")
    search_fields = ("title", "room_code", "owner__username", "owner__email")
    readonly_fields = ("room_code", "created_at", "updated_at")
    inlines = (ClassroomMemberInline, ClassroomSessionInline)
    fieldsets = (
        (None, {"fields": ("owner", "title", "description", "room_code", "is_active")}),
        ("دسترسی", {"fields": ("password", "is_password_protected", "is_locked", "enable_waiting_room")}),
        (
            "تنظیمات",
            {
                "fields": (
                    "allow_student_chat",
                    "allow_student_mic",
                    "allow_student_camera",
                    "allow_student_screen_share",
                    "allow_student_whiteboard",
                    "allow_file_upload",
                    "chat_disabled",
                )
            },
        ),
        ("ارائه", {"fields": ("current_file", "current_page")}),
        ("زمان‌ها", {"fields": ("created_at", "updated_at")}),
    )


@admin.register(ClassroomMember)
class ClassroomMemberAdmin(admin.ModelAdmin):
    list_display = ("user", "classroom", "role", "is_active", "muted", "in_waiting_room", "joined_at")
    list_filter = ("role", "is_active", "muted", "in_waiting_room")
    search_fields = ("user__username", "user__email", "classroom__title", "classroom__room_code")
    autocomplete_fields = ("user", "classroom")


@admin.register(ClassroomSession)
class ClassroomSessionAdmin(admin.ModelAdmin):
    list_display = ("id", "classroom", "title", "status", "host", "scheduled_start", "started_at", "ended_at")
    list_filter = ("status",)
    search_fields = ("classroom__room_code", "classroom__title", "title", "host__username")
    autocomplete_fields = ("classroom", "host")


@admin.register(AttendanceRecord)
class AttendanceRecordAdmin(admin.ModelAdmin):
    list_display = ("id", "session", "user", "joined_at", "left_at")
    list_filter = ("joined_at",)
    search_fields = ("user__username", "session__classroom__room_code")
    autocomplete_fields = ("user", "session")


@admin.register(SharedFile)
class SharedFileAdmin(admin.ModelAdmin):
    list_display = ("original_name", "classroom", "uploader", "size_display", "content_type", "uploaded_at")
    list_filter = ("uploaded_at", "content_type")
    search_fields = ("original_name", "classroom__room_code", "uploader__username")
    autocomplete_fields = ("classroom", "uploader")
