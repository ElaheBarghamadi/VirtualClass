"""The landing page, after the refresh.

The layout was borrowed from a course platform the owner liked (a statement
headline, an honest number strip, a keyword ribbon, numbered moves with a small
picture of what each produces, one deep look inside the product).  What must not
be borrowed is the habit of advertising numbers that are not true: this page may
only state facts the product enforces, and it must stay inside the house style —
pastel, low shadow, calm motion, no emoji.

These tests pin the structure so a later edit cannot quietly turn the hero back
into a wall of text, drop the second ribbon copy (which is what makes the loop
seamless) or reintroduce a fake statistic.
"""
from __future__ import annotations

import re
from pathlib import Path

from django.test import TestCase

REPO_ROOT = Path(__file__).resolve().parent.parent
HOME = REPO_ROOT / "templates" / "home.html"
MAIN_CSS = REPO_ROOT / "static" / "css" / "main.css"

#: Ranges that cover the emoji blocks used in marketing copy elsewhere.
EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF]"
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class LandingHeroTests(TestCase):
    def setUp(self):
        self.home = read(HOME)
        self.css = read(MAIN_CSS)
        self.body = self.client.get("/").content.decode()

    def test_the_page_still_renders_with_its_old_anchors(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        for anchor in ("hero", "landing-sec", "cta-band", "faq-item", "cmp-table"):
            self.assertIn(anchor, self.body, anchor)

    def test_the_headline_has_a_drawn_underline_that_survives_the_gradient(self):
        """`background-clip: text` would erase a stroke drawn on the wrapper."""
        self.assertIn('class="hl"', self.home)
        self.assertIn('<span class="hl-text">در یک لینک</span>', self.home)
        self.assertIn('class="hl-stroke"', self.home)
        self.assertEqual(self.home.count('<svg class="hl-stroke"'), 1)
        # two strokes, one behind the other, is what reads as a hand drawing
        stroke = self.home[self.home.index('class="hl-stroke"'):]
        stroke = stroke[: stroke.index("</svg>")]
        self.assertEqual(stroke.count("<path"), 2)
        self.assertIn(".hero h1 .hl-text {", self.css)
        self.assertIn("background-clip: text", self.css)

    def test_the_number_strip_states_facts_not_usage(self):
        stats = self.home[self.home.index('class="hero-stats"'):]
        stats = stats[: stats.index("</dl>")]
        self.assertEqual(stats.count('class="hero-stat"'), 4)
        self.assertEqual(stats.count("<dt>"), 4)
        self.assertEqual(stats.count("<dd>"), 4)
        for fact in ("لینک ثابت برای هر کلاس", "نصب برای مهمان", "گزینه در هر سوال"):
            self.assertIn(fact, stats)
        # the values are the limits the server actually enforces
        for value in ("۱", "۰", "۲–۱۰"):
            self.assertIn(f"<dd>{value}</dd>", stats)
        # no invented popularity metrics of the kind the reference site uses
        for banned in ("کاربر فعال", "دوره‌ی فعال", "مسیر یادگیری", "دانش‌آموز فعال"):
            self.assertNotIn(banned, self.body, banned)


class KeywordRibbonTests(TestCase):
    def setUp(self):
        self.home = read(HOME)
        self.css = read(MAIN_CSS)

    def test_it_is_two_identical_rows_so_the_loop_has_no_seam(self):
        rows = re.findall(r"<ul class=\"ribbon-row\"[^>]*>(.*?)</ul>", self.home, re.S)
        self.assertEqual(len(rows), 2)
        # identical content; only the second copy hides its separators from AT
        self.assertEqual(rows[0].replace(' aria-hidden="true"', ""), rows[1])
        self.assertIn('<ul class="ribbon-row" aria-hidden="true">', self.home)
        # the separators are shapes, not glyphs — the UI never uses emoji
        self.assertIn('<li class="ribbon-sep" aria-hidden="true"></li>', self.home)
        self.assertIn(".ribbon-row .ribbon-sep {", self.css)

    def test_it_moves_only_on_the_landing_page_and_stops_on_reduced_motion(self):
        self.assertIn("html.js-anim body.is-home .ribbon-track { animation:", self.css)
        self.assertIn(".ribbon:hover .ribbon-track { animation-play-state: paused; }", self.css)
        reduced = self.css[self.css.index("@media (prefers-reduced-motion: reduce)"):]
        self.assertIn("animation: none", reduced)
        self.assertIn("ribbon-track", reduced)

    def test_full_bleed_without_a_horizontal_scrollbar(self):
        ribbon = self.css[self.css.index(".ribbon {"):]
        ribbon = ribbon[: ribbon.index("}")]
        self.assertIn("calc(50% - 50vw)", ribbon)
        self.assertIn("width: 100vw", ribbon)
        self.assertIn("overflow: hidden", ribbon)
        # `clip`, not `hidden` — a scroll container would break the sticky header
        self.assertIn("body.is-home { overflow-x: clip; }", self.css)


class MoveCardsTests(TestCase):
    def setUp(self):
        self.home = read(HOME)
        self.css = read(MAIN_CSS)

    def test_three_numbered_moves_each_with_a_picture(self):
        section = self.home[self.home.index('class="moves"'):]
        section = section[: section.index("</ol>")]
        self.assertEqual(section.count('class="move"'), 3)
        for numeral in ("۰۱", "۰۲", "۰۳"):
            self.assertIn(f'<span class="move-num" aria-hidden="true">{numeral}</span>', section)
        self.assertEqual(section.count('class="move-mock" aria-hidden="true"'), 3)

    def test_the_mocks_are_decorative_and_hidden_from_screen_readers(self):
        """They are illustrations of the text, not information of their own."""
        for mock in re.findall(r'<div class="move-mock"[^>]*>', self.home):
            self.assertIn('aria-hidden="true"', mock)

    def test_they_stack_on_a_phone(self):
        flat = " ".join(self.css.split())
        self.assertIn(".moves { list-style: none; margin: 0; padding: 0; display: grid;", flat)
        self.assertIn("grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem;", flat)
        narrow = " ".join(self.css[self.css.index("@media (max-width: 860px)"):].split())
        self.assertIn(".moves { grid-template-columns: minmax(0, 1fr); }", narrow)


class InsideTheRoomTests(TestCase):
    def setUp(self):
        self.home = read(HOME)
        self.css = read(MAIN_CSS)

    def test_the_showcase_uses_the_same_network_vocabulary_as_the_room(self):
        section = self.home[self.home.index('class="showcase"'):]
        section = section[: section.index("</section>")]
        self.assertIn('class="sc-net" data-quality="poor"', section)
        self.assertIn('class="sc-badge sc-badge-net" data-quality="good"', section)
        self.assertIn(".sc-net[data-quality=\"poor\"]", self.css)

    def test_it_lists_four_things_a_teacher_cares_about(self):
        section = self.home[self.home.index('class="showcase-list"'):]
        section = section[: section.index("</ul>")]
        self.assertEqual(section.count("<li>"), 4)
        self.assertIn("چه کسی حرف می‌زند", section)
        self.assertIn("افت بسته", section)
        self.assertIn("دسترسی، تصمیم شماست", section)

    def test_the_mock_is_decorative(self):
        opening = re.search(r'<div class="showcase-mock"[^>]*>', self.home).group(0)
        self.assertIn('aria-hidden="true"', opening)


class LandingStyleRulesTests(TestCase):
    def setUp(self):
        self.home = read(HOME)
        self.css = read(MAIN_CSS)

    def test_no_emoji_in_the_landing_markup(self):
        self.assertEqual(EMOJI.findall(self.home), [])
        self.assertNotIn("✦", self.home)

    def test_the_palette_and_the_quiet_shadow_survive(self):
        block = self.css[self.css.index("   Landing refresh"):]
        self.assertIn("var(--gradient-brand)", block)
        self.assertIn("var(--radius-lg)", block)
        # text on the brand gradient comes from the token, not a hard-coded white
        self.assertIn("var(--on-primary)", block)
        self.assertNotIn("color: #fff", block)
        self.assertNotIn("box-shadow: 0 24px", block)

    def test_motion_is_opt_in(self):
        block = self.css[self.css.index("   Landing refresh"):]
        guarded = []
        for match in re.finditer(r"animation:", block):
            declaration = block[match.start(): block.index(";", match.start())]
            if "none" in declaration:
                continue          # the reduced-motion opt-out is not motion
            before = block[: match.start()]
            selector = before[before.rindex("}") + 1 if "}" in before else 0:]
            selector = selector[: selector.index("{")] if "{" in selector else selector
            guarded.append(" ".join(selector.split()))
        self.assertTrue(guarded)
        for selector in guarded:
            self.assertIn("body.is-home", selector, selector)
        # and the two pieces of decoration really are animated there
        self.assertIn("html.js-anim body.is-home .ribbon-track {", block)
        self.assertIn("html.js-anim body.is-home .sc-live i {", block)
        self.assertIn("html.js-anim body.is-home .hero h1 .hl-stroke path {", block)


class ComparisonTableTests(TestCase):
    """The table is a claim; the numbers above it must be the proof."""

    def setUp(self):
        self.home = read(HOME)
        self.css = read(MAIN_CSS)
        table = self.home[self.home.index('class="cmp-table"'):]
        self.table = table[: table.index("</table>")]
        self.head = self.table[self.table.index("<thead>"): self.table.index("</thead>")]
        self.body = self.table[self.table.index("<tbody>"): self.table.index("</tbody>")]

    @staticmethod
    def _fa(text: str) -> int:
        return int(text.translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹", "0123456789")))

    def test_each_column_scores_what_its_rows_actually_say(self):
        rows = re.findall(r'<th scope="row">.*?</th>(.*?)</tr>', self.body, re.S)
        self.assertEqual(len(rows), 10)
        columns = list(zip(*[re.findall(r'class="cmp-(yes|no|part)"', row) for row in rows]))
        self.assertEqual(len(columns), 4)
        shown = [self._fa(n) for n in re.findall(r"<b>([۰-۹]+)</b>", self.head)]
        self.assertEqual(len(shown), 4)
        self.assertEqual(shown, [col.count("yes") for col in columns])

    def test_the_count_is_labelled_so_it_cannot_be_read_as_a_grade(self):
        self.assertEqual(self.head.count('class="cmp-score"'), 4)
        self.assertEqual(self.head.count("از ۱۰ مورد") > 0, True)
        self.assertIn('class="cmp-us"', self.head)

    def test_a_legend_names_every_state_used_in_the_body(self):
        legend = self.home[self.home.index('class="cmp-legend"'):]
        legend = legend[: legend.index("</p>")]
        for state in ("cmp-yes", "cmp-part", "cmp-no"):
            self.assertIn(state, legend)
            self.assertIn(state, self.body)
        self.assertIn(".cmp-legend .cmp-legend-note", self.css)

    def test_the_row_label_stays_put_when_a_phone_scrolls_sideways(self):
        # several 720px blocks exist; find the one that pins the comparison table
        starts = [m.start() for m in re.finditer(r"@media \(max-width: 720px\)", self.css)]
        self.assertTrue(starts)
        phone = next(
            block for block in (
                self.css[at: self.css.index("@media", at + 10)]
                for at in starts
            )
            if ".cmp-table tbody th," in block
        )
        self.assertIn("position: sticky;", phone)
        self.assertIn("inset-inline-start: 0;", phone)
        self.assertIn("z-index: 3;", phone)
        # the rule must not leak into the desktop layout
        self.assertNotIn("tbody th {\n    position: sticky", self.css[: starts[0]])


class FaqAccordionTests(TestCase):
    def setUp(self):
        self.home = read(HOME)
        self.css = read(MAIN_CSS)

    def test_answers_are_exclusive_through_the_name_attribute(self):
        items = re.findall(r'<details class="faq-item"([^>]*)>', self.home)
        self.assertEqual(len(items), 5)
        for attrs in items:
            self.assertIn('name="faq"', attrs)

    def test_exactly_one_answer_starts_open(self):
        self.assertEqual(self.home.count('<details class="faq-item" name="faq" open>'), 1)

    def test_the_open_state_is_visible_without_javascript(self):
        self.assertIn(".faq-item[open] {", self.css)
        self.assertIn("color-mix(in srgb, var(--primary) 26%, var(--border))", self.css)
        # the entrance animation is decoration, so it is opt-in
        self.assertIn("html.js-anim body.is-home .faq-item[open] p {", self.css)


class ScrollProgressTests(TestCase):
    def setUp(self):
        self.base = read(REPO_ROOT / "templates" / "base.html")
        self.css = read(MAIN_CSS)
        self.js = read(REPO_ROOT / "static" / "js" / "motion.js")

    def test_the_hairline_lives_on_the_header_and_is_hidden_from_screen_readers(self):
        self.assertIn('<span class="scroll-progress" aria-hidden="true"></span>', self.base)
        self.assertIn("</header>", self.base)

    def test_it_only_appears_on_the_landing_page(self):
        self.assertIn("body.is-home .scroll-progress {", self.css)
        # no unguarded rule of its own anywhere in the sheet
        self.assertEqual(
            re.findall(r"(?m)^\.scroll-progress\s*\{", self.css), []
        )
        self.assertIn("bottom: -1px;", self.css)

    def test_it_grows_from_the_right_in_rtl(self):
        self.assertIn("transform: scaleX(var(--progress, 0));", self.css)
        self.assertIn("transform-origin: 100% 50%;", self.css)
        self.assertIn('[dir="ltr"] body.is-home .scroll-progress { transform-origin: 0% 50%; }', self.css)

    def test_the_script_clamps_the_fraction_and_resyncs_when_the_page_resizes(self):
        self.assertIn("function scrollFraction()", self.js)
        self.assertIn("Math.min(1, Math.max(0, window.scrollY / scrollable))", self.js)
        self.assertIn("if (scrollable <= 8) return 0;", self.js)
        self.assertIn("setProperty('--progress'", self.js)
        self.assertIn("window.addEventListener('resize', sync, { passive: true });", self.js)
        self.assertIn("window.addEventListener('load', sync);", self.js)

    def test_one_raf_drives_both_header_states(self):
        self.assertEqual(self.js.count("requestAnimationFrame(sync)"), 1)
        self.assertIn("classList.toggle('is-scrolled'", self.js)

    def test_reduced_motion_keeps_the_bar_but_drops_the_easing(self):
        block = self.css[self.css.index("body.is-home .scroll-progress"):]
        block = block[: block.index("@media (hover: none)") if "@media (hover: none)" in block else len(block)]
        self.assertIn("@media (prefers-reduced-motion: no-preference)", block)
