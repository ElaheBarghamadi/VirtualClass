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
        compact = rule(self.css, ".room-controls .ctrl-btn", needle="width: 38px; height: 38px;")
        self.assertIn("border-radius: 12px;", compact)
        dock = rule(self.css, ".room-controls", needle="border-radius: 14px;")
        self.assertIn("padding: 3px;", dock)
        # the rail stays one row: separators cost width, they go first
        self.assertIn(".room-controls .ctrl-sep { display: none; }", self.css)

    # -- «minimal, pastel, pretty»: the look is a contract too --------------
    def test_bar_is_flat_quiet_and_shadowless(self):
        bar = rule(self.css, ".room-controls", needle="--glass-line")
        self.assertIn("background: var(--glass);", bar)
        self.assertIn("border: 1px solid var(--glass-line);", bar)
        self.assertIn("box-shadow: none;", bar)
        self.assertNotIn("backdrop-filter", bar)
        self.assertNotIn("var(--shadow)", bar)

    def test_buttons_are_soft_squares_not_circles(self):
        btn = rule(self.css, ".ctrl-btn")
        self.assertIn("width: 40px; height: 40px;", btn)
        self.assertIn("border-radius: 13px;", btn)
        self.assertIn("background: transparent; border: 0;", btn)
        self.assertNotIn("box-shadow", btn)
        # a real button still answers the pointer and the keyboard
        self.assertIn(".ctrl-btn:hover {", self.css)
        self.assertIn(".ctrl-btn:active { transform: scale(.94); }", self.css)
        self.assertIn(".ctrl-btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }", self.css)

    def test_an_active_control_changes_colour(self):
        bar = rule(self.css, ".room-controls", needle="--glass-line")
        for token in ("--p-accent:", "--p-mint:", "--p-amber:", "--p-rose:"):
            self.assertIn(token, bar)
        active = rule(self.css, '.ctrl-btn.active,\n.ctrl-btn[aria-pressed="true"]')
        self.assertIn("background: var(--p-accent);", active)
        self.assertIn("color: var(--p-accent-ink);", active)
        # colour is also the state: each tool owns a different pastel, so two
        # active buttons never read as the same thing
        self.assertIn("var(--p-mint)", rule(self.css, "#btn-mic.active"))
        self.assertIn("var(--p-amber)", rule(self.css, "#btn-hand.active", needle="--p-amber"))
        self.assertIn("var(--p-rose)", rule(self.css, ".ctrl-btn.recording"))

    def test_every_pastel_state_token_is_defined_before_it_is_used(self):
        bar = rule(self.css, ".room-controls", needle="--glass-line")
        for name in ("accent", "mint", "amber", "rose"):
            self.assertIn(f"--p-{name}:", bar)
            self.assertIn(f"--p-{name}-ink:", bar)

    def test_mic_halo_breathes_with_the_live_level(self):
        halo = rule(self.css, "#btn-mic.active::before")
        self.assertIn("opacity: calc(var(--mic-level, 0) * .85);", halo)
        self.assertIn("pointer-events: none;", halo)
        self.assertIn("--mic-level", halo)
        self.assertIn("pointer-events: none;", halo)
        # the value comes from the real analyser, never from a timer guessing
        self.assertIn("setProperty('--mic-level', level.toFixed(3))", read(JS / "mesh.js"))

    def test_level_meter_is_three_bars_not_a_bottom_stripe(self):
        css = read(CSS / "room.css")
        meter = rule(css, ".tile-level")
        self.assertIn("inset-block-start: 8px;", meter)
        self.assertIn("inset-inline-start: 8px;", meter)
        self.assertIn("opacity: 0;", meter)
        self.assertNotIn("inset-block-end: 0", meter)
        self.assertNotIn("height: 3px", meter)
        self.assertIn(".tile.speaking .tile-level { opacity: 1; }", css)
        for n in (1, 2, 3):
            self.assertIn(f".tile-level i:nth-child({n}) {{ transform: scaleY(calc(", css)
        # the markup matches the CSS: a <span> with three <i> bars
        for source in (read(JS / "mesh.js"), read(JS / "media.js")):
            self.assertIn("level.innerHTML = '<i></i><i></i><i></i>'", source)

    def test_popovers_never_grow_past_the_screen(self):
        pop = self.js[self.js.index("function anchorPopover("):]
        pop = pop[: pop.index("\n}\n")]
        self.assertIn("pop.style.maxHeight", pop)
        self.assertIn("overflowY", pop)

class MediaTuningTests(SimpleTestCase):
    """A mesh multiplies every upload by the size of the room.

    Twelve cameras at 1280×720 is 12×1.6 Mbps leaving *each* laptop, which is
    exactly the «بهم نریزه» case: the picture freezes, audio stutters, tiles go
    black.  The fix is to shrink both the capture and the per-sender bitrate as
    the room grows — never to fake the quality readout.
    """

    def setUp(self):
        self.src = read(JS / "mesh.js")

    def test_the_tier_table_shrinks_as_the_room_grows(self):
        tier = rule(self.src, "    _qualityTier(size = this._roomSize())")
        sizes = re.findall(r"size <= (\d+)\) return \{ width: (\d+), height: (\d+), fps: (\d+), bitrate: ([\d_]+)", tier)
        self.assertEqual([int(s[0]) for s in sizes], [2, 4, 6])
        widths = [int(s[1]) for s in sizes]
        bitrates = [int(s[4].replace("_", "")) for s in sizes]
        self.assertEqual(widths, sorted(widths, reverse=True))
        self.assertEqual(bitrates, sorted(bitrates, reverse=True))
        # and there is a floor for a big class, not «unlimited»
        self.assertIn("return { width: 480, height: 270, fps: 18, bitrate: 320_000 };", tier)

    def test_room_size_counts_the_local_participant(self):
        self.assertIn("return this.links.size + 1;", rule(self.src, "    _roomSize()"))

    def test_every_sender_gets_a_bitrate_and_framerate_cap(self):
        tune = rule(self.src, "    _tuneLink(link)")
        self.assertIn("params.encodings[0].maxBitrate = tier.bitrate;", tune)
        self.assertIn("params.encodings[0].maxFramerate = tier.fps;", tune)
        self.assertIn("params.degradationPreference = 'balanced';", tune)
        # audio is capped too: a dozen Opus streams must not eat the video's
        # bandwidth in a mesh
        self.assertIn("params.encodings[0].maxBitrate = 40_000;", tune)
        self.assertIn("track.contentHint = 'speech'", tune)

    def test_tuning_can_never_break_a_call_on_safari(self):
        # setParameters/getParameters throw on some Safari versions: a throw
        # here used to abort the whole negotiation
        tune = rule(self.src, "    _tuneLink(link)")
        self.assertIn("try {", tune)
        self.assertIn("} catch (e) {", tune)
        self.assertIn(".catch(() => {})", tune)

    def test_capture_follows_the_tier(self):
        video = rule(self.src, "    _videoConstraints(deviceId)")
        self.assertIn("width: { ideal: tier.width },", video)
        self.assertIn("height: { ideal: tier.height },", video)
        self.assertIn("frameRate: { ideal: tier.fps, max: 30 },", video)
        self.assertIn("resizeMode: 'crop-and-scale',", video)
        audio = rule(self.src, "    _audioConstraints(deviceId)")
        self.assertIn("channelCount: 1,", audio)
        self.assertIn("sampleRate: 48000,", audio)

    def test_a_growing_room_shrinks_the_live_camera(self):
        adapt = rule(self.src, "    _adaptCapture(tier = this._qualityTier())")
        self.assertIn("applyConstraints", adapt)
        self.assertIn("this._captureTier === tier.width", adapt)
        # a camera that refuses the constraint keeps its old size
        self.assertIn(".catch(() => {", adapt)

    def test_retuning_is_a_no_op_unless_the_room_really_changed(self):
        start = self.src.index("    _retuneAll(")
        retune = self.src[self.src.index(") {", start):]
        retune = retune[: retune.index("\n    }")]
        self.assertIn("this._tunedTier === tier.width && this._tunedPeers === this.links.size", retune)
        self.assertIn("if (!force", retune)
        # a new track tunes its own link at once; joins/leaves retune the room
        self.assertIn("this.mesh._tuneLink(this);", rule(self.src, "    addLocalTracks(stream)"))
        for anchor in ("syncPeers(", "_removePeer("):
            body = block_after(self.src, self.src.index(f"    {anchor}"))
            self.assertIn("_retuneAll(", body, anchor)

    def test_remote_media_is_autoplaying_and_inline(self):
        self.assertIn("video.autoplay = true;", self.src)
        self.assertIn("video.playsInline = true;", self.src)
