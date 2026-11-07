"""WebSocket hardening shared by every consumer.

The helpers here defend against cross-site WebSocket hijacking, oversized or
malformed JSON frames, and message floods. Keeping the framing checks in one
base consumer prevents individual handlers from accidentally bypassing them.
"""
from __future__ import annotations

import json
import time
from collections import deque
from urllib.parse import urlsplit

from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.conf import settings

_DEFAULT_PORTS = {"http": 80, "https": 443}


def _scheme(value: str) -> str | None:
    value = (value or "").lower()
    if value in {"http", "ws"}:
        return "http"
    if value in {"https", "wss"}:
        return "https"
    return None


def _endpoint(scheme: str, netloc: str) -> tuple[str, str, int] | None:
    """Parse an authority safely, including IPv6 and explicit ports."""
    normal_scheme = _scheme(scheme)
    if not normal_scheme or not netloc or any(ch.isspace() for ch in netloc):
        return None
    try:
        parsed = urlsplit(f"//{netloc}")
        if parsed.username is not None or parsed.password is not None:
            return None
        if parsed.path or parsed.query or parsed.fragment or not parsed.hostname:
            return None
        host = parsed.hostname.rstrip(".").lower()
        port = parsed.port or _DEFAULT_PORTS[normal_scheme]
    except (ValueError, UnicodeError):
        return None
    if not host or not (1 <= port <= 65535):
        return None
    return normal_scheme, host, port


def _origin_endpoint(value: str) -> tuple[str, str, int] | None:
    try:
        parsed = urlsplit(value)
    except (TypeError, ValueError):
        return None
    if parsed.path or parsed.query or parsed.fragment or not parsed.netloc:
        return None
    return _endpoint(parsed.scheme, parsed.netloc)


def _first_header(headers: dict, name: bytes) -> str:
    """First value of a possibly comma-joined proxy header."""
    return (headers.get(name, b"").split(b",")[0]).decode("latin-1").strip()


def _request_endpoint(scope: dict, headers: dict):
    """The endpoint the *browser* used, as far as the proxy tells us.

    Behind a TLS-terminating proxy (every container platform, every nginx
    setup) the socket reaches Daphne as plain ``ws`` on an internal host while
    the browser's Origin says ``https`` on the public host.  Comparing the two
    literally rejects every handshake — which is exactly what
    "ws_origin_rejected" in production looked like.  When the operator has
    declared a trusted proxy (``TRUST_X_FORWARDED_PROTO``), the forwarded
    headers describe the public request and are what Origin must be compared
    against.
    """
    scheme = "https" if scope.get("scheme") in {"https", "wss"} else "http"
    host_text = headers.get(b"host", b"").decode("latin-1")
    if getattr(settings, "SECURE_PROXY_SSL_HEADER", None):
        forwarded_proto = _first_header(headers, b"x-forwarded-proto").lower()
        if forwarded_proto in {"https", "wss"}:
            scheme = "https"
        elif forwarded_proto in {"http", "ws"}:
            scheme = "http"
        forwarded_host = _first_header(headers, b"x-forwarded-host")
        if forwarded_host:
            host_text = forwarded_host
    return _endpoint(scheme, host_text)


def _comparable(endpoint: tuple[str, str, int] | None):
    """Identity of an endpoint for origin comparison.

    The scheme is deliberately dropped: the browser decides it, the proxy
    decides what we see, and a mismatch between them is a deployment detail,
    not a security property.  What matters is that the Origin points at *our*
    host — a hostile site cannot fake that.  Non-default ports still have to
    match, so ``https://host:8443`` never matches a plain ``host``.
    """
    if endpoint is None:
        return None
    _, host, port = endpoint
    return host, (None if port in _DEFAULT_PORTS.values() else port)


def describe_origin(scope: dict) -> str:
    """One line for the rejection log: what was compared and against what."""
    headers = dict(scope.get("headers") or [])
    origin = headers.get(b"origin", b"").decode("latin-1")
    request = _request_endpoint(scope, headers)
    trusted = ", ".join(str(o) for o in getattr(settings, "CSRF_TRUSTED_ORIGINS", [])) or "-"
    return (
        f"origin={origin or '-'} scope_scheme={scope.get('scheme') or '-'} "
        f"compared_with={request} trusted_origins={trusted}"
    )


def ws_origin_allowed(scope: dict) -> bool:
    """True when this WebSocket handshake may proceed.

    Browser handshakes must have an Origin pointing at the request's host, or
    at an explicitly trusted origin. Native/server clients without an Origin
    remain supported; they still need a valid authenticated session.
    """
    headers = dict(scope.get("headers") or [])
    origin_raw = headers.get(b"origin")
    if not origin_raw:
        return True
    try:
        origin_text = origin_raw.decode("latin-1")
    except UnicodeDecodeError:
        return False

    origin = _origin_endpoint(origin_text)
    if origin is None:
        return False
    request = _request_endpoint(scope, headers)
    if request is not None and _comparable(origin) == _comparable(request):
        return True

    for trusted in getattr(settings, "CSRF_TRUSTED_ORIGINS", []):
        trusted = str(trusted).strip()
        if not trusted:
            continue
        # Django's trusted-origin entries normally include a scheme. For
        # older host-only entries, retain the historical HTTPS interpretation.
        if "://" not in trusted:
            trusted = f"https://{trusted}"
        if _origin_endpoint(trusted) == origin:
            return True
    return False


class SafeJsonWebsocketConsumer(AsyncJsonWebsocketConsumer):
    """JSON consumer that rejects hostile frames before application parsing."""

    max_message_bytes = 128 * 1024

    @classmethod
    async def decode_json(cls, text_data: str):
        def reject_non_finite(value: str):
            raise ValueError(f"Non-finite JSON number: {value}")

        return json.loads(text_data, parse_constant=reject_non_finite)

    async def receive(self, text_data=None, bytes_data=None, **kwargs):
        if text_data is None or bytes_data is not None:
            await self.close(code=4400)
            return
        try:
            size = len(text_data.encode("utf-8", errors="strict"))
        except (AttributeError, UnicodeError):
            await self.close(code=4400)
            return
        if size > self.max_message_bytes:
            await self.close(code=4409)
            return
        try:
            content = await self.decode_json(text_data)
        except (TypeError, ValueError, UnicodeError, RecursionError):
            await self.send_json({"type": "error", "message": "فرمت پیام معتبر نیست."})
            return
        if not isinstance(content, dict):
            await self.send_json({"type": "error", "message": "ساختار پیام معتبر نیست."})
            return
        await self.receive_json(content, **kwargs)


class RateLimiter:
    """Sliding-window limiter (per consumer instance = per connection)."""

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
