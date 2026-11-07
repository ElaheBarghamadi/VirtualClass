"""`manage.py deploy_check` — what this process is actually serving.

A deployment log is the only evidence you get when something is off; "the page
is white" or "the room is not connecting" says nothing about *why*.  This
command prints the handful of decisions that decide that, in the words of the
values that were loaded — no guessing from memory:

    python manage.py deploy_check          # full report
    python manage.py deploy_check --brief  # four lines, for the entrypoint

The entrypoint runs it before Daphne so every deployment log starts with the
database engine, the static-file count and the broker it will use; when a
platform quietly starts the app some other way, those lines are missing — which
is itself the diagnosis.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand


def _count_migrations() -> str:
    try:
        from django.db.migrations.executor import MigrationExecutor
        from django.db import connection

        executor = MigrationExecutor(connection)
        loader = executor.loader
        total = len(loader.disk_migrations)
        applied = len(executor.recorder.applied_migrations())
        return f"{applied}/{total} applied"
    except Exception:  # pragma: no cover - diagnostics must never crash
        return "unknown (database not initialised?)"


def _server_kind() -> str:
    """Guess the server from argv — enough to catch 'gunicorn behind our back'."""
    argv = " ".join(sys.argv).lower()
    if "daphne" in argv:
        return "asgi (daphne)"
    if "uvicorn" in argv or "hypercorn" in argv:
        return "asgi (uvicorn/hypercorn)"
    if "gunicorn" in argv:
        return "WSGI (gunicorn) — WebSockets will not work"
    if "runserver" in argv:
        return "runserver (development)"
    return "unknown"


class Command(BaseCommand):
    help = "Print the settings that decide how this deployment behaves."

    def add_arguments(self, parser):
        parser.add_argument(
            "--brief", action="store_true",
            help="Only the four lines that matter for a support log.",
        )

    def handle(self, *args, **options):
        db = settings.DATABASES["default"]
        engine = db["ENGINE"].rsplit(".", 1)[-1]
        sqlite = engine == "sqlite3"
        static_files = sum(1 for _ in Path(settings.STATIC_ROOT).rglob("*")) if Path(settings.STATIC_ROOT).is_dir() else 0

        lines = [
            f"server: {_server_kind()}",
            f"debug: {settings.DEBUG}",
            f"database: {engine}" + (" (wiped on redeploy in a container!)" if sqlite and not settings.DEBUG else ""),
            f"static: {static_files} files in {settings.STATIC_ROOT}"
            + ("" if static_files else "  ← run `manage.py collectstatic`"),
        ]

        wide = [
            ("server", _server_kind()),
            ("debug", str(settings.DEBUG)),
            ("secret_key", "set" if settings.SECRET_KEY and "insecure" not in settings.SECRET_KEY[:20] else "development default"),
            ("database", f"{engine} · {db.get('NAME')}"),
            ("migrations", _count_migrations()),
            ("allowed_hosts", ", ".join(settings.ALLOWED_HOSTS) or "-"),
            ("csrf_trusted_origins", ", ".join(settings.CSRF_TRUSTED_ORIGINS) or "-"),
            ("trust_x_forwarded_proto", str(getattr(settings, "SECURE_PROXY_SSL_HEADER", None) is not None)),
            ("static_root", f"{settings.STATIC_ROOT} ({static_files} files)"),
            ("media_root", str(settings.MEDIA_ROOT)),
            ("private_media_root", str(settings.PRIVATE_MEDIA_ROOT)),
            ("redis_url", "set" if getattr(settings, "REDIS_URL", "") else "empty (single process)"),
            ("celery_eager", str(getattr(settings, "CELERY_TASK_ALWAYS_EAGER", "-"))),
            ("media_server", getattr(settings, "MEDIA_SERVER_URL", "") or "not configured (mesh fallback)"),
            ("psycopg", "installed" if _psycopg() else "missing"),
        ]

        if options["brief"]:
            self.stdout.write("deploy_check: " + " | ".join(lines))
        else:
            width = max(len(key) for key, _ in wide)
            for key, value in wide:
                self.stdout.write(f"{key.ljust(width)}  {value}")
            self.stdout.write("")
            self.stdout.write("deploy_check: " + " | ".join(lines))

        if sqlite and not settings.DEBUG:
            self.stdout.write(self.style.WARNING(
                "SQLite without DEBUG: on a container platform this database is "
                "deleted by the next deploy. Link PostgreSQL (DATABASE_URL) or "
                "set ALLOW_SQLITE_IN_PRODUCTION=true on a long-lived host."
            ))
        if lines[0].startswith("server: WSGI") or "gunicorn" in lines[0]:
            self.stdout.write(self.style.ERROR(
                "A WSGI server is running: /ws/ cannot work, so the room, chat "
                "and whiteboard will fail. Start with `daphne -b 0.0.0.0 "
                "-p $PORT --proxy-headers config.asgi:application`."
            ))


def _psycopg() -> bool:
    try:
        import psycopg  # noqa: F401
    except Exception:
        return False
    return True
