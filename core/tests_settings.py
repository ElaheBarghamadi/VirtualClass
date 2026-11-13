"""How the app accepts the addresses people actually open it on.

Development is deliberately frictionless — any Host header is accepted and a
TLS-terminating proxy is trusted — because the app must work on a preview URL,
a LAN IP, a phone on the same Wi-Fi or a tunnel without any setup.  Production
must be strict, and these tests boot a real Django process (settings can only
be judged at import time) to prove both halves, plus the CSRF consequence of
each choice.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from django.test import Client, TestCase, override_settings

BASE_DIR = Path(__file__).resolve().parent.parent
_REAL_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"
_BOOT = (
    "import django; django.setup();"
    "from django.conf import settings;"
    "print(','.join(settings.ALLOWED_HOSTS));"
    "print(settings.SECURE_PROXY_SSL_HEADER or '-')"
)


def _boot(**overrides) -> subprocess.CompletedProcess:
    """Import the settings module in a clean process and print the two values."""
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in {"DEBUG", "ALLOWED_HOSTS", "SECRET_KEY", "DJANGO_SETTINGS_MODULE",
                       "TRUST_X_FORWARDED_PROTO", "CSRF_TRUSTED_ORIGINS",
                       "PUBLIC_URL", "APP_URL", "SITE_URL", "WEBSITE_URL", "BASE_URL",
                       "RENDER_EXTERNAL_URL", "RAILWAY_PUBLIC_DOMAIN"}
    }
    env.update({"DJANGO_SETTINGS_MODULE": "config.settings", "PYTHONPATH": str(BASE_DIR)})
    env.update(overrides)
    return subprocess.run(
        [sys.executable, "-c", _BOOT],
        cwd=BASE_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=90,
    )


def _values(proc) -> tuple[str, str]:
    lines = proc.stdout.strip().splitlines()
    return lines[-2], lines[-1]


class AllowedHostsTests(TestCase):
    def test_development_accepts_any_host_by_default(self):
        proc = _boot(DEBUG="true", SECRET_KEY=_REAL_KEY)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(_values(proc)[0], "*")

    def test_explicit_hosts_are_still_honoured_in_development(self):
        proc = _boot(DEBUG="true", SECRET_KEY=_REAL_KEY, ALLOWED_HOSTS="localhost,10.0.0.5")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(_values(proc)[0], "localhost,10.0.0.5")

    def test_production_refuses_the_wildcard(self):
        proc = _boot(DEBUG="false", SECRET_KEY=_REAL_KEY, ALLOWED_HOSTS="*")
        self.assertNotEqual(proc.returncode, 0, "a wildcard must not boot in production")
        self.assertIn("ALLOWED_HOSTS=*", proc.stderr)

    def test_production_default_is_strict(self):
        proc = _boot(DEBUG="false", SECRET_KEY=_REAL_KEY)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(_values(proc)[0], "localhost,127.0.0.1,[::1]")


class ProxySchemeTests(TestCase):
    """TLS ends at the preview proxy; without the header every POST is 403 CSRF."""

    def test_development_trusts_the_forwarded_proto(self):
        proc = _boot(DEBUG="true", SECRET_KEY=_REAL_KEY)
        self.assertEqual(_values(proc)[1], "('HTTP_X_FORWARDED_PROTO', 'https')")

    def test_production_does_not_trust_it_by_default(self):
        proc = _boot(DEBUG="false", SECRET_KEY=_REAL_KEY)
        self.assertEqual(_values(proc)[1], "-")

    def test_production_can_opt_in_explicitly(self):
        proc = _boot(DEBUG="false", SECRET_KEY=_REAL_KEY, TRUST_X_FORWARDED_PROTO="true")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(_values(proc)[1], "('HTTP_X_FORWARDED_PROTO', 'https')")

    def _post_login(self):
        client = Client(enforce_csrf_checks=True)
        token = client.get("/accounts/login/").cookies["csrftoken"].value
        # ``HTTP_HOST`` is pinned: the test client otherwise appends the default
        # port (``testserver:80``) and the Origin could never match.
        return client.post(
            "/accounts/login/",
            {"username": "nobody", "password": "nope"},
            HTTP_HOST="testserver",
            HTTP_ORIGIN="https://testserver",
            HTTP_X_FORWARDED_PROTO="https",
            HTTP_X_CSRFTOKEN=token,
        )

    @override_settings(SECURE_PROXY_SSL_HEADER=("HTTP_X_FORWARDED_PROTO", "https"))
    def test_https_origin_passes_with_the_proxy_header(self):
        self.assertNotEqual(self._post_login().status_code, 403)

    @override_settings(SECURE_PROXY_SSL_HEADER=None)
    def test_https_origin_is_rejected_without_it(self):
        self.assertEqual(self._post_login().status_code, 403)
