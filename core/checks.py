"""Deployment-safety system checks (``manage.py check``).

Complement the fail-fast guard in settings: settings refuses to boot in
production without a real SECRET_KEY; these checks warn about the risky
*configurations* that are still legal — like DEBUG on a public host.
"""
from __future__ import annotations

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
