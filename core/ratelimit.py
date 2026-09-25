"""Cache-backed rate limiting for HTTP endpoints.

Used by account login/registration and the classroom password gate.
The cache is Redis in production (``REDIS_URL``) and local memory in
development — same semantics as Django's own throttling.

``hit()`` is intentionally *record-and-check*: it counts the attempt
first, then reports whether the caller is still under the limit.  That
way even blocked attempts keep the window alive (the counter is not
reset by simply waiting for the check to fail).
"""
from __future__ import annotations

from django.core.cache import cache

__all__ = ["hit", "clear"]


def hit(key: str, max_hits: int, window_seconds: int) -> bool:
    """Register one attempt; True while under the limit, False when blocked."""
    try:
        count = cache.incr(key)
    except ValueError:
        cache.set(key, 1, window_seconds)
        count = 1
    return count <= max_hits


def clear(key: str) -> None:
    """Forget a counter (e.g. after a successful login)."""
    cache.delete(key)
