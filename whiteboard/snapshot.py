"""Snapshotting (compaction) for the whiteboard event log.

The board is event-sourced: every stroke is a row.  That is a fine write model
but a poor read model — replaying a year of operations to draw a board is slow,
and the old fixed replay window (``HISTORY_LIMIT``) simply dropped the beginning
of a busy board, so content disappeared for anybody who joined late or refreshed.

A snapshot is a materialised view of the board *as it is now*: the operations
that are still visible, in drawing order, with ``clear``/``remove`` already
applied.  Replay is then:

    snapshot.state["ops"]  +  events newer than snapshot.seq

which is bounded no matter how long the class has been running.

Fold semantics (kept deliberately equal to the client's ``_applyOp``):

* ``clear``      drops the other operations of that page (and that file scope),
                 keeping the ``page_setup`` marker so the background survives;
* ``remove``     drops one operation by id;
* ``page_add``   only raises ``pageCount`` (the page itself has no content);
* ``page_go``    is transient view state, never part of the board;
* ``laser``      is ephemeral and never reaches the database.
"""
from __future__ import annotations

from django.db import IntegrityError, transaction

from .models import WhiteboardEvent, WhiteboardSnapshot

STATE_VERSION = 1
# Fold once the tail passes this many events.  Kept well below the old replay
# window so a reconnect never re-sends a huge log.
COMPACT_AFTER = 1200
# How often a busy connection checks whether compaction is due (cheap count).
COMPACT_CHECK_EVERY = 200
# ``page_setup`` survives a clear (background colour / grid of the page).
_KEPT_ON_CLEAR = {"page_setup"}
# Only real content is materialised; laser/page_go are transient, and an
# unknown type (a future op the server does not know yet) is ignored rather
# than frozen into the snapshot forever.
_STORED = {"draw", "text", "page_setup"}


def empty_state() -> dict:
    return {"version": STATE_VERSION, "pageCount": 1, "ops": []}


def normalise_state(state) -> dict:
    """Return a usable state dict even for a missing/old snapshot payload."""
    if not isinstance(state, dict):
        return empty_state()
    ops = state.get("ops")
    if not isinstance(ops, list):
        ops = []
    try:
        page_count = int(state.get("pageCount") or 1)
    except (TypeError, ValueError):
        page_count = 1
    return {
        "version": STATE_VERSION,
        "pageCount": max(1, page_count),
        "ops": [op for op in ops if isinstance(op, dict)],
    }


def _file_scope(op: dict):
    file_id = op.get("file_id")
    return file_id if isinstance(file_id, int) and not isinstance(file_id, bool) else None


def apply_op(state: dict, op) -> dict:
    """Fold one operation into ``state`` (mutates and returns it)."""
    if not isinstance(op, dict):
        return state
    op_type = op.get("type")

    page = op.get("page")
    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        page = 1

    if op_type == "page_add":
        state["pageCount"] = max(state["pageCount"], page)
        return state

    if op_type == "clear":
        scope = _file_scope(op)
        state["ops"] = [
            other for other in state["ops"]
            if not (
                other.get("page", 1) == page
                and other.get("type") not in _KEPT_ON_CLEAR
                and _file_scope(other) == scope
            )
        ]
        return state

    if op_type == "remove":
        target = op.get("id")
        if target:
            state["ops"] = [other for other in state["ops"] if other.get("id") != target]
        return state

    if op_type not in _STORED:
        return state

    # Content on that page.
    op = {**op, "page": page}
    if op.get("id"):
        state["ops"] = [other for other in state["ops"] if other.get("id") != op["id"]]
    state["ops"].append(op)
    state["pageCount"] = max(state["pageCount"], page)
    return state


def fold(state: dict, ops) -> dict:
    for op in ops:
        apply_op(state, op)
    return state


def compact_board(board_id: int, *, force: bool = False, threshold: int = COMPACT_AFTER):
    """Fold the event log into the board snapshot when it has grown enough.

    Returns ``(snapshot, folded_count)``.  Safe to call concurrently: the
    snapshot row is locked, and a losing creator retries against the winner's
    row instead of raising.  The cutoff is the highest *visible* event id, so an
    operation that commits later keeps a higher id and is replayed on top of the
    snapshot rather than being swallowed by it.
    """
    # Cheap pre-check: an index-only count, no row lock and no JSON payloads.
    # The hot path (a busy socket calling this every N strokes) must not read
    # the tail's operations just to decide there is nothing to do.
    current = (
        WhiteboardSnapshot.objects.filter(whiteboard_id=board_id).only("seq").first()
    )
    base = current.seq if current else 0
    if not force and WhiteboardEvent.objects.filter(
        whiteboard_id=board_id, id__gt=base
    ).count() <= threshold:
        return None, 0

    for _attempt in range(3):
        try:
            with transaction.atomic():
                snapshot = (
                    WhiteboardSnapshot.objects.select_for_update()
                    .filter(whiteboard_id=board_id)
                    .first()
                )
                state = normalise_state(snapshot.state) if snapshot else empty_state()
                base_seq = snapshot.seq if snapshot else 0
                events = list(
                    WhiteboardEvent.objects.filter(whiteboard_id=board_id, id__gt=base_seq)
                    .order_by("id")
                    .values_list("id", "operation")
                )
                if not events:
                    return snapshot, 0
                if len(events) <= threshold and not force:
                    return snapshot, 0
                cutoff = events[-1][0]
                state = fold(state, [op for _id, op in events])
                if snapshot is None:
                    snapshot = WhiteboardSnapshot.objects.create(
                        whiteboard_id=board_id, state=state, seq=cutoff
                    )
                else:
                    snapshot.state = state
                    snapshot.seq = cutoff
                    snapshot.save(update_fields=["state", "seq", "updated_at"])
                WhiteboardEvent.objects.filter(
                    whiteboard_id=board_id, id__lte=cutoff
                ).delete()
                return snapshot, len(events)
        except IntegrityError:
            # Another connection created the snapshot between our SELECT and
            # INSERT; retry and update its row instead.
            continue
    return None, 0


def snapshot_ops(snapshot: WhiteboardSnapshot | None) -> tuple[dict | None, int]:
    """Return ``(state, seq)`` for replay, or ``(None, 0)`` when there is none."""
    if snapshot is None:
        return None, 0
    return normalise_state(snapshot.state), snapshot.seq
