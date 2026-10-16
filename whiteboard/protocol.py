"""Whiteboard operation protocol — the single source of truth.

The board is **event sourced**: the browser turns every interaction into a
small JSON *operation*, and the server validates it, persists it in order and
relays it to everybody else.  Nothing binary is ever uploaded, replaying a
board is cheap, and every participant derives the same picture from the same
ordered log.

Coordinates
-----------
* **board operations** (no ``file_id``) — positions are fractions of the
  board page (``x`` over the page width, ``y`` over the page height) so the
  drawing lands in the same relative spot on a phone, a projector or a
  desktop.  Stroke widths / font sizes use *reference units* where
  ``700`` units = one page height.  These ops carry ``norm: 1``.
* **annotation operations** (``file_id`` set) — produced by the presentation
  viewer and expressed in pixels of the rendered document page, which is what
  that module has always sent (``norm`` absent/falsy).

``validate_op()`` returns ``None`` for an acceptable operation, or a short
machine readable reason.  Reasons are logged server side, never echoed to the
client verbatim, so a hostile client learns nothing from a rejection.
"""
from __future__ import annotations

import json
import math
import re

# --------------------------------------------------------------------------- #
# Limits
# --------------------------------------------------------------------------- #
MAX_OP_BYTES = 64 * 1024
MAX_BATCH_OPS = 64
MAX_POINTS = 4096
MAX_LIVE_POINTS = 1024
MAX_TEXT_LEN = 600
MAX_STICKY_LEN = 1200
MAX_ID_LEN = 72
MAX_FILE_ID = 2_147_483_647
MAX_PAGES = 999
MAX_COLOR_LEN = 9

#: Positions may overshoot the page a little (drawing while zoomed in).
POSITION_LIMIT_NORM = 4.0
POSITION_LIMIT_PX = 1_000_000.0
SIZE_LIMIT_NORM = 260.0   # reference units (700 = page height)
SIZE_LIMIT_PX = 4096.0

RATE_LIMIT_OPS = 90        # operation frames per second, per connection
BATCH_COST_FREE = 8        # a batch frame costs max(1, len(ops) // BATCH_COST_FREE)

# --------------------------------------------------------------------------- #
# Vocabularies
# --------------------------------------------------------------------------- #
FREEHAND_TOOLS = frozenset({"pen", "highlighter", "eraser"})
SHAPE_TOOLS = frozenset({"line", "arrow", "rectangle", "ellipse", "triangle", "diamond", "star"})
VALID_TOOLS = FREEHAND_TOOLS | SHAPE_TOOLS

CONTENT_OP_TYPES = frozenset({"draw", "text", "sticky", "update", "remove", "reorder", "clear"})
PAGE_OP_TYPES = frozenset({"page_add", "page_dup", "page_remove", "page_setup", "page_go"})
EPHEMERAL_OP_TYPES = frozenset({"laser", "cursor"})
OP_TYPES = CONTENT_OP_TYPES | PAGE_OP_TYPES | EPHEMERAL_OP_TYPES

VALID_GRIDS = frozenset({"none", "grid", "dots", "lines", "graph"})
VALID_ALIGNS = frozenset({"start", "center", "end"})
VALID_MOVES = frozenset({"front", "back", "forward", "backward"})

#: ``update`` patches may only touch these keys.
PATCH_NUMERIC_KEYS = frozenset({"x", "y", "w", "h", "size", "opacity"})
PATCH_STRING_KEYS = frozenset({"color", "text", "align"})
PATCH_BOOL_KEYS = frozenset({"bold", "italic"})

_HEX_COLOR = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\Z")


# --------------------------------------------------------------------------- #
# Small typed helpers
# --------------------------------------------------------------------------- #
def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _finite(value, limit: float) -> bool:
    """True for a real finite number inside ``[-limit, limit]``."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, int):
        return -limit <= value <= limit
    return math.isfinite(value) and -limit <= value <= limit


def valid_color(value) -> bool:
    return isinstance(value, str) and _HEX_COLOR.match(value) is not None


def _is_normalized(op: dict) -> bool:
    """Both ``norm: 1`` and ``norm: true`` mean "page fractions"."""
    value = op.get("norm", False)
    if value is True or value == 1:
        return True
    return False


def position_ok(value, normalized: bool) -> bool:
    return _finite(value, POSITION_LIMIT_NORM if normalized else POSITION_LIMIT_PX)


def size_ok(value, normalized: bool) -> bool:
    return _finite(value, SIZE_LIMIT_NORM if normalized else SIZE_LIMIT_PX)


def _valid_id(value) -> bool:
    return isinstance(value, str) and 0 < len(value) <= MAX_ID_LEN


def _valid_points(points, normalized: bool, limit: int) -> bool:
    if not isinstance(points, list) or not 2 <= len(points) <= limit:
        return False
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            return False
        if not position_ok(point[0], normalized) or not position_ok(point[1], normalized):
            return False
    return True


def _valid_pressures(pressures, length: int) -> bool:
    if not isinstance(pressures, list) or len(pressures) != length:
        return False
    for value in pressures:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        if not math.isfinite(value) or not 0 <= value <= 1:
            return False
    return True


def _byte_size(op: dict) -> int | None:
    try:
        encoded = json.dumps(op, allow_nan=False, separators=(",", ":"), default=None)
        return len(encoded.encode("utf-8"))
    except (TypeError, ValueError, UnicodeError, RecursionError):
        return None


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def _check_common(op: dict) -> str | None:
    if "id" in op and op["id"] is not None and not _valid_id(op["id"]):
        return "bad-id"
    if "file_id" in op:
        file_id = op["file_id"]
        if not _is_int(file_id) or not 0 < file_id <= MAX_FILE_ID:
            return "bad-file-id"
    if "page" in op:
        page = op["page"]
        if not _is_int(page) or not 1 <= page <= MAX_PAGES:
            return "bad-page"
    if "color" in op and op["color"] is not None and not valid_color(op["color"]):
        return "bad-color"
    if "width" in op and (
        not size_ok(op["width"], _is_normalized(op)) or not op["width"] > 0
    ):
        return "bad-width"
    if "opacity" in op:
        value = op["opacity"]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return "bad-opacity"
        if not math.isfinite(value) or not 0 < value <= 1:
            return "bad-opacity"
    return None


def _check_draw(op: dict, normalized: bool, live: bool) -> str | None:
    tool = op.get("tool")
    if not isinstance(tool, str) or tool not in VALID_TOOLS:
        return "bad-tool"
    if live and tool not in FREEHAND_TOOLS:
        return "live-needs-freehand"

    limit = MAX_LIVE_POINTS if live else MAX_POINTS
    if "points" in op:
        if not _valid_points(op["points"], normalized, limit):
            return "bad-points"
        pressures = op.get("pressures")
        if pressures is not None and not _valid_pressures(pressures, len(op["points"])):
            return "bad-pressures"
    elif not live:
        # Legacy geometry (left/top + w/h or rx/ry) written by older clients.
        if not position_ok(op.get("left"), normalized) or not position_ok(op.get("top"), normalized):
            return "bad-shape-origin"
        if tool in {"rectangle", "ellipse"}:
            w = op.get("w", op.get("width"))
            h = op.get("h", op.get("height"))
            if not size_ok(w, normalized) or not size_ok(h, normalized) or w < 0 or h < 0:
                return "bad-shape-size"
        else:
            return "bad-points"
    if tool == "eraser" and op.get("color") not in (None, "eraser"):
        return "bad-eraser-color"
    return None


def _check_text(op: dict, normalized: bool) -> str | None:
    text = op.get("text")
    if not isinstance(text, str) or len(text) > MAX_TEXT_LEN:
        return "bad-text"
    if not position_ok(op.get("x"), normalized) or not position_ok(op.get("y"), normalized):
        return "bad-text-position"
    if "size" in op and (not size_ok(op["size"], normalized) or op["size"] <= 0):
        return "bad-text-size"
    if "align" in op and op["align"] not in VALID_ALIGNS:
        return "bad-align"
    for key in ("bold", "italic"):
        if key in op and not isinstance(op[key], bool):
            return f"bad-{key}"
    return None


def _check_sticky(op: dict, normalized: bool) -> str | None:
    text = op.get("text", "")
    if not isinstance(text, str) or len(text) > MAX_STICKY_LEN:
        return "bad-sticky-text"
    for key in ("x", "y"):
        if not position_ok(op.get(key), normalized):
            return f"bad-sticky-{key}"
    for key in ("w", "h"):
        value = op.get(key)
        if not size_ok(value, normalized) or value < 0:
            return f"bad-sticky-{key}"
    if "size" in op and (not size_ok(op["size"], normalized) or op["size"] <= 0):
        return "bad-sticky-size"
    if "align" in op and op["align"] not in VALID_ALIGNS:
        return "bad-align"
    return None


def _check_patch(op: dict, normalized: bool) -> str | None:
    patch = op.get("patch")
    if not isinstance(patch, dict) or not patch:
        return "bad-patch"
    if len(patch) > 12:
        return "bad-patch-size"
    if "points" in patch and not _valid_points(patch["points"], normalized, MAX_POINTS):
        return "bad-patch-points"
    for key, value in patch.items():
        if key == "points":
            continue
        if key in PATCH_NUMERIC_KEYS:
            if not size_ok(value, normalized):
                return f"bad-patch-{key}"
            if key in {"w", "h"} and value < 0:
                return f"bad-patch-{key}"
        elif key in PATCH_STRING_KEYS:
            if key == "color":
                if value is not None and not valid_color(value):
                    return "bad-patch-color"
            elif key == "text":
                if not isinstance(value, str) or len(value) > MAX_STICKY_LEN:
                    return "bad-patch-text"
            elif value not in VALID_ALIGNS:
                return "bad-patch-align"
        elif key in PATCH_BOOL_KEYS:
            if not isinstance(value, bool):
                return f"bad-patch-{key}"
        else:
            return "unknown-patch-key"
    return None


def _check_page_op(op: dict, op_type: str) -> str | None:
    page = op.get("page")
    if op_type != "page_add" and (not _is_int(page) or not 1 <= page <= MAX_PAGES):
        return "bad-page"
    if op_type == "page_add":
        if not _is_int(page) or not 1 <= page <= MAX_PAGES:
            return "bad-page"
        at = op.get("at")
        if at is not None and (not _is_int(at) or not 1 <= at <= MAX_PAGES):
            return "bad-position"
    if op_type in {"page_dup", "page_remove"}:
        at = op.get("at")
        if at is not None and (not _is_int(at) or not 1 <= at <= MAX_PAGES):
            return "bad-position"
    if op_type == "page_setup":
        if "color" not in op and "grid" not in op:
            return "empty-page-setup"
        grid = op.get("grid")
        if grid is not None and (not isinstance(grid, str) or grid not in VALID_GRIDS):
            return "bad-grid"
    return None


def validate_op(op, *, live: bool = False) -> str | None:
    """Return ``None`` when ``op`` is acceptable, else a rejection reason."""
    if not isinstance(op, dict):
        return "not-an-object"
    op_type = op.get("type")
    if not isinstance(op_type, str) or op_type not in OP_TYPES:
        return "unknown-type"

    size = _byte_size(op)
    if size is None:
        return "not-serialisable"
    if size > MAX_OP_BYTES:
        return "too-large"

    reason = _check_common(op)
    if reason:
        return reason

    normalized = _is_normalized(op)
    # Ops that *reference* something need an id; creation ops may omit it and
    # let the server name the object (keeps older clients compatible).
    if op_type in {"update", "remove", "reorder"} and not _valid_id(op.get("id")):
        return "id-required"

    if op_type == "draw":
        return _check_draw(op, normalized, live)
    if op_type == "text":
        return _check_text(op, normalized)
    if op_type == "sticky":
        return _check_sticky(op, normalized)
    if op_type == "update":
        return _check_patch(op, normalized)
    if op_type in {"remove", "clear"}:
        return None
    if op_type == "reorder":
        if op.get("move") not in VALID_MOVES:
            return "bad-move"
        return None
    if op_type in PAGE_OP_TYPES:
        return _check_page_op(op, op_type)
    if op_type in EPHEMERAL_OP_TYPES:
        if not position_ok(op.get("x"), normalized) or not position_ok(op.get("y"), normalized):
            return "bad-pointer"
        return None
    return "unknown-type"


# --------------------------------------------------------------------------- #
# Normalisation
# --------------------------------------------------------------------------- #
def normalise_op(op: dict, *, default_page: int = 1) -> dict:
    """Return a stored copy of ``op``: page pinned, floats rounded, no junk.

    Rounding keeps the JSON payload small (position is 4 decimals — far below
    one pixel even on a 4K projector) and guarantees that two clients that
    were fed the same numbers compute the same picture.
    """
    out = dict(op)
    page = out.get("page", default_page)
    if not _is_int(page) or not 1 <= page <= MAX_PAGES:
        page = default_page
    out["page"] = page

    def _round(value, digits=4):
        if isinstance(value, float):
            return round(value, digits)
        return value

    if isinstance(out.get("points"), list):
        out["points"] = [
            [*[_round(component) for component in point[:2]]] for point in out["points"]
        ]
    if isinstance(out.get("pressures"), list):
        out["pressures"] = [_round(value, 3) for value in out["pressures"]]
    for key in ("x", "y", "left", "top", "w", "h", "rx", "ry", "width", "size", "opacity", "norm"):
        if key in out:
            out[key] = _round(out[key])
    if isinstance(out.get("patch"), dict):
        out["patch"] = {key: _round(value) for key, value in out["patch"].items()}
    if out.get("norm") in (True, 1):
        out["norm"] = 1
    elif "norm" in out:
        out.pop("norm", None)
    text = out.get("text")
    if isinstance(text, str):
        out["text"] = text.strip() if len(text) <= MAX_STICKY_LEN else text[:MAX_STICKY_LEN]
    out.pop("ts", None)  # client clocks are untrusted and unused server side
    out.pop("live", None)
    return out


def op_kind(op: dict) -> str:
    """Short discriminator stored next to each row (fast compaction filters)."""
    op_type = op.get("type", "")
    if op_type == "draw":
        tool = op.get("tool")
        return f"draw:{tool}" if isinstance(tool, str) else "draw"
    return str(op_type)[:24]
