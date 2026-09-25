"""Admin configuration — for platform administrators only.

Classroom owners manage their classrooms through the application UI,
not through Django Admin.
"""
from django.contrib import admin

from .models import Classroom, ClassroomMember


class ClassroomMemberInline(admin.TabularInline):
    model = ClassroomMember
    extra = 0
    autocomplete_fields = ("user",)
    fields = ("user", "role", "is_active", "joined_at")


@admin.register(Classroom)
class ClassroomAdmin(admin.ModelAdmin):
    list_display = ("title", "room_code", "owner", "is_password_protected", "is_active", "created_at")
    list_filter = ("is_active", "is_password_protected", "created_at")
    search_fields = ("title", "room_code", "owner__username", "owner__email")
    readonly_fields = ("room_code", "created_at", "updated_at")
    inlines = (ClassroomMemberInline,)


@admin.register(ClassroomMember)
class ClassroomMemberAdmin(admin.ModelAdmin):
    list_display = ("user", "classroom", "role", "is_active", "joined_at")
    list_filter = ("role", "is_active")
    search_fields = ("user__username", "user__email", "classroom__title", "classroom__room_code")
    autocomplete_fields = ("user", "classroom")
