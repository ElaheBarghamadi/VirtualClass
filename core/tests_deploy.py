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


class ProductionReadinessTests(SimpleTestCase):
    """The four settings a fresh host always gets wrong.

    Each one fails *after* a successful deploy — 400 on every page, 403 on every
    form, a redirect loop, or uploads that only break at the first file — so
    they are checked at boot and reported in one place instead of being
    rediscovered in class.
    """

    def _checks(self, **want):
        with self.settings(**want):
            ids = set()
            for check in (
                checks.hosts_before_traffic,
                checks.csrf_origins_match_the_host,
                checks.https_redirect_without_a_proxy_header,
            ):
                ids |= _ids(check(None))
        return ids

    def test_a_production_host_needs_its_own_host_name(self):
        self.assertIn(
            "deploy.W004",
            self._checks(
                DEBUG=False, ALLOWED_HOSTS=["localhost", "127.0.0.1"],
                CSRF_TRUSTED_ORIGINS=["https://class.example.com"],
                SECURE_SSL_REDIRECT=False,
            ),
        )

    def test_a_real_host_name_silences_it(self):
        self.assertNotIn(
            "deploy.W004",
            self._checks(
                DEBUG=False, ALLOWED_HOSTS=["class.example.com"],
                CSRF_TRUSTED_ORIGINS=["https://class.example.com"],
                SECURE_SSL_REDIRECT=False,
            ),
        )

    def test_https_posts_need_trusted_origins(self):
        self.assertIn(
            "deploy.W005",
            self._checks(
                DEBUG=False, ALLOWED_HOSTS=["class.example.com"],
                CSRF_TRUSTED_ORIGINS=[], SECURE_SSL_REDIRECT=False,
            ),
        )

    def test_the_redirect_loop_behind_a_proxy_is_reported(self):
        ids = self._checks(
            DEBUG=False, ALLOWED_HOSTS=["class.example.com"],
            CSRF_TRUSTED_ORIGINS=["https://class.example.com"],
            SECURE_SSL_REDIRECT=True, SECURE_PROXY_SSL_HEADER=None,
        )
        self.assertIn("deploy.W007", ids)

    def test_the_proxy_header_is_the_fix(self):
        ids = self._checks(
            DEBUG=False, ALLOWED_HOSTS=["class.example.com"],
            CSRF_TRUSTED_ORIGINS=["https://class.example.com"],
            SECURE_SSL_REDIRECT=True,
            SECURE_PROXY_SSL_HEADER=("HTTP_X_FORWARDED_PROTO", "https"),
        )
        self.assertNotIn("deploy.W007", ids)

    def test_development_is_never_nagged(self):
        self.assertEqual(
            self._checks(
                DEBUG=True, ALLOWED_HOSTS=["*"], CSRF_TRUSTED_ORIGINS=[],
                SECURE_SSL_REDIRECT=False,
            ),
            set(),
        )

    def test_missing_upload_directories_are_reported(self):
        import tempfile
        from pathlib import Path

        missing = Path(tempfile.mkdtemp()) / "not-here"
        with self.settings(
            DEBUG=False, MEDIA_ROOT=missing,
            PRIVATE_MEDIA_ROOT=tempfile.mkdtemp(),
        ):
            self.assertIn("deploy.W006", _ids(checks.upload_directories_are_writable(None)))

    def test_a_writable_directory_passes(self):
        import tempfile

        with self.settings(
            DEBUG=False,
            MEDIA_ROOT=tempfile.mkdtemp(),
            PRIVATE_MEDIA_ROOT=tempfile.mkdtemp(),
        ):
            self.assertNotIn(
                "deploy.W006", _ids(checks.upload_directories_are_writable(None))
            )


class HealthProbeTests(TestCase):
    """The one URL a host's health check can be pointed at."""

    def test_it_answers_without_a_session_or_a_login(self):
        response = self.client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content)["status"], "ok")
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(response["X-Robots-Tag"], "noindex")

    def test_the_database_probe_reports_ok(self):
        payload = json.loads(self.client.get("/healthz?db=1").content)
        self.assertEqual(payload["database"], "ok")
        self.assertEqual(payload["status"], "ok")

    def test_a_broken_database_is_503_not_a_traceback(self):
        from unittest import mock

        with mock.patch("core.views.connection") as fake:
            fake.cursor.side_effect = RuntimeError("connection refused")
            response = self.client.get("/healthz?db=1")
        self.assertEqual(response.status_code, 503)
        body = json.loads(response.content)
        self.assertEqual(body["database"], "unavailable")
        self.assertNotIn("refused", response.content.decode())  # no driver detail

    def test_the_probe_is_exempt_from_the_https_redirect(self):
        import re

        from django.conf import settings

        with self.settings(SECURE_REDIRECT_EXEMPT=[r"^healthz$"]):
            self.assertTrue(any(re.search(pattern, "healthz") for pattern in settings.SECURE_REDIRECT_EXEMPT))


class DatabaseUrlTests(SimpleTestCase):
    """A hosted DSN is not just host/user/password — its query string counts."""

    def _entry(self, url, **env):
        import importlib
        import os
        from unittest import mock

        from config import settings as settings_module

        with mock.patch.dict(os.environ, env):
            return importlib.reload(settings_module)._database_from_url(url)

    def test_percent_encoded_credentials_are_decoded(self):
        entry = self._entry("postgres://us%40er:p%40ss%23word@db.example:5432/class")
        self.assertEqual(entry["USER"], "us@er")
        self.assertEqual(entry["PASSWORD"], "p@ss#word")
        self.assertEqual(entry["NAME"], "class")
        self.assertEqual(entry["PORT"], "5432")

    def test_ssl_parameters_survive(self):
        entry = self._entry(
            "postgres://u:p@db.example:5432/class?sslmode=require&connect_timeout=5"
        )
        self.assertEqual(entry["OPTIONS"]["sslmode"], "require")
        self.assertEqual(entry["OPTIONS"]["connect_timeout"], 5)

    def test_a_sane_connect_timeout_is_always_present(self):
        entry = self._entry("postgres://u:p@db.example:5432/class")
        self.assertIn("connect_timeout", entry["OPTIONS"])

    def test_connection_reuse_is_opt_in(self):
        entry = self._entry("postgres://u:p@db.example:5432/class")
        self.assertEqual(entry["CONN_MAX_AGE"], 0)
        self.assertNotIn("CONN_HEALTH_CHECKS", entry)
        reuse = self._entry("postgres://u:p@db.example:5432/class", DB_CONN_MAX_AGE="60")
        self.assertEqual(reuse["CONN_MAX_AGE"], 60)
        self.assertTrue(reuse["CONN_HEALTH_CHECKS"])

    def test_mysql_speaks_utf8mb4_and_an_unknown_scheme_is_refused(self):
        from django.core.exceptions import ImproperlyConfigured

        entry = self._entry("mysql://u:p@db.example/db")
        self.assertEqual(entry["OPTIONS"]["charset"], "utf8mb4")
        with self.assertRaises(ImproperlyConfigured):
            self._entry("mongodb://u:p@db.example/db")

    def test_sqlite_is_the_development_default(self):
        entry = self._entry("")
        self.assertEqual(entry["ENGINE"], "django.db.backends.sqlite3")
        self.assertEqual(entry["OPTIONS"], {"timeout": 20})


class HealthProbeHostTests(SimpleTestCase):
    """A platform probe calls the container by IP; that must not look unhealthy.

    ``DisallowedHost`` happens before URL resolution, so a probe with
    ``Host: 10.0.0.5:8000`` would get 400 and the platform would restart a
    healthy process.  Only the health path may be rescued from that.
    """

    def test_the_probe_answers_on_an_unknown_host(self):
        with self.settings(ALLOWED_HOSTS=["virtualclass.weblines.ir"]):
            response = self.client.get("/healthz", HTTP_HOST="10.128.1.20:8000")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.content)["status"], "ok")

    def test_nothing_else_is_rescued(self):
        with self.settings(ALLOWED_HOSTS=["virtualclass.weblines.ir"]):
            self.assertEqual(
                self.client.get("/", HTTP_HOST="10.128.1.20:8000").status_code, 400
            )
            self.assertEqual(
                self.client.get("/accounts/login/", HTTP_HOST="evil.example").status_code,
                400,
            )

    def test_the_real_domain_is_never_rewritten(self):
        from core.middleware import HealthProbeHostMiddleware

        seen = {}

        def record(request):
            seen["host"] = request.META["HTTP_HOST"]
            from django.http import HttpResponse

            return HttpResponse("ok")

        middleware = HealthProbeHostMiddleware(record)
        from django.test import RequestFactory

        request = RequestFactory().get("/healthz", HTTP_HOST="virtualclass.weblines.ir")
        with self.settings(ALLOWED_HOSTS=["virtualclass.weblines.ir", "other.example"]):
            middleware(request)
        self.assertEqual(seen["host"], "virtualclass.weblines.ir")

    def test_it_runs_before_host_validation(self):
        from django.conf import settings

        self.assertEqual(settings.MIDDLEWARE[0], "core.middleware.HealthProbeHostMiddleware")
