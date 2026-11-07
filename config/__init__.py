"""Project configuration package.

Importing the Celery app here is the documented Django+Celery convention: it
guarantees the app object exists (and is bound to the settings module) before
any ``@shared_task`` is imported, so ``celery -A config worker|beat`` and any
code path that imports a task agree on the same instance.
"""
from __future__ import annotations

from .celery import app as celery_app

__all__ = ("celery_app",)
