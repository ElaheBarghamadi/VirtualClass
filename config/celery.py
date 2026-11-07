"""The Celery application.

Started by::

    celery -A config worker -l info     # executes jobs
    celery -A config beat -l info       # enqueues the periodic ones

Nothing project-specific lives here on purpose: every ``CELERY_*`` setting is
read from ``config/settings.py`` (``namespace="CELERY"``), so all queue
configuration sits next to the ``REDIS_URL`` it is derived from, and tasks are
discovered automatically from each installed app's ``tasks.py``.
"""
from __future__ import annotations

import os

from celery import Celery

# Workers and beat are plain Python processes without manage.py, so they need
# the settings module spelled out before anything imports Django.
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

app = Celery("virtualclass")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()
