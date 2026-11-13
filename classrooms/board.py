"""Board geometry — the whiteboard's reference surface.

Every stroke is stored against a reference rectangle, never against a screen.
The presenter picks one of the presets below and the room is told over the
presence socket; the client fits that rectangle into its own stage with a single
uniform scale, so the page keeps its shape on a phone, a tablet and a projector.

The presets are an allow-list, not free numbers: a size that slipped through
validation would be stored, replayed and exported forever.  Areas are kept close
to 840 000 reference px so switching format reflows the page instead of making
the ink microscopic (or gigantic).
"""
from __future__ import annotations

# preset key → (width, height) in reference units.
#
# Every preset is at least as wide as 1200 and at least as tall as 700 — the
# default page — so choosing a format never shrinks the sheet under ink that is
# already on it.  Ink keeps its coordinates (each op records the surface it was
# written on), so switching format re-frames the page around the drawing instead
# of stretching or cropping it.
BOARD_PRESETS: dict[str, tuple[int, int]] = {
    "12:7": (1200, 700),     # the classroom default
    "16:9": (1244, 700),     # slides: the same height, a little wider
    "4:3": (1200, 900),      # projector: the same width, a little taller
    "1:1": (1200, 1200),     # square: diagrams, geometry, drawing
    "a4": (1200, 1697),      # A4 portrait: handwriting, worksheets
}

DEFAULT_BOARD_PRESET = "12:7"
MIN_SIDE = 480
MAX_SIDE = 2000


def default_size() -> tuple[int, int]:
    return BOARD_PRESETS[DEFAULT_BOARD_PRESET]


def preset_key(width: int, height: int) -> str:
    """Which preset these dimensions are (``custom`` when none matches)."""
    for key, (w, h) in BOARD_PRESETS.items():
        if int(width) == w and int(height) == h:
            return key
    return "custom"


def size_for(preset: str) -> tuple[int, int] | None:
    """Dimensions for a preset key, or ``None`` when the key is not allowed."""
    key = str(preset or "").strip().lower()
    if key == "a4":
        return BOARD_PRESETS["a4"]
    return BOARD_PRESETS.get(key) if key in BOARD_PRESETS else None
