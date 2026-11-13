"""Middleware that turns a silent deployment mistake into a clear message."""
from __future__ import annotations

import logging

from django.http import JsonResponse

logger = logging.getLogger(__name__)

_warned = False


class ASGIOnlyWebSocketsMiddleware:
    """Answer WebSocket handshakes that reach Django with 426, not a 404.

    The room talks over ``/ws/…``.  Those paths are not Django URLs at all:
    ``config/asgi.py`` routes them to Channels *before* the HTTP stack, so under
    Daphne (or any ASGI server) this middleware never sees them.

    Under a WSGI server (``gunicorn``, ``uWSGI``, mod_wsgi) there is no protocol
    router, so the handshake arrives as an ordinary GET with
    ``Upgrade: websocket``, Django finds no matching URL and logs
    ``Not Found: /ws/classroom/<code>/`` — dozens of times per room, with
    nothing saying what is actually wrong.  This is that missing message.
    """

    #: ``/ws/…`` is not a real URL prefix we own; it only exists in asgi.py.
    PATH_PREFIX = "/ws/"

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if (
            request.path.startswith(self.PATH_PREFIX)
            and request.META.get("HTTP_UPGRADE", "").lower() == "websocket"
        ):
            self._warn_once(request.path)
            return JsonResponse(
                {
                    "detail": (
                        "WebSocket is unavailable: this process is serving WSGI. "
                        "The room, chat and whiteboard need an ASGI server."
                    ),
                    "hint": (
                        "Run `daphne -b 0.0.0.0 -p $PORT --proxy-headers "
                        "config.asgi:application` (or uvicorn on config.asgi:application) "
                        "instead of gunicorn/uWSGI. See deploy/DEPLOY.md."
                    ),
                    "code": "asgi_required",
                },
                status=426,  # Upgrade Required
            )
        return self.get_response(request)

    @staticmethod
    def _warn_once(path: str) -> None:
        global _warned
        if _warned:
            return
        _warned = True
        logger.error(
            "websocket_under_wsgi: %s arrived with Upgrade: websocket but this "
            "process runs a WSGI server, so Channels never sees it and the room "
            "cannot connect. Start the app with an ASGI server "
            "(daphne config.asgi:application).",
            path,
        )


class HealthProbeHostMiddleware:
    """Let ``/healthz`` answer a probe that does not know the public domain.

    Load balancers, container platforms and uptime monitors often call the
    container directly — ``curl http://10.0.0.5:8000/healthz`` — so the Host
    header is an IP address (or ``localhost``), not the domain in
    ``ALLOWED_HOSTS``.  Django rejects it before any view runs, the probe gets
    a ``400``, and the platform restarts a process that was perfectly healthy.

    The fix is deliberately the smallest possible: for **exactly** the health
    path, and only when the incoming Host is not already allowed, the Host is
    rewritten to an allowed name.  The health view returns a two-line JSON
    object that reveals nothing, so a rewritten Host cannot be used to reach
    anything else; every other path keeps full Host validation.

    Must be first in ``MIDDLEWARE``: security/common middleware call
    ``request.get_host()`` themselves.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.conf import settings

        path = request.path_info or "/"
        if path.rstrip("/") == "/healthz" or path.startswith("/healthz?"):
            allowed = list(getattr(settings, "ALLOWED_HOSTS", []) or [])
            # The effective host: HTTP_HOST when present, otherwise the
            # SERVER_NAME/SERVER_PORT pair the WSGI/ASGI server built (that is
            # what a bare `curl 10.0.0.5:8000` looks like).
            host = request.META.get("HTTP_HOST") or ""
            if not host:
                name = request.META.get("SERVER_NAME", "")
                port = request.META.get("SERVER_PORT", "")
                host = name if not port or port in {"80", "443"} else f"{name}:{port}"
            bare = host.split(":", 1)[0]
            target = next(
                (h for h in allowed if h != "*" and not h.startswith(".") and h),
                None,
            )
            if target and bare and not self._host_allowed(bare, allowed):
                request.META["HTTP_HOST"] = target
        return self.get_response(request)

    @staticmethod
    def _host_allowed(host: str, allowed: list[str]) -> bool:
        from django.http.request import validate_host

        return validate_host(host, allowed) if host else True


class HostHeaderGuardMiddleware:
    """Say which host name is missing, instead of printing the settings page.

    ``DisallowedHost`` is the classic first-deploy error on a new domain: the app
    is reachable, the domain is right, and one environment variable does not
    mention it.  Django answers with its technical page (with DEBUG on) or a bare
    ``400`` (with DEBUG off) — both of which leave the owner guessing, and the
    first of which publishes paths and settings to whoever opens the URL.

    This middleware catches exactly that exception and answers a designed
    ``400`` that names the host that arrived, the hosts that are configured, and
    the variable to change.  It must sit **before** the security/common
    middleware, because those call ``request.get_host()`` themselves.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.core.exceptions import DisallowedHost

        # Check the Host *before* the framework does.  Django converts
        # SuspiciousOperation into a response inside its own middleware wrapper,
        # so by the time this method could catch it the generic 400 page (or the
        # technical one) has already been chosen; asking here keeps the useful
        # page.  ``request.get_host()`` is cached, so CommonMiddleware's later
        # call is free.
        try:
            request.get_host()
        except DisallowedHost as exc:
            host = self._host_of(request) or "?"
            self._report(host, exc)
            return self._response(host)
        except Exception:  # pragma: no cover - never block a request over this
            pass

        # Belt and braces: a view that reads the Host header itself throws the
        # same exception, and it should still land on the same page.
        try:
            return self.get_response(request)
        except DisallowedHost as exc:
            host = self._host_of(request) or "?"
            self._report(host, exc)
            return self._response(host)

    @staticmethod
    def _host_of(request) -> str:
        """The Host header as it really arrived (never via ``get_host()``)."""
        host = request.META.get("HTTP_HOST") or ""
        if not host:
            name = request.META.get("SERVER_NAME", "")
            port = request.META.get("SERVER_PORT", "")
            host = name if not port or port in {"80", "443"} else f"{name}:{port}"
        return host

    def _report(self, host: str, exc: Exception) -> None:
        if _host_reported:
            return
        globals()["_host_reported"] = True
        logger.critical(
            "host_not_allowed host=%s (%s) — the app was reached on a domain that "
            "ALLOWED_HOSTS does not list. Set ALLOWED_HOSTS=<that domain> "
            "(comma-separated for several, or .example.com for every subdomain) "
            "and redeploy.",
            host,
            exc,
        )

    def _response(self, host: str):
        from django.conf import settings
        from django.http import HttpResponse
        from django.template import loader

        allowed = [h for h in (getattr(settings, "ALLOWED_HOSTS", []) or [])]
        context = {
            "host": host,
            "bare_host": host.split(":", 1)[0],
            "allowed_hosts": ", ".join(allowed) or "—",
        }
        body = loader.get_template("errors/host_not_allowed.html").render(context)
        response = HttpResponse(body, status=400, content_type="text/html; charset=utf-8")
        response["Cache-Control"] = "no-store"
        return response


#: One log line per process; the page itself repeats the fix for every visitor.
_host_reported = False


class DatabaseNotReadyMiddleware:
    """Answer an unmigrated database with a page, not a traceback.

    The first thing a fresh container (or an empty PostgreSQL) does is fail on
    the first query: ``no such table: classrooms_classroom``.  With DEBUG on,
    the visitor gets Django's technical page — which lists settings, paths and
    versions — for what is really a deployment step that has not run yet.  With
    DEBUG off it is an opaque 500.

    This middleware catches exactly that class of error (missing table/relation)
    and answers ``503`` with a designed page plus ``Retry-After``, so a teacher
    sees "the database is being prepared", the platform's probe sees a
    retryable status, and a log line tells the operator the one command to run.
    Anything else still propagates untouched — this must never swallow a real
    bug.
    """

    #: Fragments that mean "this database has no schema yet", across backends.
    MISSING_SCHEMA_HINTS = (
        "no such table",
        "does not exist",          # PostgreSQL: relation "…" does not exist
        "doesn't exist",           # MySQL: Table 'db.x' doesn't exist
        "doesn’t exist",
        "unknown table",
        "no such column",
    )

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.db import Error as DatabaseError

        # The health probe reports database trouble itself (503 + JSON), and it
        # must never render a page or touch a template.
        path = request.path_info or "/"
        if path.rstrip("/") == "/healthz":
            return self.get_response(request)
        try:
            return self.get_response(request)
        except DatabaseError as exc:
            if not self._is_missing_schema(exc):
                raise
            self._report_once(request, exc)
            return self._response()

    def process_exception(self, request, exception):
        """The documented hook for "a view raised": Django converts exceptions
        raised by a view into responses *inside* the middleware wrapper, so
        ``__call__`` never sees them.  This does."""
        from django.db import Error as DatabaseError

        if not isinstance(exception, DatabaseError):
            return None
        if not self._is_missing_schema(exception):
            return None
        self._report_once(request, exception)
        return self._response()

    @classmethod
    def _is_missing_schema(cls, exc: Exception) -> bool:
        message = str(exc).lower()
        return any(hint in message for hint in cls.MISSING_SCHEMA_HINTS)

    def _report_once(self, request, exc) -> None:
        if _db_reported:
            return
        globals()["_db_reported"] = True
        logger.critical(
            "database_not_migrated path=%s error=%s — run `python manage.py migrate` "
            "(and link a durable DATABASE_URL on a container platform)",
            getattr(request, "path", "?"), exc,
        )

    def _response(self):
        from django.http import HttpResponse
        from django.template import loader

        body = loader.get_template("errors/db_not_ready.html").render({})
        response = HttpResponse(body, status=503, content_type="text/html; charset=utf-8")
        response["Retry-After"] = "60"
        response["Cache-Control"] = "no-store"
        return response


#: One log line per process is enough; the 503s themselves are self-explanatory.
_db_reported = False
