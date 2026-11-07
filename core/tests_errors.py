"""Error pages, and the header every other page inherits.

Two kinds of regression are covered here:

* an error page that stops rendering exactly when it is needed — a 500 must
  not depend on the session, the account theme or a database query;
* a header that loses its phone affordance (the menu toggle) or ends up with
  two "theme" buttons, which would break ``#theme-toggle``.
"""
from __future__ import annotations

from django.test import RequestFactory, TestCase

from core.error_views import (
    bad_request,
    csrf_failure,
    permission_denied,
    server_error,
)


class ErrorPageTests(TestCase):
    def test_unknown_url_renders_the_designed_404(self):
        response = self.client.get("/this-page-does-not-exist/", secure=True)
        self.assertEqual(response.status_code, 404)
        html = response.content.decode()
        self.assertIn('data-scene="lost"', html)
        self.assertIn("err-code", html)
        self.assertIn("css/errors.css", html)
        self.assertIn("صفحهٔ اصلی", html)

    def test_the_handlers_are_wired(self):
        import config.urls as urlconf

        self.assertEqual(urlconf.handler404, "core.error_views.page_not_found")
        self.assertEqual(urlconf.handler500, "core.error_views.server_error")
        self.assertEqual(urlconf.handler403, "core.error_views.permission_denied")
        self.assertEqual(urlconf.handler400, "core.error_views.bad_request")

    def test_each_status_renders_its_own_scene(self):
        request = RequestFactory().get("/x/")
        for view, status, scene in (
            (bad_request, 400, "lost"),
            (permission_denied, 403, "locked"),
            (server_error, 500, "broken"),
        ):
            with self.subTest(status=status):
                response = view(request)
                html = response.content.decode()
                self.assertEqual(response.status_code, status)
                self.assertIn(f'data-scene="{scene}"', html)
                self.assertIn(f">{status}<", html)

    def test_500_renders_even_when_the_session_backend_is_the_problem(self):
        class ExplodingUser:
            @property
            def user(self):
                raise RuntimeError("session store unavailable")

        request = RequestFactory().get("/boom/")
        request.user = ExplodingUser()
        response = server_error(request)
        self.assertEqual(response.status_code, 500)
        self.assertIn('data-scene="broken"', response.content.decode())

    def test_error_pages_are_self_contained(self):
        html = permission_denied(RequestFactory().get("/x/")).content.decode()
        # no site chrome: the header/footer come from base.html, which needs
        # context processors and therefore cannot be trusted on a 500.
        self.assertNotIn("site-header", html)
        self.assertNotIn("main-nav", html)
        self.assertIn("err-shell", html)

    def test_csrf_rejection_uses_the_same_page(self):
        request = RequestFactory().post("/accounts/login/")
        response = csrf_failure(request, reason="CSRF cookie not set.")
        self.assertEqual(response.status_code, 403)
        self.assertIn('data-scene="locked"', response.content.decode())


class HeaderTests(TestCase):
    def test_guest_header_has_a_working_menu_toggle(self):
        html = self.client.get("/accounts/login/").content.decode()
        self.assertIn('data-nav-toggle', html)
        self.assertIn('aria-controls="main-nav"', html)
        self.assertIn('id="main-nav"', html)
        self.assertIn('data-nav-panel', html)
        self.assertIn('data-nav-scrim', html)
        self.assertIn("js/nav.js", html)

    def test_only_one_theme_toggle_is_rendered(self):
        # theme.js resolves the button by id; a second copy would be dead.
        html = self.client.get("/accounts/login/").content.decode()
        self.assertEqual(html.count('id="theme-toggle"'), 1)

    def test_signed_in_header_links_to_the_account(self):
        from accounts.models import User

        user = User.objects.create_user(username="nav_user", password="Pass-12345")
        self.client.force_login(user)
        html = self.client.get("/dashboard/").content.decode()
        self.assertIn("داشبورد", html)
        self.assertIn("کلاس‌های من", html)
        self.assertIn("خروج", html)


class ErrorPreviewRouteTests(TestCase):
    """The DEBUG-only design preview must never exist in production."""

    def test_the_preview_is_not_routed_without_debug(self):
        # the suite runs with DEBUG=false, which is exactly production's case
        for code in (400, 403, 404, 500):
            self.assertEqual(
                self.client.get(f"/__errors__/{code}/", secure=True).status_code, 404
            )
