"""How the app accepts the addresses people actually open it on.

The rule is the same in both modes: work on the address the browser typed, with
nothing configured.  Development accepts any Host header and trusts the proxy;
production does the same *until* it is told its own domain (``ALLOWED_HOSTS`` or
``PUBLIC_URL``), because a deployment that will not boot, or that answers 400 to
its own domain, is worse than one with a wide host list that says so at boot
(``deploy.W012``).

These tests boot a real Django process, because settings can only be judged at
import time, and one of them boots with **no environment variables at all** —
which is the point of the whole exercise.
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

#: Every variable the project reads that decides *where* things go.  Cleared
#: before each boot so a developer's own shell (or the CI runner) cannot make a
#: "zero configuration" test secretly configured.
_CONFIG_VARS = {
    "DEBUG", "ALLOWED_HOSTS", "SECRET_KEY", "SECRET_KEY_FILE",
    "DJANGO_SETTINGS_MODULE", "TRUST_X_FORWARDED_PROTO", "CSRF_TRUSTED_ORIGINS",
    "HTTPS_IN_USE", "SESSION_COOKIE_SECURE", "CSRF_COOKIE_SECURE",
    "SECURE_SSL_REDIRECT", "SECURE_HSTS_SECONDS",
    "PUBLIC_URL", "APP_URL", "SITE_URL", "WEBSITE_URL", "BASE_URL",
    "RENDER_EXTERNAL_URL", "RAILWAY_PUBLIC_DOMAIN", "FLY_APP_NAME",
    "DATABASE_URL", "POSTGRES_URL", "DATABASE_PRIVATE_URL", "POSTGRESQL_URL",
    "PGHOST", "PGDATABASE", "PGPORT", "PGUSER", "PGPASSWORD", "PGSSLMODE",
    "POSTGRES_HOST", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD",
    "REDIS_URL", "REDIS_TLS_URL", "REDISCLOUD_URL",
    "MEDIA_SERVER_URL", "MESH_ENABLED",
}

#: A dict of the decisions under test, printed as JSON (one parseable line).
_BOOT_STATE = (
    "import json, django; django.setup();"
    "from django.conf import settings;"
    "print(json.dumps({"
    "'hosts': settings.ALLOWED_HOSTS,"
    "'hosts_auto': settings.HOSTS_AUTO,"
    "'secret_source': settings.SECRET_KEY_SOURCE,"
    "'secret': settings.SECRET_KEY,"
    "'zero_config': settings.ZERO_CONFIG,"
    "'db': settings.DATABASES['default']['ENGINE'],"
    "'https': settings.HTTPS_IN_USE,"
    "'cookie_secure': settings.SESSION_COOKIE_SECURE,"
    "'redirect': settings.SECURE_SSL_REDIRECT,"
    "'hsts': settings.SECURE_HSTS_SECONDS,"
    "'mesh': settings.MESH_ENABLED,"
    "}))"
)


def _clean_env(**overrides) -> dict:
    env = {key: value for key, value in os.environ.items() if key not in _CONFIG_VARS}
    env.update({"PYTHONPATH": str(BASE_DIR)})
    env.update(overrides)
    return env


def _boot(**overrides) -> subprocess.CompletedProcess:
    """Import the settings module in a clean process and print the two values."""
    env = _clean_env(DJANGO_SETTINGS_MODULE="config.settings", **overrides)
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


def _state(**overrides) -> dict:
    """Boot production settings with the given overrides and return the state."""
    import json

    proc = subprocess.run(
        [sys.executable, "-c", _BOOT_STATE],
        cwd=BASE_DIR,
        env=_clean_env(DJANGO_SETTINGS_MODULE="config.settings", **overrides),
        capture_output=True,
        text=True,
        timeout=90,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout.strip().splitlines()[-1])


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

    def test_production_without_a_host_list_still_boots(self):
        """No ALLOWED_HOSTS is a legal deployment, not a failed one."""
        proc = _boot(DEBUG="false", SECRET_KEY=_REAL_KEY)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(_values(proc)[0], "*")

    def test_a_known_domain_replaces_the_wildcard(self):
        """When the platform says its address, production names it (no ``*``)."""
        state = _state(DEBUG="false", SECRET_KEY=_REAL_KEY,
                       PUBLIC_URL="https://class.example.com")
        self.assertEqual(
            state["hosts"],
            ["class.example.com", "localhost", "127.0.0.1", "[::1]"],
        )
        self.assertFalse(state["hosts_auto"])


class ProxySchemeTests(TestCase):
    """TLS ends at the preview proxy; without the header every POST is 403 CSRF."""

    def test_development_trusts_the_forwarded_proto(self):
        proc = _boot(DEBUG="true", SECRET_KEY=_REAL_KEY)
        self.assertEqual(_values(proc)[1], "('HTTP_X_FORWARDED_PROTO', 'https')")

    def test_production_trusts_it_by_default(self):
        """Otherwise every form on a proxy-hosted host answers 403 with no clue."""
        proc = _boot(DEBUG="false", SECRET_KEY=_REAL_KEY)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(_values(proc)[1], "('HTTP_X_FORWARDED_PROTO', 'https')")

    def test_production_can_refuse_it_explicitly(self):
        proc = _boot(DEBUG="false", SECRET_KEY=_REAL_KEY, TRUST_X_FORWARDED_PROTO="false")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(_values(proc)[1], "-")

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


class ZeroConfigTests(TestCase):
    """A bare server, no ``.env``, no environment variables: it must just run.

    This is the deployment the project is actually put on ("test only for
    now"): a host, an archive, `daphne`.  Each assertion here is a way that
    would have *failed before* — a refused boot, a public development secret, a
    ``Secure`` cookie the browser never sends back over http.
    """

    def setUp(self):
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.key_file = Path(self._tmp.name) / ".secret_key"

    def _manage_check(self, **overrides) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "manage.py", "check"],
            cwd=BASE_DIR,
            env=_clean_env(
                DJANGO_SETTINGS_MODULE="config.settings",
                SECRET_KEY_FILE=str(self.key_file),
                **overrides,
            ),
            capture_output=True,
            text=True,
            timeout=120,
        )

    def test_production_boots_without_a_single_variable(self):
        proc = self._manage_check(DEBUG="false")
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
        self.assertNotIn("ImproperlyConfigured", proc.stderr)

    def test_development_boots_without_a_single_variable(self):
        proc = self._manage_check()
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)

    def test_the_generated_secret_is_stable_and_never_the_dev_key(self):
        first = _state(DEBUG="false", SECRET_KEY_FILE=str(self.key_file))
        second = _state(DEBUG="false", SECRET_KEY_FILE=str(self.key_file))

        self.assertEqual(first["secret"], second["secret"], "sessions must survive a restart")
        self.assertNotIn("insecure", first["secret"].lower())
        self.assertEqual(second["secret_source"], "file")
        self.assertEqual(self.key_file.read_text().strip(), first["secret"])
        self.assertEqual(self.key_file.stat().st_mode & 0o777, 0o600)

    def test_an_explicit_secret_key_still_wins(self):
        state = _state(DEBUG="false", SECRET_KEY=_REAL_KEY, SECRET_KEY_FILE=str(self.key_file))
        self.assertEqual(state["secret"], _REAL_KEY)
        self.assertEqual(state["secret_source"], "env")
        self.assertFalse(self.key_file.exists(), "nothing to generate when one is given")

    def test_an_unwritable_location_still_boots(self):
        """A read-only app directory costs sessions, never the deployment."""
        import tempfile

        read_only = Path(tempfile.mkdtemp(dir=self._tmp.name)) / "nodir" / ".secret_key"
        state = _state(DEBUG="false", SECRET_KEY_FILE=str(read_only / "deeper" / "key"))
        self.assertTrue(state["secret"])
        self.assertIn(state["secret_source"], {"ephemeral", "generated"})

    def test_the_headers_are_honest_about_the_defaults(self):
        state = _state(DEBUG="false", SECRET_KEY_FILE=str(self.key_file))
        self.assertTrue(state["zero_config"])
        self.assertTrue(state["hosts_auto"])
        # No TLS anywhere in sight: nothing may force HTTPS or mark cookies
        # Secure, or the login form silently does nothing on http://host:8000.
        self.assertFalse(state["https"])
        self.assertFalse(state["cookie_secure"])
        self.assertFalse(state["redirect"])
        self.assertEqual(state["hsts"], 0)
        # With no SFU configured the mesh is what puts a camera in the room.
        self.assertTrue(state["mesh"])

    def test_declaring_https_turns_the_strict_settings_on(self):
        state = _state(
            DEBUG="false", SECRET_KEY_FILE=str(self.key_file), HTTPS_IN_USE="true"
        )
        self.assertTrue(state["https"])
        self.assertTrue(state["cookie_secure"])
        self.assertTrue(state["redirect"])
        self.assertGreater(state["hsts"], 0)

    def test_a_published_https_url_counts_as_declaring_https(self):
        state = _state(
            DEBUG="false", SECRET_KEY_FILE=str(self.key_file),
            PUBLIC_URL="https://virtualclass.example.org",
        )
        self.assertTrue(state["https"])
        self.assertTrue(state["cookie_secure"])

    def test_a_linked_database_is_used_without_being_retyped(self):
        state = _state(
            DEBUG="false", SECRET_KEY_FILE=str(self.key_file),
            POSTGRES_URL="postgres://u:p@db.internal:5432/classroom",
        )
        self.assertEqual(state["db"], "django.db.backends.postgresql")
        self.assertFalse(state["zero_config"])

    def test_heroku_style_database_variables_are_understood(self):
        state = _state(
            DEBUG="false", SECRET_KEY_FILE=str(self.key_file),
            PGHOST="db.internal", PGDATABASE="classroom",
        )
        self.assertEqual(state["db"], "django.db.backends.postgresql")

    def test_no_database_configured_is_local_sqlite(self):
        state = _state(DEBUG="false", SECRET_KEY_FILE=str(self.key_file))
        self.assertEqual(state["db"], "django.db.backends.sqlite3")
