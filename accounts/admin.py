"""Admin configuration for users."""
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import User


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    list_display = ("username", "email", "first_name", "last_name", "is_staff", "is_active")
    search_fields = ("username", "email", "first_name", "last_name")
    list_filter = ("is_staff", "is_superuser", "is_active", "date_joined")
    fieldsets = DjangoUserAdmin.fieldsets + (
        ("اطلاعات نمایشی", {"fields": ("display_name",)}),
    )
