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
