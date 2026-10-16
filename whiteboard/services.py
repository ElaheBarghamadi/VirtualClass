"""Board logic shared by the websocket consumer and the test-suite.

Everything in this module is synchronous: the consumer only wraps these
functions with ``database_sync_to_async``.  Keeping the database work here
means the board semantics (ordering, compaction, page renumbering, snapshot
compaction) can be tested directly, without sockets.

Two storage layers cooperate
---------------------------
1. **The operation log** (``WhiteboardEvent``) — every accepted operation in
   ``seq`` order.  This is the board's source of truth and what clients replay.
2. **The snapshot** (``Whiteboard.snapshot_ops``) — a *flattened* copy of the
   board (one operation per surviving object) published by a client that has
   the complete state.  A snapshot lets the server drop the older part of the
   log without ever losing what is on the board, exactly like Excalidraw's
   scene files.
"""
from __future__ import annotations

import json

from django.db import transaction
from django.db.models import Max

from classrooms.models import ClassroomMember
from classrooms.permissions import effective_permissions

from .models import Whiteboard, WhiteboardEvent
from .protocol import (
    EPHEMERAL_OP_TYPES,
    MAX_PAGES,
    OP_TYPES,
    PAGE_OP_TYPES,
    normalise_op,
    op_kind,
    validate_op,
)

#: Newest operations handed to a joining client when it must replay everything.
HISTORY_LIMIT = 4000
#: Hard safety cap: never stream more than this many rows to one client.
MAX_REPLAY_ROWS = 20000
#: When the live log grows past this, a fully synced client is asked to
#: publish a snapshot so the log can be compacted again.
SNAPSHOT_THRESHOLD = 3000
#: A published snapshot may not claim more objects than this.
MAX_SNAPSHOT_OPS = 20000
MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024

#: Structural operations survive a board ``clear`` so a replay keeps pages.
STRUCTURAL_KINDS = ("page_add", "page_dup", "page_remove", "page_setup", "page_go")
#: Kinds that are stored but never belong to a "page" of the board itself.
FILE_KINDS = ("draw", "text", "sticky", "update", "remove", "reorder", "clear")


# --------------------------------------------------------------------------- #
# Permission helpers
# --------------------------------------------------------------------------- #
def board_permissions(member: ClassroomMember) -> dict:
    """Effective board capabilities of one member (single source of truth)."""
    perms = effective_permissions(member, member.classroom)
    return {
        "can_draw": bool(perms.get("can_use_whiteboard")),
        "can_present": bool(perms.get("can_present")),
    }


def active_member(member_id: int, *, lock: bool = False) -> ClassroomMember | None:
    """Re-read a member row; ``None`` when the member is no longer active."""
    qs = ClassroomMember.objects.filter(
        id=member_id,
        is_active=True,
        in_waiting_room=False,
        classroom__is_active=True,
    ).select_related("classroom", "user")
    if lock:
        qs = qs.select_for_update(of=("self",))
    return qs.first()


# --------------------------------------------------------------------------- #
# Reading the board
# --------------------------------------------------------------------------- #
def event_payload(event: WhiteboardEvent) -> dict:
    return {
        "id": event.id,
        "seq": event.seq,
        "op": event.operation,
        "actor_identity": event.actor_identity,
        "actor_name": event.actor.name if event.actor else None,
    }


def board_state_payload(board: Whiteboard) -> dict:
    return {
        "page_count": int(board.page_count or 1),
        "pages": {str(page): style for page, style in board.page_styles().items()},
        "revision": int(board.revision or 0),
        "snapshot_seq": int(board.snapshot_seq or 0),
    }


def board_snapshot(
    classroom,
    *,
    since: int = 0,
    limit: int = HISTORY_LIMIT,
    member: ClassroomMember | None = None,
) -> dict:
    """Board metadata + the operations a connecting client still needs.

    ``full`` tells the client whether the payload *replaces* its local state.
    A client whose cursor is older than the compaction watermark can no longer
    be served incrementally (the operations in between are gone), and a client
    that is ahead of the server (rolled back database, restarted instance) is
    reset as well.
    """
    board, _ = Whiteboard.objects.get_or_create(classroom=classroom)
    since = max(0, int(since or 0))
    revision = int(board.revision or 0)
    watermark = max(int(board.compacted_before or 0), int(board.snapshot_seq or 0))
    full = since <= 0 or since > revision or since < watermark

    snapshot = None
    snapshot_seq = 0
    trimmed = False
    if full:
        if board.snapshot_seq:
            snapshot = list(board.snapshot_ops or [])
            snapshot_seq = int(board.snapshot_seq)
        limit = min(limit, MAX_REPLAY_ROWS)
        events = list(
            board.events.select_related("actor")
            .filter(seq__gt=snapshot_seq)
            .order_by("seq")[:limit]
        )
        remaining = revision - watermark
        trimmed = remaining > len(events)
    else:
        events = list(
            board.events.select_related("actor").filter(seq__gt=since).order_by("seq")[:limit]
        )

    payload = {
        "type": "whiteboard_history",
        "events": [event_payload(event) for event in events],
        "seq": revision,
        "full": full,
        "board": board_state_payload(board),
        "snapshot": snapshot,
        "snapshot_seq": snapshot_seq,
        "trimmed": trimmed,
        "needs_snapshot": bool(
            member is not None
            and board_permissions(member)["can_draw"]
            and revision - watermark > SNAPSHOT_THRESHOLD
        ),
    }
    return payload


# --------------------------------------------------------------------------- #
# Page structure
# --------------------------------------------------------------------------- #
def _board_ops(board: Whiteboard):
    """Operations that belong to the board pages (not to a shared document)."""
    return board.events.filter(operation__file_id__isnull=True)


def _shift_pages(board: Whiteboard, start: int, delta: int) -> None:
    """Renumber board pages >= ``start`` inside the log (insert / remove)."""
    if delta == 0 or start < 1:
        return
    affected = _board_ops(board).filter(page__gte=start)
    rows = list(affected.only("id", "page", "operation"))
    if not rows:
        board.shift_pages(start, delta)
        return
    for row in rows:
        row.page = row.page + delta
        operation = dict(row.operation or {})
        operation["page"] = row.page
        row.operation = operation
    WhiteboardEvent.objects.bulk_update(rows, ["page", "operation"], batch_size=500)
    board.shift_pages(start, delta)


def _apply_page_op(board: Whiteboard, op: dict) -> int:
    """Apply a structural operation to the board; returns its page number."""
    op_type = op["type"]
    page = int(op["page"])
    at = op.get("at")

    if op_type == "page_add":
        if at is not None:
            at = max(1, min(MAX_PAGES, int(at)))
            if board.page_count >= MAX_PAGES and at > board.page_count:
                raise OpRejected("board-full")
            grew = 1 if at <= board.page_count else 0
            _shift_pages(board, at, 1)
            board.page_count = min(MAX_PAGES, max(board.page_count + grew, at))
            board.set_page_style(at)
            return at
        if page <= board.page_count:
            raise OpRejected("page-exists")
        if page > MAX_PAGES:
            raise OpRejected("board-full")
        board.page_count = max(board.page_count, page)
        board.set_page_style(page)
        return page

    if op_type == "page_dup":
        if page > board.page_count:
            raise OpRejected("page-missing")
        target = int(at) if at is not None else page + 1
        target = max(1, min(MAX_PAGES, target))
        if board.page_count >= MAX_PAGES and target > board.page_count:
            raise OpRejected("board-full")
        sources = list(
            _board_ops(board)
            .filter(page=page)
            .exclude(kind__in=STRUCTURAL_KINDS)
            .order_by("seq")
            .values_list("operation", "actor_id", "actor_identity")
        )
        style = (board.pages or {}).get(str(page))
        grew = 1 if target <= board.page_count else 0
        _shift_pages(board, target, 1)
        board.page_count = min(MAX_PAGES, max(board.page_count + grew, target))
        board.set_page_style(target)
        if isinstance(style, dict):
            styles = dict(board.pages or {})
            styles[str(target)] = dict(style)
            board.pages = styles
        for operation, actor_id, identity in sources:
            payload = dict(operation)
            payload["page"] = target
            board.revision += 1
            WhiteboardEvent.objects.create(
                whiteboard=board,
                seq=board.revision,
                kind=op_kind(payload),
                scope=WhiteboardEvent.Scope.BOARD,
                actor_id=actor_id,
                actor_identity=identity,
                operation=payload,
                page=target,
            )
        return target

    if op_type == "page_remove":
        if board.page_count <= 1:
            raise OpRejected("last-page")
        if page > board.page_count:
            raise OpRejected("page-missing")
        _board_ops(board).filter(page=page).delete()
        _shift_pages(board, page + 1, -1)
        board.page_count = max(1, min(MAX_PAGES, board.page_count - 1))
        styles = dict(board.pages or {})
        styles.pop(str(page), None)
        board.pages = styles
        return page

    # page_setup / page_go
    if op_type == "page_setup":
        board.set_page_style(page, color=op.get("color"), grid=op.get("grid"))
    return page


def _compact(board: Whiteboard, op: dict) -> None:
    """Drop the operations made obsolete by a ``clear``; move the watermark."""
    if op.get("type") != "clear":
        return
    page = op["page"]
    qs = board.events.filter(page=page).exclude(kind__in=STRUCTURAL_KINDS)
    if op.get("file_id"):
        qs = qs.filter(operation__file_id=op["file_id"])
    else:
        qs = qs.filter(operation__file_id__isnull=True)
    highest = qs.aggregate(top=Max("seq"))["top"]
    if not highest:
        return
    qs.delete()
    watermark = max(int(board.compacted_before or 0), int(highest))
    board.compacted_before = min(watermark, int(board.revision or 0))


class OpRejected(Exception):
    """Raised when an operation cannot be applied to the board."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


# --------------------------------------------------------------------------- #
# Writing to the board
# --------------------------------------------------------------------------- #
def persist_ops(
    member: ClassroomMember, ops: list[dict]
) -> tuple[list[tuple[dict, int, int]], dict] | None:
    """Validate, apply and store a batch of client operations.

    Returns ``([(stored_op, seq, event_id), ...], board_state)`` or ``None``
    when the member may no longer draw (permission revoked while connected).  Raises
    :class:`OpRejected` when an operation is malformed, so the sender can be
    told instead of being silently ignored.
    """
    prepared: list[dict] = []
    for raw in ops:
        # Ephemeral traffic (pointers, in-progress strokes) is relayed live and
        # must never reach the log: it would be replayed to every late joiner
        # and would grow the board for no reason.
        if isinstance(raw, dict) and (
            raw.get("type") in EPHEMERAL_OP_TYPES or raw.get("live")
        ):
            raise OpRejected("ephemeral-op")
        reason = validate_op(raw)
        if reason:
            raise OpRejected(reason)
        prepared.append(normalise_op(raw))

    with transaction.atomic():
        locked = active_member(member.id, lock=True)
        if locked is None or not board_permissions(locked)["can_draw"]:
            return None
        board, _ = Whiteboard.objects.select_for_update().get_or_create(classroom=locked.classroom)
        member = locked

        stored: list[tuple[dict, int, int]] = []
        for op in prepared:
            op_type = op["type"]
            if op_type in PAGE_OP_TYPES:
                op["page"] = _apply_page_op(board, op)
            elif op_type == "clear":
                _compact(board, op)
            board.revision += 1
            if not op.get("id"):
                # A client that did not name its object still gets a stable id
                # so peers can select/move/remove it later.
                op["id"] = f"srv-{board.revision}"
            event = WhiteboardEvent.objects.create(
                whiteboard=board,
                seq=board.revision,
                kind=op_kind(op),
                scope=(
                    WhiteboardEvent.Scope.FILE
                    if op.get("file_id")
                    else WhiteboardEvent.Scope.BOARD
                ),
                actor=member.user if member.user_id else None,
                actor_identity=(member.identity or "")[:48],
                operation=op,
                page=op["page"],
            )
            stored.append((op, event.seq, event.id))

        board.save(
            update_fields=["revision", "page_count", "pages", "compacted_before", "updated_at"]
        )
        return stored, board_state_payload(board)


def store_snapshot(member: ClassroomMember, seq: int, ops: list) -> str | None:
    """Persist a client published snapshot; returns an error reason or None.

    The snapshot must be published by a client that is **exactly** caught up
    (``seq == board.revision``): anything else is stale and rejected, so two
    racing publishers can never truncate each other's work.
    """
    if not isinstance(ops, list) or len(ops) > MAX_SNAPSHOT_OPS:
        return "bad-snapshot"
    cleaned: list[dict] = []
    for raw in ops:
        if not isinstance(raw, dict) or raw.get("type") not in OP_TYPES:
            return "bad-snapshot-op"
        if not raw.get("id"):
            return "bad-snapshot-op:id-required"
        reason = validate_op(raw)
        if reason:
            return f"bad-snapshot-op:{reason}"
        if raw.get("type") in PAGE_OP_TYPES:
            return "bad-snapshot-op:structural"
        cleaned.append(normalise_op(raw))
    try:
        size = len(json.dumps(cleaned, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    except (TypeError, ValueError, UnicodeError):
        return "bad-snapshot"
    if size > MAX_SNAPSHOT_BYTES:
        return "snapshot-too-large"

    with transaction.atomic():
        locked = active_member(member.id, lock=True)
        if locked is None or not board_permissions(locked)["can_draw"]:
            return "forbidden"
        board = (
            Whiteboard.objects.select_for_update().filter(classroom=locked.classroom).first()
        )
        if board is None:
            return "stale-snapshot"
        if int(seq) != int(board.revision or 0):
            return "stale-snapshot"
        if len(cleaned) >= board.events.count():
            # Nothing to compact — keep the log untouched.
            return None
        board.snapshot_ops = cleaned
        board.snapshot_seq = int(seq)
        board.events.filter(seq__lte=int(seq)).delete()
        board.compacted_before = max(int(board.compacted_before or 0), int(seq))
        board.save(update_fields=["snapshot_ops", "snapshot_seq", "compacted_before", "updated_at"])
        return None


def clear_board(classroom) -> None:
    """Remove every stored operation of a board (used by tests / management)."""
    board = Whiteboard.objects.filter(classroom=classroom).first()
    if board is None:
        return
    board.events.all().delete()
    board.snapshot_ops = []
    board.snapshot_seq = 0
    board.compacted_before = 0
    board.revision = 0
    board.page_count = 1
    board.pages = {}
    board.save()
