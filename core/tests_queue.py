"""The queue: how it is configured, and how work is handed to it.

These tests are the contract that keeps the project runnable **without** Redis:

* no ``REDIS_URL`` → eager execution, in-memory layer, in-process cache;
* ``REDIS_URL`` set  → that one URL is broker, backend, layer and cache;
* ``core.queue.dispatch`` always gets the job done, broker or not.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

from django.conf import settings
from django.test import SimpleTestCase

REPO_ROOT = Path(__file__).resolve().parent.parent


def _settings_probe(extra_env: dict[str, str]) -> dict:
    """Boot Django in a fresh process and report the queue wiring.

    A subprocess is the only honest way to test environment-dependent settings:
    ``settings`` is imported once per process.
    """
    code = (
        "import json, django;"
        "django.setup();"
        "from django.conf import settings as s;"
        "from config.celery import app;"
        "app.loader.import_default_modules();"
        "print(json.dumps({"
        "'eager': s.CELERY_TASK_ALWAYS_EAGER,"
        "'broker': s.CELERY_BROKER_URL,"
        "'backend': s.CELERY_RESULT_BACKEND,"
        "'layer': s.CHANNEL_LAYERS['default']['BACKEND'],"
        "'cache': s.CACHES['default']['BACKEND'],"
        "'tasks': sorted(n for n in app.tasks if not n.startswith('celery.')),"
        "'beat': sorted(s.CELERY_BEAT_SCHEDULE),"
        "}))"
    )
    env = {
        **os.environ,
        "DJANGO_SETTINGS_MODULE": "config.settings",
        "SECRET_KEY": "probe-only-not-a-secret",
        **extra_env,
    }
    out = subprocess.run(
        [sys.executable, "-c", code],
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if out.returncode != 0:
        raise AssertionError(f"settings probe failed:\n{out.stderr}")
    return json.loads(out.stdout.strip().splitlines()[-1])


class DefaultSettingsTests(SimpleTestCase):
    """With no Redis configured, nothing needs a broker or a worker."""

    def test_queue_is_inline_by_default(self):
        probe = _settings_probe({"REDIS_URL": ""})
        self.assertTrue(probe["eager"])
        self.assertEqual(probe["broker"], "memory://")
        self.assertEqual(probe["layer"], "channels.layers.InMemoryChannelLayer")
        self.assertEqual(probe["cache"], "django.core.cache.backends.locmem.LocMemCache")

    def test_every_scheduled_job_is_a_registered_task(self):
        probe = _settings_probe({"REDIS_URL": ""})
        self.assertIn("classrooms.tasks.convert_office_file", probe["tasks"])
        self.assertIn("classrooms.tasks.close_stale_sessions", probe["tasks"])
        self.assertIn("classrooms.tasks.prune_stale_guests", probe["tasks"])
        self.assertIn("core.tasks.prune_history", probe["tasks"])
        self.assertEqual(
            probe["beat"],
            ["close-stale-sessions", "prune-history", "prune-stale-guests"],
        )


class RedisSettingsTests(SimpleTestCase):
    """One URL is enough: broker, result backend, channel layer and cache."""

    def test_redis_url_drives_the_whole_stack(self):
        url = "redis://127.0.0.1:6390/0"
        probe = _settings_probe({"REDIS_URL": url})
        self.assertFalse(probe["eager"], "a real broker must not run tasks inline")
        self.assertEqual(probe["broker"], url)
        self.assertEqual(probe["backend"], url)
        self.assertEqual(probe["layer"], "channels_redis.core.RedisChannelLayer")
        self.assertEqual(probe["cache"], "django.core.cache.backends.redis.RedisCache")

    def test_eager_can_be_forced_even_with_redis(self):
        probe = _settings_probe({
            "REDIS_URL": "redis://127.0.0.1:6390/0",
            "CELERY_TASK_ALWAYS_EAGER": "true",
        })
        self.assertTrue(probe["eager"])


class TestSettingsAreHermeticTests(SimpleTestCase):
    """`manage.py test` must never depend on a broker or a Redis server."""

    def test_suite_runs_on_the_test_settings_module(self):
        self.assertEqual(os.environ.get("DJANGO_SETTINGS_MODULE"), "config.settings_test")
        self.assertTrue(settings.CELERY_TASK_ALWAYS_EAGER)
        self.assertEqual(settings.CELERY_BROKER_URL, "memory://")
        self.assertEqual(
            settings.CHANNEL_LAYERS["default"]["BACKEND"],
            "channels.layers.InMemoryChannelLayer",
        )


class DispatchTests(SimpleTestCase):
    """``dispatch`` always runs the job — only *where* it runs changes."""

    def _fake_task(self, *, eager: bool, publish: object = None):
        task = mock.MagicMock()
        task.app.conf.task_always_eager = eager
        if isinstance(publish, Exception):
            task.apply_async.side_effect = publish
        return task

    def test_inline_when_there_is_no_broker(self):
        from core.queue import dispatch

        task = self._fake_task(eager=True)
        queued = dispatch(task, 42)
        self.assertFalse(queued)
        task.apply.assert_called_once_with(args=(42,), kwargs={})
        task.apply_async.assert_not_called()

    def test_queued_when_a_broker_is_configured(self):
        from core.queue import dispatch

        task = self._fake_task(eager=False)
        queued = dispatch(task, 42)
        self.assertTrue(queued)
        task.apply_async.assert_called_once_with(args=(42,), kwargs={}, retry=False)
        task.apply.assert_not_called()

    def test_broker_outage_degrades_to_inline_execution(self):
        from core.queue import dispatch

        task = self._fake_task(eager=False, publish=ConnectionError("redis is down"))
        with self.assertLogs("core.queue", level="WARNING"):
            queued = dispatch(task, 42)
        self.assertFalse(queued)
        task.apply.assert_called_once_with(args=(42,), kwargs={})


class DeployCheckTests(SimpleTestCase):
    """`manage.py check` must point at a production install without a broker."""

    def _issues(self):
        from django.core.checks import run_checks

        return [i for i in run_checks() if i.id == "deploy.W002"]

    def test_production_without_redis_is_flagged(self):
        from django.test import override_settings

        with override_settings(DEBUG=False, REDIS_URL=""):
            issues = self._issues()
        self.assertEqual(len(issues), 1)
        self.assertIn("REDIS_URL", issues[0].msg)

    def test_production_with_redis_is_quiet(self):
        from django.test import override_settings

        with override_settings(DEBUG=False, REDIS_URL="redis://127.0.0.1:6379/0"):
            self.assertEqual(self._issues(), [])

    def test_development_is_never_nagged(self):
        from django.test import override_settings

        # the test runner itself runs with DEBUG=False; development is DEBUG=True
        with override_settings(DEBUG=True, REDIS_URL=""):
            self.assertEqual(self._issues(), [])
