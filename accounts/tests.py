"""Account flows: password reset."""
from django.test import TestCase
from django.urls import reverse


class PasswordResetFlowTests(TestCase):
    """Full reset cycle: request → email link → new password → login."""

    def setUp(self):
        from django.contrib.auth import get_user_model
        self.user = get_user_model().objects.create_user(
            username="resetme", password="Old-Pass-123", email="resetme@x.com")

    def test_full_reset_cycle(self):
        from django.core import mail
        # 1) request the link
        resp = self.client.post(reverse("accounts:password_reset"), {"email": "resetme@x.com"})
        self.assertRedirects(resp, reverse("accounts:password_reset_done"))
        self.assertEqual(len(mail.outbox), 1)
        body = mail.outbox[0].body
        # 2) extract the reset link
        import re
        m = re.search(r"/accounts/reset/([^/\s]+)/([^/\s]+)/", body)
        self.assertIsNotNone(m, "reset link missing from email")
        # 3) open the confirm page and set a new password
        confirm_url = reverse("accounts:password_reset_confirm",
                              kwargs={"uidb64": m.group(1), "token": m.group(2)})
        resp = self.client.get(confirm_url, follow=True)  # follows the set-password redirect
        self.assertEqual(resp.status_code, 200)
        final_url = resp.redirect_chain[-1][0] if resp.redirect_chain else confirm_url
        resp = self.client.post(final_url, {
            "new_password1": "Brand-New-999", "new_password2": "Brand-New-999"})
        self.assertRedirects(resp, reverse("accounts:password_reset_complete"))
        # 4) login with the new password works, old one fails
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("Brand-New-999"))
        self.assertFalse(self.user.check_password("Old-Pass-123"))

    def test_unknown_email_does_not_leak_and_sends_nothing(self):
        from django.core import mail
        resp = self.client.post(reverse("accounts:password_reset"), {"email": "ghost@x.com"})
        self.assertRedirects(resp, reverse("accounts:password_reset_done"))  # same page = no enumeration
        self.assertEqual(len(mail.outbox), 0)

    def test_token_single_use(self):
        from django.core import mail
        import re
        self.client.post(reverse("accounts:password_reset"), {"email": "resetme@x.com"})
        m = re.search(r"/accounts/reset/([^/\s]+)/([^/\s]+)/", mail.outbox[0].body)
        url = reverse("accounts:password_reset_confirm",
                      kwargs={"uidb64": m.group(1), "token": m.group(2)})
        r1 = self.client.get(url, follow=True)
        post_url = r1.redirect_chain[-1][0] if r1.redirect_chain else url
        self.client.post(post_url, {"new_password1": "One-Shot-123", "new_password2": "One-Shot-123"})
        # reuse the same link → invalid
        r2 = self.client.get(url)
        self.assertContains(r2, "نامعتبر")
