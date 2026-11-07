"""Redis cache backend that cannot take the site down.

Redis holds nothing durable here: rate-limit counters, classroom password
attempts, presence hints.  If it is unreachable, the right behaviour is
"cache miss, writes ignored, keep serving" — not a 500 on the login page for
every user until an operator notices.

Django's ``RedisCache`` propagates ``redis.exceptions.ConnectionError``, so a
Redis restart turns into an outage of every view that touches the cache
(``accounts/views.py`` login throttle, ``classrooms/services.py`` password
gate, ``core/ratelimit.py``).  ``ResilientRedisCache`` keeps the same API and
degrades each operation to its neutral value, logging at most one warning per
``WARN_EVERY`` seconds so a long outage does not flood the log.

Fail-open is deliberate: without a reachable cache the throttle is a no-op
(temporarily weaker brute-force protection), whereas fail-closed would lock
everybody out of the product — including the teacher who is about to start a
class.
"""
from __future__ import annotations

import functools
import logging
import time

from django.core.cache.backends.base import DEFAULT_TIMEOUT
from django.core.cache.backends.redis import RedisCache

logger = logging.getLogger("core.cache")

#: Minimum seconds between two "Redis is unavailable" warnings.
WARN_EVERY = 60.0


def _tolerate(default):
    """Make a cache method return ``default`` instead of raising."""

    def decorator(method):
        @functools.wraps(method)
        def wrapper(self, *args, **kwargs):
            try:
                return method(self, *args, **kwargs)
            except Exception as exc:  # redis.ConnectionError, timeout, DNS, ...
                self._warn_unavailable(exc)
                return default

        return wrapper

    return decorator


class ResilientRedisCache(RedisCache):
    """``RedisCache`` that degrades to a no-op cache when Redis is down."""

    def _warn_unavailable(self, exc: Exception) -> None:
        now = time.monotonic()
        last = getattr(self, "_last_unavailable_warn", 0.0)
        if now - last < WARN_EVERY:
            return
        self._last_unavailable_warn = now
        logger.warning(
            "cache_redis_unavailable: serving without cache (%s: %s)",
            type(exc).__name__, exc,
            extra={"servers": getattr(self, "_servers", None)},
        )

    # -- reads ---------------------------------------------------------------
    def get(self, key, default=None, version=None):
        try:
            return super().get(key, default=default, version=version)
        except Exception as exc:
            self._warn_unavailable(exc)
            return default  # honour the caller's own default (often 0/None)

    @_tolerate({})
    def get_many(self, keys, version=None):
        return super().get_many(keys, version=version)

    @_tolerate(False)
    def has_key(self, key, version=None):
        return super().has_key(key, version=version)

    # -- writes --------------------------------------------------------------
    @_tolerate(False)
    def add(self, key, value, timeout=DEFAULT_TIMEOUT, version=None):
        return super().add(key, value, timeout=timeout, version=version)

    @_tolerate(None)
    def set(self, key, value, timeout=DEFAULT_TIMEOUT, version=None):
        return super().set(key, value, timeout=timeout, version=version)

    @_tolerate([])
    def set_many(self, data, timeout=DEFAULT_TIMEOUT, version=None):
        return super().set_many(data, timeout=timeout, version=version)

    # -- counters ------------------------------------------------------------
    @_tolerate(1)
    def incr(self, key, delta=1, version=None):
        # 1 = "this is the first attempt in the window", so throttles allow the
        # request instead of blocking it because a counter could not be read.
        return super().incr(key, delta=delta, version=version)

    # -- delete / touch ------------------------------------------------------
    @_tolerate(False)
    def delete(self, key, version=None):
        return super().delete(key, version=version)

    @_tolerate(None)
    def delete_many(self, keys, version=None):
        return super().delete_many(keys, version=version)

    @_tolerate(False)
    def touch(self, key, timeout=DEFAULT_TIMEOUT, version=None):
        return super().touch(key, timeout=timeout, version=version)

    @_tolerate(False)
    def clear(self):
        return super().clear()
