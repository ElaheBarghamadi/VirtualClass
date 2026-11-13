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


@register()
def hosts_before_traffic(app_configs, **kwargs) -> list[CheckWarning]:
    """Warn when a production deployment cannot answer for its own domain.

    ``ALLOWED_HOSTS`` defaults to the loopback names on purpose (fail closed),
    but a host that was never told its domain answers every request with a bare
    ``400 Bad Request`` — which reads like a broken deployment, not like a
    missing setting.
    """
    issues: list[CheckWarning] = []
    if settings.DEBUG:
        return issues
    public = [h for h in settings.ALLOWED_HOSTS if h not in _LOCAL_HOSTS]
    if not public:
        issues.append(CheckWarning(
            "DEBUG=false and ALLOWED_HOSTS has no public host name "
            f"({', '.join(settings.ALLOWED_HOSTS) or 'empty'}): every request "
            "will be answered with 400.",
            hint="Set ALLOWED_HOSTS=your-domain.example (comma separated, no "
                 "scheme, no wildcard). See .env.production.example.",
            id="deploy.W004",
        ))
    return issues


@register()
def csrf_origins_match_the_host(app_configs, **kwargs) -> list[CheckWarning]:
    """Warn when HTTPS form posts will be rejected by CSRF.

    With DEBUG off, Django only accepts a POST whose Origin header is in
    ``CSRF_TRUSTED_ORIGINS``.  Leaving it empty is the single most common
    "login does nothing / 403" report from a fresh host.
    """
    issues: list[CheckWarning] = []
    if settings.DEBUG or settings.CSRF_TRUSTED_ORIGINS:
        return issues
    issues.append(CheckWarning(
        "DEBUG=false and CSRF_TRUSTED_ORIGINS is empty: browsers post an "
        "https:// Origin, so every form (login first) will fail with 403.",
        hint="Set CSRF_TRUSTED_ORIGINS=https://your-domain.example (scheme + "
             "host, comma separated for several).",
        id="deploy.W005",
    ))
    return issues


@register()
def upload_directories_are_writable(app_configs, **kwargs) -> list[CheckWarning]:
    """Warn when the uploads' directories cannot be written.

    On a container platform MEDIA_ROOT has to be on the mounted volume; on a
    VPS the systemd user has to own it.  Either way the symptom is the same and
    only appears at the first upload — so check it at boot instead.
    """
    issues: list[CheckWarning] = []
    if settings.DEBUG:
        # Django creates the directory on the first write in development.
        return issues
    import tempfile

    for label, root in (
        ("MEDIA_ROOT", settings.MEDIA_ROOT),
        ("PRIVATE_MEDIA_ROOT", settings.PRIVATE_MEDIA_ROOT),
    ):
        path = os.path.abspath(str(root))
        if not os.path.isdir(path):
            issues.append(CheckWarning(
                f"{label} does not exist: {path}",
                hint="Create it (and put it on the persistent volume in a "
                     "container) before the first upload.",
                id="deploy.W006",
            ))
            continue
        try:
            with tempfile.NamedTemporaryFile(dir=path, prefix=".write-check-"):
                pass
        except OSError:
            issues.append(CheckWarning(
                f"{label} is not writable by this process: {path}",
                hint="Fix the owner/permissions of that directory (systemd "
                     "user, container user, or the mounted volume).",
                id="deploy.W006",
            ))
    return issues


@register()
def https_redirect_without_a_proxy_header(app_configs, **kwargs) -> list[CheckWarning]:
    """Warn about the redirect loop behind a TLS-terminating proxy.

    ``SECURE_SSL_REDIRECT`` asks Django to send HTTP to HTTPS.  When the proxy
    terminates TLS, Django sees plain HTTP for *every* request and keeps
    redirecting — an infinite loop that looks like the site is down.
    """
    issues: list[CheckWarning] = []
    if settings.DEBUG or not getattr(settings, "SECURE_SSL_REDIRECT", False):
        return issues
    if getattr(settings, "SECURE_PROXY_SSL_HEADER", None):
        return issues
    issues.append(CheckWarning(
        "SECURE_SSL_REDIRECT is on but SECURE_PROXY_SSL_HEADER is not: behind "
        "a proxy that terminates TLS every request looks like HTTP, so "
        "Django redirects in a loop.",
        hint="Set TRUST_X_FORWARDED_PROTO=true when a proxy/edge forwards "
             "X-Forwarded-Proto: https, or set SECURE_SSL_REDIRECT=false when "
             "the app itself is reachable over plain HTTP.",
        id="deploy.W007",
    ))
    return issues
