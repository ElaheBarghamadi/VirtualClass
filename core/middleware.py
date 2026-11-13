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
