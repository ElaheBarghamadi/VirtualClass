"""Deployment-safety system checks (``manage.py check``).

Complement the fail-fast guard in settings: settings refuses to boot in
production without a real SECRET_KEY; these checks warn about the risky
*configurations* that are still legal — like DEBUG on a public host.
"""
from __future__ import annotations

import os

from django.conf import settings
from django.core.checks import Warning as CheckWarning
from django.core.checks import register

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1", "testserver"}


@register()
def deploy_configuration(app_configs, **kwargs) -> list[CheckWarning]:
    """Warn when DEBUG is on while ALLOWED_HOSTS accepts public traffic."""
    issues: list[CheckWarning] = []
    public = [h for h in settings.ALLOWED_HOSTS if h not in _LOCAL_HOSTS and h != "*"]
    if settings.DEBUG and public:
        issues.append(CheckWarning(
            "DEBUG=True while ALLOWED_HOSTS contains non-local hosts "
            f"({', '.join(public)}).",
            hint="Set DEBUG=false and configure SECRET_KEY / HTTPS settings "
                 "before serving real traffic. See .env.example.",
            id="deploy.W001",
        ))
    return issues


@register()
def queue_configuration(app_configs, **kwargs) -> list[CheckWarning]:
    """Warn when a production deployment has no broker to share.

    Without ``REDIS_URL`` every web process builds its own in-memory channel
    layer (a socket event reaches only the process that sent it) and Celery
    runs jobs inline.  That is perfect for development and wrong for a real
    deployment, so say so instead of letting it be discovered in class.
    """
    issues: list[CheckWarning] = []
    if not settings.DEBUG and not getattr(settings, "REDIS_URL", ""):
        issues.append(CheckWarning(
            "REDIS_URL is empty while DEBUG=false: WebSocket events and "
            "background jobs stay inside one process.",
            hint="Run Redis and set REDIS_URL=redis://127.0.0.1:6379/0, then "
                 "start `celery -A config worker`. See README §۳.",
            id="deploy.W002",
        ))
    return issues


@register()
def database_is_not_ephemeral(app_configs, **kwargs) -> list[CheckWarning]:
    """Warn when a production deployment keeps its data in the container.

    A container's filesystem is replaced on every deploy (and on every restart
    on most platforms), so SQLite there means the schema and every user are
    gone the next morning — visible as ``no such table: accounts_user`` the
    first time someone registers.
    """
    issues: list[CheckWarning] = []
    if settings.DEBUG:
        return issues
    engine = settings.DATABASES.get("default", {}).get("ENGINE", "")
    allow_sqlite = os.environ.get("ALLOW_SQLITE_IN_PRODUCTION", "").lower() in {
        "1", "true", "yes", "on",
    }
    if engine.endswith("sqlite3") and not allow_sqlite:
        issues.append(CheckWarning(
            "DEBUG=false with the SQLite database: a container's filesystem is "
            "wiped on redeploy, so accounts and classrooms disappear.",
            hint="Link a PostgreSQL database (DATABASE_URL=postgres://…) or set "
                 "ALLOW_SQLITE_IN_PRODUCTION=true on a single long-lived host. "
                 "See deploy/DEPLOY.md.",
            id="deploy.W003",
        ))
    return issues
