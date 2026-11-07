"""Outage resilience: Redis going away must degrade, not break the site.

Both halves of the realtime stack treat the shared infrastructure as an
optimisation:

* the **cache** (login throttle, classroom-password counters) must read as a
  miss and write as a no-op, so nobody is locked out while Redis restarts;
* the **channel layer** (broadcasts) must not fail the request that already
  changed the database — clients resync when the layer is back.

These tests pin both behaviours.  They point at a closed port on purpose: the
"Redis is down" case is exactly the one a normal test run never sees.
"""
from __future__ import annotations

from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache as default_cache
from django.core.cache.backends.base import DEFAULT_TIMEOUT
from django.test import SimpleTestCase, TestCase, override_settings

from core.cache import ResilientRedisCache

User = get_user_model()

#: A URL nobody listens on: connection refused, immediately.
DEAD_REDIS = "redis://127.0.0.1:1/0"
FAST_FAIL = {"socket_connect_timeout": 0.2, "socket_timeout": 0.2}

DEAD_CACHE_SETTINGS = {
    "default": {
        "BACKEND": "core.cache.ResilientRedisCache",
        "LOCATION": DEAD_REDIS,
        "OPTIONS": FAST_FAIL,
    }
}


def _dead_cache() -> ResilientRedisCache:
    return ResilientRedisCache(
        DEAD_REDIS, {"OPTIONS": FAST_FAIL, "TIMEOUT": 30, "KEY_PREFIX": ""}
    )


class ResilientCacheOperationTests(SimpleTestCase):
    """Every cache operation returns a neutral value instead of raising."""

    def setUp(self):
        self.cache = _dead_cache()

    def test_reads_look_like_misses(self):
        self.assertIsNone(self.cache.get("missing"))
        self.assertEqual(self.cache.get("missing", default=0), 0)  # caller's default
        self.assertEqual(self.cache.get_many(["a", "b"]), {})
        self.assertFalse(self.cache.has_key("a"))

    def test_writes_are_dropped_quietly(self):
        self.assertIsNone(self.cache.set("k", "v"))
        self.assertFalse(self.cache.add("k", "v"))
        self.assertEqual(self.cache.set_many({"a": 1}), [])
        self.assertFalse(self.cache.delete("k"))
        self.assertIsNone(self.cache.delete_many(["a"]))
        self.assertFalse(self.cache.touch("k"))
        self.assertFalse(self.cache.clear())

    def test_counter_starts_at_one_so_throttles_fail_open(self):
        self.assertEqual(self.cache.incr("attempts"), 1)
        # and a throttle built on incr() therefore lets the request through
        from core.ratelimit import hit

        with mock.patch("core.ratelimit.cache", self.cache):
            self.assertTrue(hit("login:someone", max_hits=3, window_seconds=60))

    def test_the_default_timeout_sentinel_is_preserved(self):
        """`set()` without an explicit timeout must still expire on schedule.

        (Regression guard: overriding the methods means re-declaring the
        DEFAULT_TIMEOUT sentinel — a plain ``None`` would make keys eternal.)
        """
        self.assertEqual(self.cache.get_backend_timeout(DEFAULT_TIMEOUT), 30)

    def test_one_warning_per_minute_not_one_per_call(self):
        with self.assertLogs("core.cache", level="WARNING") as logs:
            for _ in range(5):
                self.cache.get("k")
        self.assertEqual(len(logs.records), 1, "a Redis outage must not flood the log")

        self.cache._last_unavailable_warn -= 61  # pretend a minute passed
        with self.assertLogs("core.cache", level="WARNING") as logs:
            self.cache.get("k")
        self.assertEqual(len(logs.records), 1)


class LoginSurvivesRedisOutageTests(TestCase):
    """The regression that started this: login must not 500 when Redis is down."""

    def setUp(self):
        self.user = User.objects.create_user(
            username="outage", password="S0me-Pass-123", email="o@x.com"
        )

    def _login(self, password: str):
        return self.client.post(
            "/accounts/login/", {"username": "outage", "password": password}
        )

    @override_settings(CACHES=DEAD_CACHE_SETTINGS)
    def test_wrong_password_redisplays_the_form(self):
        response = self._login("wrong-password")
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "ورود")

    @override_settings(CACHES=DEAD_CACHE_SETTINGS)
    def test_correct_password_still_logs_in(self):
        response = self._login("S0me-Pass-123")
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.client.session.get("_auth_user_id"), str(self.user.pk))

    @override_settings(CACHES=DEAD_CACHE_SETTINGS)
    def test_classroom_password_gate_does_not_explode(self):
        """The other cache user: repeated wrong classroom passwords."""
        from classrooms.services import (
            password_attempts_blocked,
            register_failed_password,
        )

        classroom = mock.MagicMock(id=1)
        self.assertFalse(password_attempts_blocked(classroom, "someone"))
        # and the counter path is a no-op rather than an exception
        register_failed_password(classroom, "someone")
        self.assertFalse(password_attempts_blocked(classroom, "someone"))


class BroadcastSurvivesRedisOutageTests(SimpleTestCase):
    """A dead channel layer must not turn a completed action into a 500."""

    def _broken_layer(self):
        async def boom(*args, **kwargs):
            raise ConnectionError("channel layer is down")

        layer = mock.MagicMock()
        layer.group_send = boom
        return layer

    def test_broadcast_logs_and_returns(self):
        from classrooms.services import broadcast

        with mock.patch("classrooms.services.get_channel_layer",
                        return_value=self._broken_layer()), \
                self.assertLogs("classrooms.services", level="ERROR"):
            broadcast("abc123", {"type": "file_uploaded"})  # must not raise

    def test_targeted_notification_is_equally_tolerant(self):
        from classrooms.services import notify_member

        member = mock.MagicMock(id=7)
        with mock.patch("classrooms.services.get_channel_layer",
                        return_value=self._broken_layer()), \
                self.assertLogs("classrooms.services", level="ERROR"):
            notify_member("abc123", member, {"type": "muted"})

    def test_the_working_layer_still_delivers(self):
        from classrooms.services import broadcast

        with mock.patch("classrooms.services.get_channel_layer") as layer:
            broadcast("abc123", {"type": "ping", "value": 1})
        message = layer.return_value.group_send.call_args.args[1]
        self.assertEqual(message["payload"], {"type": "ping", "value": 1})


class DefaultCacheTests(SimpleTestCase):
    """Sanity: the test-suite itself runs on the in-memory cache."""

    def test_suite_uses_local_memory(self):
        from django.core.cache import caches

        default_cache.set("probe", 1, 30)
        self.assertEqual(default_cache.get("probe"), 1)
        self.assertIn("LocMemCache", type(caches["default"]).__name__)
