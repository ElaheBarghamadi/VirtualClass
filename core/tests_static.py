"""Static and public-media serving — the deployment detail that quietly breaks.

Two promises are tested here, both of them the difference between a page that
looks right on a server and one that does not:

* with ``DEBUG=false`` (i.e. on any real server) **WhiteNoise** serves
  ``/static/`` from ``STATIC_ROOT`` — no nginx rule required;
* classroom logos are reachable under ``/media/`` while everything else in
  ``MEDIA_ROOT`` stays a 404, because shared files and PDFs are private and
  must only ever leave through a permission-checked view.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from django.conf import settings
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings

REPO_ROOT = Path(__file__).resolve().parent.parent


class StaticServingTests(SimpleTestCase):
    """WhiteNoise answers /static/ in production mode."""

    def _middleware(self):
        from whitenoise.middleware import WhiteNoiseMiddleware

        def downstream(request):  # pragma: no cover - only reached on a miss
            return "DID-NOT-HANDLE"

        return WhiteNoiseMiddleware(downstream)

    def test_a_collected_static_file_is_served(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "css" / "main.css"
            target.parent.mkdir(parents=True)
            target.write_text("body{color:#5457e5}", encoding="utf-8")

            with override_settings(STATIC_ROOT=tmp, WHITENOISE_AUTOREFRESH=False):
                response = self._middleware()(
                    RequestFactory().get("/static/css/main.css")
                )

            self.assertEqual(getattr(response, "status_code", None), 200)
            self.assertIn("text/css", response["Content-Type"])
            self.assertIn(b"#5457e5", b"".join(response.streaming_content))

    def test_a_missing_file_falls_through_to_django(self):
        with tempfile.TemporaryDirectory() as tmp:
            with override_settings(STATIC_ROOT=tmp, WHITENOISE_AUTOREFRESH=False):
                response = self._middleware()(
                    RequestFactory().get("/static/css/not-there.css")
                )
        self.assertEqual(response, "DID-NOT-HANDLE")

    def test_settings_point_whitenoise_at_the_collected_files(self):
        self.assertEqual(
            settings.STORAGES["staticfiles"]["BACKEND"],
            "whitenoise.storage.CompressedStaticFilesStorage",
        )
        self.assertEqual(settings.WHITENOISE_MAX_AGE, 0)  # DEBUG=true in this suite
        # ... and the middleware sits directly after SecurityMiddleware, i.e.
        # before anything (session, auth, CSRF) that a static request needs.
        self.assertEqual(
            settings.MIDDLEWARE[:2],
            [
                "django.middleware.security.SecurityMiddleware",
                "whitenoise.middleware.WhiteNoiseMiddleware",
            ],
        )


class PublicMediaTests(TestCase):
    """`/media/` serves the public subtree only, with no web server involved."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        (root / "classroom_logos").mkdir()
        (root / "classroom_logos" / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
        (root / "secret.txt").write_text("must never be public", encoding="utf-8")
        self.override = override_settings(MEDIA_ROOT=root)
        self.override.enable()
        self.addCleanup(self.override.disable)

    def test_a_classroom_logo_is_served(self):
        response = self.client.get("/media/classroom_logos/logo.png")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(b"".join(response.streaming_content)[:4], b"\x89PNG")

    def test_other_media_is_not_reachable(self):
        self.assertEqual(self.client.get("/media/secret.txt").status_code, 404)

    def test_path_traversal_does_not_escape_the_public_subtree(self):
        response = self.client.get("/media/classroom_logos/../secret.txt")
        self.assertEqual(response.status_code, 404)

    def test_a_missing_logo_is_a_404_not_a_crash(self):
        self.assertEqual(
            self.client.get("/media/classroom_logos/nope.png").status_code, 404
        )


class StoragePathOverrideTests(SimpleTestCase):
    """Containers must be able to point the data paths at a volume."""

    def _probe(self, extra_env: dict[str, str]) -> dict:
        code = (
            "import json, django; asgi = None;"
            "django.setup();"
            "from django.conf import settings as s;"
            "print(json.dumps({"
            "'static': str(s.STATIC_ROOT),"
            "'media': str(s.MEDIA_ROOT),"
            "'private': str(s.PRIVATE_MEDIA_ROOT),"
            "'debug': s.DEBUG,"
            "}))"
        )
        env = {
            **os.environ,
            "DJANGO_SETTINGS_MODULE": "config.settings",
            "SECRET_KEY": "probe-only-not-a-secret",
            "ALLOWED_HOSTS": "example.test",
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

    def test_defaults_live_inside_the_project(self):
        probe = self._probe({"STATIC_ROOT": "", "MEDIA_ROOT": "", "PRIVATE_MEDIA_ROOT": ""})
        self.assertTrue(probe["static"].endswith("staticfiles"), probe["static"])
        self.assertTrue(probe["media"].endswith("/media"), probe["media"])
        self.assertTrue(probe["private"].endswith("private_media"), probe["private"])

    def test_environment_wins(self):
        probe = self._probe({
            "STATIC_ROOT": "/data/static",
            "MEDIA_ROOT": "/data/media",
            "PRIVATE_MEDIA_ROOT": "/data/private",
        })
        self.assertEqual(probe["static"], "/data/static")
        self.assertEqual(probe["media"], "/data/media")
        self.assertEqual(probe["private"], "/data/private")
