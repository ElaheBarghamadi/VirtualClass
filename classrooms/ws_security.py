"""WebSocket hardening shared by every consumer.

Two protections live here:

1. **Cross-Site WebSocket Hijacking (CSWSH) defence.**  Browsers attach
   session cookies to *any* WebSocket handshake, and — unlike HTTP —
   browsers do not apply same-origin policy to WebSockets.  Without an
   ``Origin`` check, a malicious website could open a socket to our
   server riding on the victim's cookies and chat / draw / signal as
   them.  We therefore accept a browser handshake only when its
   ``Origin`` matches the ``Host`` it is talking to (or an explicitly
   trusted origin).  Clients that send no ``Origin`` header at all
   (native apps, server-side scripts, our own tests) are unaffected —
   they still have to carry a valid session cookie.

2. **A tiny token-bucket rate limiter** so a hostile script cannot
   flood the channel layer / database with operations.
"""
from __future__ import annotations

import time
from collections import deque
from urllib.parse import urlparse

from django.conf import settings

_DEFAULT_PORTS = {"http": "80", "https": "443", "ws": "80", "wss": "443"}


def _normalise_netloc(scheme: str, netloc: str) -> str:
    """Lower-case the host and drop default ports for stable comparison."""
    netloc = netloc.lower()
    host, _, port = netloc.rpartition(":")
    if not host:  # no colon at all
        host, port = netloc, ""
    if port and port == _DEFAULT_PORTS.get(scheme, ""):
        port = ""
    return f"{host}:{port}" if port else host


def ws_origin_allowed(scope: dict) -> bool:
    """True when this WebSocket handshake may proceed.

    * no ``Origin`` header (non-browser client) → allowed;
    * ``Origin`` host[:port] equals the request ``Host`` → allowed;
    * ``Origin`` is listed in ``CSRF_TRUSTED_ORIGINS`` (scheme + host) →
      allowed (reverse-proxy deployments put the public origin there);
    * anything else → rejected.
    """
    headers = dict(scope.get("headers") or [])
    origin_raw = headers.get(b"origin")
    if not origin_raw:
        return True
    try:
        origin = urlparse(origin_raw.decode("latin-1"))
    except (UnicodeDecodeError, ValueError):
        return False
    if not origin.scheme or not origin.netloc:
        return False
    ws_scheme = "https" if origin.scheme in {"https", "wss"} else "http"
    origin_netloc = _normalise_netloc(ws_scheme, origin.netloc)

    host_raw = headers.get(b"host", b"")
    try:
        host_netloc = _normalise_netloc(
            "https" if scope.get("scheme") == "https" else "http",
            host_raw.decode("latin-1"),
        )
    except (UnicodeDecodeError, ValueError):
        host_netloc = ""
    if origin_netloc and origin_netloc == host_netloc:
        return True

    for trusted in getattr(settings, "CSRF_TRUSTED_ORIGINS", []):
        parsed = urlparse(trusted if "//" in trusted else f"https://{trusted}")
        if parsed.netloc and _normalise_netloc(
            "https" if parsed.scheme in {"https", "wss"} else "http", parsed.netloc
        ) == origin_netloc:
            return True
    return False


class RateLimiter:
    """Sliding-window limiter (per consumer instance = per connection).

    ``allow()`` returns False once more than ``limit`` calls happened
    inside the last ``window`` seconds.  Cheap enough for per-message
    checks; drops are silent because the client can simply slow down.
    """

    def __init__(self, limit: int, window: float = 1.0) -> None:
        self.limit = limit
        self.window = window
        self._stamps: deque[float] = deque()

    def allow(self) -> bool:
        now = time.monotonic()
        stamps = self._stamps
        cutoff = now - self.window
        while stamps and stamps[0] < cutoff:
            stamps.popleft()
        if len(stamps) >= self.limit:
            return False
        stamps.append(now)
        return True
