"""The deployment failure modes that look like application bugs.

Every test here corresponds to a log line somebody actually had to diagnose:

* ``Not Found: /ws/classroom/<code>/`` repeated forever — a WSGI server
  (gunicorn) started instead of Daphne, so Channels never saw the handshake;
* ``no such table: accounts_user`` — SQLite inside a container, wiped by the
  previous deploy, instead of the linked PostgreSQL;
* "the page has no styles" — ``collectstatic`` never ran.
"""
from __future__ import annotations

import json
from io import StringIO

from django.core.management import call_command
from django.test import SimpleTestCase, TestCase, override_settings

from core import checks
from core.middleware import ASGIOnlyWebSocketsMiddleware


def _ids(issues) -> set[str]:
    return {issue.id for issue in issues}


class WebSocketUnderWSGITests(SimpleTestCase):
    """A WebSocket handshake must never be answered with a bare 404."""

    def test_handshake_under_wsgi_is_426_with_an_explanation(self):
        with self.assertLogs("core.middleware", level="ERROR"):
            response = self.client.get(
                "/ws/classroom/abc123/", HTTP_UPGRADE="websocket",
                HTTP_CONNECTION="Upgrade",
            )
        self.assertEqual(response.status_code, 426)
        payload = json.loads(response.content)
        self.assertEqual(payload["code"], "asgi_required")
        self.assertIn("asgi", payload["hint"])

    def test_an_ordinary_request_to_ws_is_still_a_404(self):
        self.assertEqual(self.client.get("/ws/classroom/abc123/").status_code, 404)

    def test_a_normal_page_is_untouched(self):
        self.assertEqual(self.client.get("/accounts/login/").status_code, 200)

    def test_it_only_reports_once_per_process(self):
        import core.middleware as middleware

        middleware._warned = False
        with self.assertLogs("core.middleware", level="ERROR") as captured:
            for _ in range(3):
                self.client.get("/ws/classroom/abc/", HTTP_UPGRADE="websocket")
        self.assertEqual(len(captured.records), 1)
        self.assertIn("websocket_under_wsgi", captured.records[0].getMessage())


class EphemeralDatabaseTests(SimpleTestCase):
    """SQLite behind a container is data loss with a delay."""

    def test_it_warns_in_production(self):
        with override_settings(DEBUG=False):
            self.assertIn("deploy.W003", _ids(checks.database_is_not_ephemeral(None)))

    def test_it_is_quiet_in_development(self):
        with override_settings(DEBUG=True):
            self.assertNotIn("deploy.W003", _ids(checks.database_is_not_ephemeral(None)))

    def test_the_escape_hatch_is_honoured(self):
        import os
        from unittest import mock

        with override_settings(DEBUG=False), mock.patch.dict(
            os.environ, {"ALLOW_SQLITE_IN_PRODUCTION": "true"}
        ):
            self.assertNotIn("deploy.W003", _ids(checks.database_is_not_ephemeral(None)))


class DeployCheckCommandTests(TestCase):
    """The command that makes a deployment log self-explanatory."""

    def test_full_report_names_the_engine_and_the_static_files(self):
        out = StringIO()
        call_command("deploy_check", stdout=out)
        text = out.getvalue()
        self.assertIn("database", text)
        self.assertIn("sqlite3", text)
        self.assertIn("static_root", text)
        self.assertIn("private_media_root", text)

    def test_brief_is_one_line(self):
        out = StringIO()
        call_command("deploy_check", "--brief", stdout=out)
        lines = [line for line in out.getvalue().splitlines() if line.startswith("deploy_check:")]
        self.assertEqual(len(lines), 1)
        self.assertIn("server:", lines[0])
        self.assertIn("database:", lines[0])


class MiddlewareSettingTests(SimpleTestCase):
    def test_the_middleware_is_installed(self):
        from django.conf import settings

        self.assertEqual(settings.MIDDLEWARE[-1], "core.middleware.ASGIOnlyWebSocketsMiddleware")
        self.assertTrue(hasattr(ASGIOnlyWebSocketsMiddleware, "__call__"))
