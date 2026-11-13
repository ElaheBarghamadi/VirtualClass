"""UI polish contracts: calm inner pages, one-row header, lazy loading on purpose.

The three decisions these tests pin down were all made for a reason, and all
three are easy to undo by accident:

* decorative motion (aurora background, reveal-on-scroll, count-up, parallax)
  belongs to the landing page; a working screen gets one quiet fade;
* the header must fit on one row at every width — it sheds the tagline, the
  link icons and the account label instead of wrapping onto a second line;
* lazy loading is a tool for things that cost the server something (logo
  thumbnails in a list), not a default for every script — the toast module is
  a plain static import.
"""
from __future__ import annotations

import re
from pathlib import Path

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

REPO_ROOT = Path(__file__).resolve().parent.parent
STATIC = REPO_ROOT / "static"
JS = STATIC / "js"
CSS = STATIC / "css"
TEMPLATES = REPO_ROOT / "templates"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class MotionScopeTests(TestCase):
    """Rich motion is opt-in per page."""

    def test_landing_page_opts_into_the_rich_motion_layer(self):
        html = self.client.get("/").content.decode()
        self.assertIn("is-home", html)

    def test_inner_pages_stay_calm(self):
        html = self.client.get("/accounts/login/").content.decode()
        self.assertNotIn("is-home", html)

    def test_motion_module_gates_decoration_behind_the_home_flag(self):
        source = read(JS / "motion.js")
        gate = source.index("is-home")
        # the decorative calls must come *after* the guard, not before it
        for call in ("tagReveals()", "observeReveals()", "animateStats()", "heroParallax()"):
            self.assertGreater(source.index(f"        {call}", source.index("function init")), gate)

    def test_aurora_only_animates_on_the_landing_page(self):
        source = read(CSS / "motion.css")
        self.assertIn("body.is-home::before {", source)
        self.assertIn("body.is-home::after {", source)
        # Nothing may animate the background without the home-page prefix:
        # `body.is-home::before` does not contain the substring below, so any
        # hit here is an un-prefixed rule.
        un_prefixed = list(re.finditer(r"(?m)^[^\n{}]*body::(?:before|after)[^\n{}]*\{", source))
        self.assertTrue(un_prefixed, "the static background rules disappeared")
        for match in un_prefixed:
            block = source[match.end(): source.index("}", match.end())]
            self.assertNotIn("animation:", block, "the background animates on every page")
            self.assertNotIn("will-change", block, "a still background still reserves a layer")

    def test_inner_pages_get_a_short_fade_not_a_rise(self):
        source = read(CSS / "motion.css")
        self.assertIn(".js-anim main { animation: fade-in .18s", source)
        self.assertIn("html.js-anim body.is-home main", source)

    def test_primary_button_gradient_does_not_animate_forever_in_the_app(self):
        source = read(CSS / "motion.css")
        plain = source[source.index(".btn-primary {"):]
        plain = plain[: plain.index("}")]
        self.assertNotIn("animation:", plain)

    def test_static_cards_do_not_lift_when_the_pointer_crosses_them(self):
        source = read(CSS / "motion.css")
        self.assertNotIn(".card:hover", source)


class HeaderTests(TestCase):
    """One row, at every width, with a panel that behaves like a dialog."""

    def test_header_row_never_wraps(self):
        source = read(CSS / "main.css")
        for selector in (".header-inner {", ".main-nav {"):
            start = source.index(selector)
            block = source[start : source.index("}", start)]
            self.assertIn("flex-wrap: nowrap", block, f"{selector} must not wrap")
            self.assertNotIn("flex-wrap: wrap", block, f"{selector} still wraps")

    def test_panel_takes_over_at_tablet_width(self):
        source = read(CSS / "main.css")
        self.assertIn("@media (max-width: 1024px)", source)
        self.assertIn("@media (min-width: 1025px)", source)
        panel = source[source.index("@media (max-width: 1024px)"):]
        self.assertIn("height: 100dvh", panel)
        self.assertIn("position: fixed", panel)

    def test_anchor_offsets_follow_the_measured_header(self):
        source = read(CSS / "main.css")
        self.assertIn("scroll-padding-top: calc(var(--header-h, 62px)", source)
        self.assertIn("--header-h", read(JS / "motion.js"))

    def test_panel_script_handles_focus_and_scroll_lock(self):
        source = read(JS / "nav.js")
        self.assertIn("matchMedia('(min-width: 1025px)')", source)
        self.assertIn("aria-modal", source)
        self.assertIn("nav-lock", source)
        self.assertIn("document.documentElement.classList.add('nav-lock')", source)
        self.assertIn("event.key !== 'Tab'", source)

    def test_account_labels_can_collapse_to_an_icon(self):
        guest = self.client.get("/accounts/login/").content.decode()
        self.assertTrue("btn-label-full" in guest, "guest CTA lost its long label")
        self.assertTrue("btn-label-short" in guest, "guest CTA lost its short label")

        get_user_model().objects.create_user(username="hdr", password="Pass-12345")
        self.client.login(username="hdr", password="Pass-12345")
        member = self.client.get("/dashboard/").content.decode()
        self.assertTrue('class="btn-label"' in member, "logout label is not collapsible")
        self.assertTrue('aria-label="خروج از حساب"' in member, "icon-only logout has no name")


class LazyLoadingTests(SimpleTestCase):
    """Lazy loading where it saves the server work — nowhere else."""

    def test_no_module_is_loaded_lazily_just_to_be_polite(self):
        offenders = []
        for path in sorted(JS.glob("*.js")):
            if "import(" in read(path):
                offenders.append(path.name)
        self.assertEqual(offenders, [])

    def test_toast_is_a_plain_import_in_the_viewers(self):
        for name in ("presentation.js", "whiteboard.js"):
            source = read(JS / name)
            self.assertIn("import { toast } from './toast.js';", source, name)

    def test_only_list_thumbnails_are_lazy(self):
        lazy = {}
        for path in (REPO_ROOT / "classrooms" / "templates").rglob("*.html"):
            count = read(path).count('loading="lazy"')
            if count:
                lazy[path.name] = count
        self.assertEqual(
            lazy,
            {"classroom_list.html": 2, "dashboard.html": 1, "classroom_detail.html": 1},
        )

    def test_above_the_fold_logos_stay_eager(self):
        for name in ("lobby.html", "room.html"):
            source = read(REPO_ROOT / "classrooms" / "templates" / "classrooms" / name)
            match = re.search(r"<img[^>]*(logo|classroom\.logo\.url)[^>]*>", source)
            self.assertIsNotNone(match, name)
            self.assertNotIn("loading=", match.group(0), name)

class TemplateLintTests(SimpleTestCase):
    """Django's `{# … #}` is single-line only — a wrapped one is printed verbatim."""

    def test_no_multi_line_hash_comments(self):
        offenders = []
        for path in REPO_ROOT.rglob("*.html"):
            if {".venv", "node_modules", "static", "staticfiles"} & set(path.parts):
                continue
            text = read(path)
            for match in re.finditer(r"\{#(.*?)#\}", text, re.S):
                if "\n" in match.group(1):
                    line = text[: match.start()].count("\n") + 1
                    offenders.append(f"{path.relative_to(REPO_ROOT)}:{line}")
        self.assertEqual(offenders, [], "use {% comment %} for multi-line comments")

    def test_no_template_comment_leaks_into_the_response(self):
        for url in ("/", "/accounts/login/", "/__errors__/404/"):
            body = self.client.get(url).content.decode(errors="ignore")
            self.assertNotIn("{#", body, url)
            self.assertNotIn("{%", body, url)
