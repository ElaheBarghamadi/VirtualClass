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
