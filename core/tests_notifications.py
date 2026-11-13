"""Notifications are one stacked surface — and the keyboard must not move the page.

These assertions guard the *seam* between templates, modules and stylesheets,
because every failure here is visual and easy to reintroduce:

* a second notification style creeping back in (the inline ``.messages``
  banner that used to sit at the top of ``<main>``);
* a notification without a way to close it;
* a toast stack that lands in the middle of the screen instead of the side;
* the mobile keyboard shrinking the visible area while the room keeps sizing
  itself from ``innerHeight``, which is what left the layout shifted after the
  keyboard closed.
"""
from __future__ import annotations

import re
from pathlib import Path

from django.contrib.messages import constants
from django.contrib.messages.storage.cookie import CookieStorage
from django.template.loader import render_to_string
from django.test import RequestFactory, SimpleTestCase

REPO_ROOT = Path(__file__).resolve().parent.parent
STATIC = REPO_ROOT / "static"
JS = STATIC / "js"
CSS = STATIC / "css"


def render_base(*messages, full_page=False):
    """Render base.html with real flash messages attached to the request."""
    request = RequestFactory().get("/")
    request.session = {}
    request.COOKIES = {}
    storage = CookieStorage(request)
    for tag, text in messages:
        storage.add(tag, text)
    request._messages = storage
    return render_to_string("base.html", {"full_page": full_page}, request=request)


class FlashMessageHandoverTests(SimpleTestCase):
    """Server messages reach the client as data for the toast stack."""

    def test_success_message_is_exposed_to_the_toast_stack(self):
        html = render_base((constants.SUCCESS, "تغییرات ذخیره شد."))
        self.assertIn("data-notify-source", html)
        self.assertIn('data-message="success"', html)
        self.assertIn("تغییرات ذخیره شد.", html)

    def test_error_message_keeps_its_level(self):
        html = render_base((constants.ERROR, "دسترسی ندارید."))
        self.assertIn('data-message="error"', html)

    def test_several_messages_are_all_handed_over_in_order(self):
        html = render_base(
            (constants.SUCCESS, "اول"),
            (constants.WARNING, "دوم"),
            (constants.ERROR, "سوم"),
        )
        source = html[html.index("data-notify-source"):]
        positions = [source.index(f'data-message="{level}"') for level in ("success", "warning", "error")]
        self.assertEqual(positions, sorted(positions))

    def test_inline_banner_only_exists_for_browsers_without_javascript(self):
        html = render_base((constants.INFO, "پیام."))
        self.assertEqual(html.count('class="messages"'), 1)
        noscript_start = html.index("<noscript>")
        banner = html.index('class="messages"')
        noscript_end = html.index("</noscript>")
        self.assertTrue(noscript_start < banner < noscript_end)
        # and it must not be duplicated outside the fallback
        self.assertNotIn('alert alert-', html[:noscript_start] + html[noscript_end:])

    def test_secret_source_is_removed_from_the_visual_flow(self):
        html = render_base((constants.INFO, "پیام."))
        self.assertRegex(html, r"<div data-notify-source hidden")


class NotificationWiringTests(SimpleTestCase):
    """Every page loads the same notification machinery."""

    def test_base_page_loads_notify_and_viewport_modules(self):
        html = render_base()
        self.assertIn("js/notify.js", html)
        self.assertIn("js/viewport.js", html)

    def test_viewport_meta_lets_the_keyboard_resize_the_page(self):
        html = render_base()
        self.assertIn("interactive-widget=resizes-content", html)

    def test_room_page_uses_the_same_machinery(self):
        html = render_base(full_page=True)
        self.assertIn("js/notify.js", html)
        self.assertIn("js/viewport.js", html)


class ToastComponentContractTests(SimpleTestCase):
    """The component itself keeps the promises the UI makes."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.toast = (JS / "toast.js").read_text(encoding="utf-8")
        cls.notify = (JS / "notify.js").read_text(encoding="utf-8")
        cls.viewport = (JS / "viewport.js").read_text(encoding="utf-8")

    def test_cards_have_a_close_button(self):
        self.assertIn("toast__close", self.toast)
        self.assertIn("بستن اعلان", self.toast)
        self.assertIn("classList.add('is-leaving')", self.toast)

    def test_identical_messages_do_not_pile_up(self):
        self.assertIn("visible", self.toast)
        self.assertIn("bumpCount", self.toast)

    def test_stack_is_bounded(self):
        match = re.search(r"const MAX_VISIBLE = (\d+)", self.toast)
        self.assertIsNotNone(match)
        self.assertGreaterEqual(int(match.group(1)), 2)

    def test_classic_scripts_can_reach_the_same_component(self):
        self.assertIn("window.UItoast = toast", self.toast)

    def test_countdown_pauses_while_the_card_is_read(self):
        for hook in ("pointerenter", "focusin", "is-paused"):
            self.assertIn(hook, self.toast)

    def test_notify_module_feeds_the_same_toast_function(self):
        self.assertIn("from './toast.js'", self.notify)
        self.assertIn("data-notify-source", self.notify)
        self.assertIn("data-message", self.notify)

    def test_viewport_module_publishes_the_visible_height(self):
        self.assertIn("--app-h", self.viewport)
        self.assertIn("visualViewport", self.viewport)


class NotificationStyleTests(SimpleTestCase):
    """Layout rules that make the stack usable rather than merely visible."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.main = (CSS / "main.css").read_text(encoding="utf-8")
        cls.room = (CSS / "room.css").read_text(encoding="utf-8")

    def _block(self, css: str, selector: str) -> str:
        start = css.index(selector)
        opening = css.index("{", start)
        depth = 0
        for index in range(opening, len(css)):
            if css[index] == "{":
                depth += 1
            elif css[index] == "}":
                depth -= 1
                if depth == 0:
                    return css[opening:index]
        raise AssertionError(f"unbalanced block for {selector}")

    def test_stack_is_docked_to_the_side(self):
        block = self._block(self.main, ".toast-container {")
        self.assertIn("position: fixed", block)
        self.assertIn("inset-inline-end", block)
        self.assertIn("--toast-shift", block)

    def test_stack_grows_upwards_and_clears_the_room_dock(self):
        self.assertIn("flex-direction: column", self._block(self.main, ".toast-container {"))
        room_block = self._block(self.main, "body.full-page .toast-container {")
        self.assertIn("--bar-h", room_block)

    def test_stack_never_overflows_the_visible_height(self):
        self.assertIn("--app-h", self._block(self.main, ".toast-container {"))

    def test_room_is_sized_by_the_visible_height(self):
        self.assertIn("var(--app-h", self._block(self.room, ".room {"))

    def test_room_body_is_pinned_so_the_keyboard_cannot_pan_it(self):
        block = self._block(self.room, "body.full-page {")
        self.assertIn("position: fixed", block)

    def test_mobile_inputs_are_at_least_sixteen_pixels(self):
        """Smaller fields make iOS zoom the page on focus — the 'it fell apart' bug."""
        for sheet in (self.main, self.room):
            coarse = sheet[sheet.index("@media (pointer: coarse)") :]
            self.assertIn("font-size: 16px", coarse)
