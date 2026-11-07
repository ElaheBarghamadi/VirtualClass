"""Settings for the automated test-suite.

``manage.py test`` selects this module automatically (see ``manage.py``), so a
developer who has ``REDIS_URL`` in their ``.env`` — the normal setup for
running a worker — still gets a hermetic suite:

* tasks run inline (eager), so a test never needs ``celery worker`` running;
* channel layer and cache are in-process, so tests never touch a real Redis.

Everything else is inherited unchanged from :mod:`config.settings`.
"""
from __future__ import annotations

from .settings import *  # noqa: F401,F403  (re-export the real settings)
from .settings import REDIS_URL as _REDIS_URL  # noqa: F401  (documented below)

# Redis is irrelevant for tests: no broker, no channel layer, no cache server.
CELERY_BROKER_URL = "memory://"
CELERY_RESULT_BACKEND = "cache+memory://"
CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = False
CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
# Keep the suite fast: no password hashing, no emails to a real SMTP server.
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
# The suite deliberately runs with DEBUG=false (that is what the test runner
# does) and without Redis, so "production without a broker" is expected here —
# core/tests_queue.py checks that warning directly instead.
SILENCED_SYSTEM_CHECKS = ["deploy.W002"]
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
