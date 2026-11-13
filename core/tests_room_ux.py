"""Room UX contracts: a fixed-size board, reactions that always answer, and a
control bar that can never disappear on a phone.

Three complaints, three root causes, all easy to reintroduce:

* the whiteboard was mapped onto its wrapper with *two independent* scales
  (``canvasW / REF_W`` and ``canvasH / REF_H``), so the "fixed" page took the
  shape of whatever screen it was on; it is a contained, letterboxed 12:7 page
  now, drawn with one uniform scale;
* ``showReaction()`` returned early — and the reduced-motion CSS set the bubble
  to ``opacity: 0`` — whenever the visitor asked the OS for less motion, which
  made the reaction button look broken;
* the control bar floated *over* the stage and sat underneath the mobile
  drawer's backdrop, so an opened drawer left a screen with no reachable button.
"""
from __future__ import annotations

import re
from pathlib import Path

from django.test import SimpleTestCase

REPO_ROOT = Path(__file__).resolve().parent.parent
STATIC = REPO_ROOT / "static"
JS = STATIC / "js"
CSS = STATIC / "css"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def block_after(source: str, start: int) -> str:
    """The body of the ``{ … }`` that starts at or after ``start``.

    Braces are counted, not searched: both CSS and the JS here contain ``{``
    inside `${…}` template literals, and a naive ``index("}")`` cut the block in
    half the first time a rule used one.
    """
    i = source.index("{", start)
    depth = 0
    for j in range(i, len(source)):
        if source[j] == "{":
            depth += 1
        elif source[j] == "}":
            depth -= 1
            if depth == 0:
                return source[i + 1: j]
    raise AssertionError("unbalanced braces")


def rule(source: str, selector: str, needle: str | None = None) -> str:
    """The body of ``selector { … }`` — optionally the block containing ``needle``.

    Several selectors are repeated inside media queries, so a test that wants
    the *base* rule says which declaration makes it unique.
    """
    for match in re.finditer(re.escape(selector) + r"\s*\{", source):
        body = block_after(source, match.start())
        if needle is None or needle in body:
            return body
    raise AssertionError(f"no rule for {selector} (needle={needle!r})")


def media(source: str, query: str) -> list[str]:
    """Every ``@media <query> { … }`` body — the same query is used many times."""
    return [
        block_after(source, match.start())
        for match in re.finditer(re.escape(f"@media {query}") + r"\s*\{", source)
    ]


def any_media(source: str, query: str, *needles: str) -> bool:
    return any(all(n in body for n in needles) for body in media(source, query))


class FixedBoardTests(SimpleTestCase):
    """The board is one size, everywhere."""

    def setUp(self):
        self.src = read(JS / "whiteboard.js")

    def test_both_axes_share_one_fit_scale(self):
        fit = rule(self.src, "    _fit()")
        self.assertIn("Math.min(this._w() / REF_W, this._h() / REF_H)", fit)
        # `_sx`/`_sy` are kept for their many call sites (pen width, labels)
        # but they must now be the same number.
        self.assertIn("return this._fit()", rule(self.src, "    _sx()"))
        self.assertIn("return this._fit()", rule(self.src, "    _sy()"))

    def test_viewport_transform_is_uniform(self):
        transform = rule(self.src, "    _applyTransform()")
        self.assertIn("setViewportTransform([s, 0, 0, s,", transform)
        self.assertNotIn("this._sx() * ", transform)
        self.assertNotIn("this._sy() * ", transform)

    def test_page_is_letterboxed_not_stretched(self):
        self.assertIn("_ox()", self.src)
        self.assertIn("_oy()", self.src)
        # the page rect is what the editor, the pan clamp and the export use
        self.assertIn("_pageRect()", self.src)

    def test_inked_page_background_follows_the_page(self):
        self.assertIn("_applyBgLayer()", rule(self.src, "    _applyTransform()"))
        layer = rule(self.src, "    _applyBgLayer()")
        self.assertIn("page.w", layer)
        self.assertIn("backgroundSize", layer)

    def test_png_export_has_a_fixed_size_too(self):
        export = self.src[self.src.index("exportPNG() {"):]
        export = export[: export.index("\n    }")]
        self.assertIn("const outW = REF_W * mult;", export)
        self.assertIn("const outH = REF_H * mult;", export)

    def test_pointer_is_clamped_to_the_page(self):
        self.assertIn("_clampToPage", rule(self.src, "    _pt(opt)"))

    def test_wrapper_reads_as_a_desk_not_as_the_paper(self):
        css = read(CSS / "room.css")
        wrap = rule(css, ".wb-canvas-wrap")
        self.assertIn("background: color-mix(", wrap)
        # the page itself gets an edge + shadow so its fixed shape is visible
        self.assertIn("box-shadow", rule(css, ".wb-bg"))


class ReactionFeedbackTests(SimpleTestCase):
    """A reaction tap always produces something on screen."""

    def setUp(self):
        self.src = read(JS / "room.js")
        self.css = read(CSS / "room.css")

    def test_reduced_motion_no_longer_swallows_the_bubble(self):
        body = self.src[self.src.index("function showReaction("):]
        body = body[: body.index("\n}\n")]
        self.assertNotIn("=== 'reduced') return;", body)
        self.assertIn("is-still", body)

    def test_reduced_motion_css_keeps_the_bubble_visible(self):
        self.assertTrue(any_media(
            self.css, "(prefers-reduced-motion: reduce)",
            ".reaction-bubble { animation: none; opacity: 1;",
        ))
        self.assertNotIn("opacity: 0", rule(self.css, ".reaction-bubble.is-still"))

    def test_sender_sees_their_own_reaction_immediately(self):
        send = self.src[self.src.index("function sendReaction("):]
        send = send[: send.index("\n}\n")]
        self.assertIn("presence.send({ action: 'reaction'", send)
        self.assertIn("showReaction(key", send)
        # …and a dropped socket says so instead of doing nothing
        self.assertIn("toast(", send)

    def test_echo_of_an_own_reaction_is_not_painted_twice(self):
        self.assertIn("_isOwnReactionEcho(data.reaction, data.member_id)", self.src)
        self.assertIn("_noteLocalReaction", self.src)

    def test_tray_buttons_are_thumb_sized_on_a_phone(self):
        self.assertTrue(any_media(
            self.css, "(max-width: 700px)",
            ".reaction-tray button { width: 42px; height: 42px; }",
        ))
        self.assertTrue(any_media(
            self.css, "(pointer: coarse)",
            ".reaction-tray button { width: 46px; height: 46px; }",
        ))


class ControlBarTests(SimpleTestCase):
    """The dock is part of the layout, in every state."""

    def setUp(self):
        self.css = read(CSS / "room.css")
        self.js = read(JS / "room.js")

    def test_bar_is_docked_instead_of_floating_over_the_video(self):
        # the base rule is the one that declares the glass tokens
        bar = rule(self.css, ".room-controls", needle="--glass-line")
        self.assertIn("position: relative;", bar)
        self.assertNotIn("position: absolute;", bar)
        self.assertNotIn("bottom: calc(.9rem", bar)
        self.assertIn("width: 100%;", bar)

    def test_room_main_is_a_column_that_does_not_reserve_the_bar(self):
        main = rule(self.css, ".room-main", needle="flex-direction: column")
        self.assertIn("flex-direction: column;", main)
        self.assertNotIn("var(--bar-h)", main)

    def test_mobile_drawer_stops_above_the_bar(self):
        self.assertTrue(any_media(
            self.css, "(max-width: 900px)", "inset-block-end: calc(var(--bar-h",
        ))
        self.assertTrue(any_media(
            self.css, "(max-width: 900px)", "bottom: calc(var(--bar-h",
        ))
        # the drawer carries a visible, pinned close button
        self.assertTrue(any_media(
            self.css, "(max-width: 900px)", "position: sticky;", ".drawer-close {",
        ))

    def test_bar_controls_also_close_an_open_drawer(self):
        drawer = self.js[self.js.index("function initDrawer("):]
        drawer = drawer[: drawer.index("\n}\n")]
        self.assertIn(".room-controls", drawer)
        self.assertIn("setDrawer(false)", drawer)

    def test_bar_is_compact_on_a_phone(self):
        self.assertTrue(any_media(
            self.css, "(max-width: 700px)",
            ".room-controls .ctrl-btn { width: 38px; height: 38px;",
        ))

    def test_popovers_never_grow_past_the_screen(self):
        pop = self.js[self.js.index("function anchorPopover("):]
        pop = pop[: pop.index("\n}\n")]
        self.assertIn("pop.style.maxHeight", pop)
        self.assertIn("overflowY", pop)
