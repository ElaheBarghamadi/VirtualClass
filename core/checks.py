"""Deployment-safety system checks (``manage.py check``).

The settings module boots on defaults on purpose (no environment variable is
required), so the job here is to *say out loud* what those defaults give up —
an open host list, cookies that are not ``Secure``, SQLite inside a container —
instead of failing the boot.  Warnings are greppable in a deployment log; a
traceback is not.
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
    if not getattr(settings, "HTTPS_IN_USE", False):
        # A deployment that does not claim TLS is served over http: the browser's
        # Origin is http too, same-origin matches, nothing to configure.
        return issues
    if not getattr(settings, "SECURE_PROXY_SSL_HEADER", None):
        # ...and with no way to learn the real scheme, https Origins can never
        # match the http request Django sees: a 403 on every form, login first.
        issues.append(CheckWarning(
            "HTTPS is in use but the app cannot see it (SECURE_PROXY_SSL_HEADER "
            "is off) and CSRF_TRUSTED_ORIGINS is empty: every form, login first, "
            "will be rejected with 403.",
            hint="Set TRUST_X_FORWARDED_PROTO=true when the proxy forwards "
                 "X-Forwarded-Proto, and/or CSRF_TRUSTED_ORIGINS="
                 "https://your-domain.example.",
            id="deploy.W005",
        ))
        return issues
    issues.append(CheckWarning(
        "HTTPS is in use and CSRF_TRUSTED_ORIGINS is empty: form posts are "
        "accepted only while the proxy reports the original scheme.",
        hint="Set CSRF_TRUSTED_ORIGINS=https://your-domain.example (scheme + "
             "host, comma separated for several) — or PUBLIC_URL to the "
             "deployed address, which adds it automatically.",
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


@register()
def media_can_reach_both_sides(app_configs, **kwargs) -> list[CheckWarning]:
    """Warn when live media has no path that survives a strict NAT.

    Two classmates on the same Wi-Fi connect directly and everything looks
    perfect; the same two on mobile networks sit behind carrier-grade NAT, ICE
    finds no path, and the camera "turns on" for nobody.  LiveKit relays through
    an SFU and a TURN entry relays peer-to-peer traffic — without one of them a
    production room is a coin flip, so say so at boot instead of in class.
    """
    issues: list[CheckWarning] = []
    if settings.DEBUG:
        return issues
    if getattr(settings, "MEDIA_SERVER_URL", ""):
        return issues
    if not getattr(settings, "MESH_ENABLED", False):
        # No SFU *and* no mesh: the room has no media at all.  Louder than a
        # missing relay, and a different fix.
        issues.append(CheckWarning(
            "No media path: MEDIA_SERVER_URL is empty and MESH_ENABLED is off, "
            "so camera/microphone are disabled in every room.",
            hint="Configure LiveKit (MEDIA_SERVER_URL/API_KEY/SECRET) or set "
                 "MESH_ENABLED=1. See deploy/DEPLOY.md §۵.",
            id="deploy.W009",
        ))
        return issues
    ice = getattr(settings, "WEBRTC_ICE_SERVERS", []) or []
    has_turn = any(
        str(url).startswith("turn")
        for server in ice
        for url in ([server.get("urls")] if isinstance(server.get("urls"), str) else server.get("urls") or [])
    )
    if not has_turn:
        issues.append(CheckWarning(
            "P2P media has no TURN relay (WEBRTC_ICE_SERVERS is empty or STUN "
            "only): peers behind strict NAT/CGNAT will not see or hear each "
            "other — the local camera preview still works, which makes it look "
            "like a bug in the app.",
            hint="Run coturn (deploy/coturn/) and list it in WEBRTC_ICE_SERVERS, "
                 "or configure LiveKit. See deploy/DEPLOY.md §۵.",
            id="deploy.W008",
        ))
    return issues


@register()
def database_has_a_schema(app_configs, **kwargs) -> list[CheckWarning]:
    """Warn when the database this process is connected to has no migrations.

    ``deploy.W003`` talks about SQLite being *ephemeral*; this one is about the
    database in front of us being **empty**, which is what a container that
    started without running ``migrate`` looks like.  It fires regardless of
    DEBUG, because the symptom (``no such table: classrooms_classroom``) is not
    a development-only problem.
    """
    issues: list[CheckWarning] = []
    try:
        from django.db import connections
        from django.db.migrations.recorder import MigrationRecorder

        connection = connections["default"]
        recorder = MigrationRecorder(connection)
        if not recorder.has_table():
            issues.append(CheckWarning(
                "The database has no migrations table: this deployment has never "
                "run `migrate`, so every page that touches the database fails "
                "with “no such table”.",
                hint="Run `python manage.py migrate --noinput` (the container "
                     "entrypoint does it on boot; a platform that overrides the "
                     "start command skips it). On a container platform also link "
                     "DATABASE_URL so the schema survives the next deploy.",
                id="deploy.W010",
            ))
            return issues
        if not recorder.applied_migrations():
            issues.append(CheckWarning(
                "The database is empty: migrations table exists but no migration "
                "has been applied.",
                hint="Run `python manage.py migrate --noinput`.",
                id="deploy.W010",
            ))
    except Exception:  # pragma: no cover - diagnostics must never crash
        return issues
    return issues


def _looks_public(host: str) -> bool:
    """True for a name a browser could actually type (not localhost/LAN)."""
    name = host.strip().lower().lstrip(".")
    if not name or name == "*":
        return False
    if name in {"localhost", "0.0.0.0", "[::1]", "::1"}:
        return False
    if name.startswith(("127.", "10.", "192.168.", "169.254.")):
        return False
    if name.endswith((".local", ".internal", ".localdomain")):
        return False
    return "." in name  # a real DNS name, not a bare container name


@register()
def allowed_hosts_cover_the_public_domain(app_configs, **kwargs) -> list[CheckWarning]:
    """Warn when production accepts no public host name at all.

    ``DisallowedHost: Invalid HTTP_HOST header: 'class.example.com'`` is the
    first thing a new domain hits, and it is silent until someone opens the site.
    This catches the shape of the mistake — DEBUG off, and every name in
    ``ALLOWED_HOSTS`` is localhost or a LAN address — before the first visitor.
    """
    if settings.DEBUG:
        return []
    hosts = [h for h in (getattr(settings, "ALLOWED_HOSTS", []) or []) if h]
    if not hosts or "*" in hosts:
        return []
    if any(_looks_public(h) for h in hosts):
        return []
    issue = CheckWarning(
        "No public host name is allowed: ALLOWED_HOSTS only lists "
        f"{', '.join(hosts)}. A browser opening the deployed domain gets "
        "“DisallowedHost … You may need to add …”. ",
        hint="Set ALLOWED_HOSTS to the domain the site is opened on, e.g. "
             "ALLOWED_HOSTS=class.example.com (comma-separated; `.example.com` "
             "accepts every subdomain), then redeploy. Setting PUBLIC_URL / "
             "APP_URL to that address also adds it automatically.",
        id="deploy.W011",
    )
    return [issue]


@register()
def hosts_are_open(app_configs, **kwargs) -> list[CheckWarning]:
    """Say that production is accepting any Host header.

    The zero-config default exists so a fresh server answers on whatever name it
    is reached by.  It is also the one default with a security cost: Host
    validation is what keeps password-reset links, cache keys and absolute URLs
    bound to *our* domain.  Report it once, at boot, with the one-line fix.
    """
    issues: list[CheckWarning] = []
    if settings.DEBUG or not getattr(settings, "HOSTS_AUTO", False):
        return issues
    issues.append(CheckWarning(
        "DEBUG=false and ALLOWED_HOSTS was never set: every Host header is "
        "accepted, so a request for any domain answers as this site.",
        hint="Set ALLOWED_HOSTS=your-domain.example (comma separated, no "
             "scheme) — or PUBLIC_URL / APP_URL to the deployed address, which "
             "is added automatically. Nothing else needs changing.",
        id="deploy.W012",
    ))
    return issues


@register()
def https_is_not_assumed(app_configs, **kwargs) -> list[CheckWarning]:
    """Say that the app thinks it is served over plain HTTP.

    Until a deployment declares TLS, cookies are not ``Secure``, HSTS is off and
    HTTP is not redirected.  That is what makes a bare ``http://host:8000`` work
    (a ``Secure`` cookie is never sent back over http — a login form that "does
    nothing"), but it must not survive the move to a real https domain.
    """
    issues: list[CheckWarning] = []
    if settings.DEBUG or getattr(settings, "HTTPS_IN_USE", False):
        return issues
    if (getattr(settings, "SECURE_SSL_REDIRECT", False)
            or getattr(settings, "SESSION_COOKIE_SECURE", False)):
        # The operator already made the choice explicitly; nothing to add.
        return issues
    issues.append(CheckWarning(
        "This deployment is not marked as HTTPS: session and CSRF cookies are "
        "sent without Secure, HSTS is off and HTTP is not redirected to HTTPS.",
        hint="On a real domain put TLS in front of the app and set "
             "HTTPS_IN_USE=true (or PUBLIC_URL=https://your-domain) — that one "
             "value turns on Secure cookies, the HTTPS redirect and HSTS.",
        id="deploy.W013",
    ))
    return issues
