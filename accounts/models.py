"""User model.

A custom user model based on ``AbstractUser`` is used so extra profile
fields (avatar, bio, preferences, ...) can be added in future migrations
without the pain of switching ``AUTH_USER_MODEL`` later.
"""
from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Application user. Extend freely — profile data belongs here."""

    display_name = models.CharField(
        max_length=100,
        blank=True,
        verbose_name="نام نمایشی",
        help_text="اگر خالی باشد، نام کاربری نمایش داده می‌شود.",
    )

    class Meta:
        verbose_name = "کاربر"
        verbose_name_plural = "کاربران"

    def __str__(self) -> str:
        return self.name

    @property
    def name(self) -> str:
        """Best available human-readable name."""
        if self.display_name:
            return self.display_name
        full = f"{self.first_name} {self.last_name}".strip()
        return full or self.username
