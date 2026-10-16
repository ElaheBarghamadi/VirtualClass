"""Tests for the collaborative whiteboard.

Three layers are covered:

* ``whiteboard.protocol`` — pure operation validation (no database);
* ``whiteboard.services`` — ordering, compaction, page renumbering, snapshots;
* ``WhiteboardConsumer`` — the real ASGI websocket, including permissions,
  ephemeral ops, batching, resync and presence.
"""
from __future__ import annotations

import asyncio
import json

from asgiref.sync import async_to_sync
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, TransactionTestCase

from classrooms.permissions import Role
from classrooms.services import (
    create_classroom,
    join_classroom,
    set_member_permission,
    set_member_role,
)
from classrooms.ws_security import RateLimiter
from whiteboard import services
from whiteboard.models import Whiteboard, WhiteboardEvent
from whiteboard.protocol import (
    MAX_ID_LEN,
    normalise_op,
    op_kind,
    validate_op,
)
from whiteboard.routing import websocket_urlpatterns as wb_routes

User = get_user_model()


def app_with_user(user, routes):
    """Websocket app with an authenticated scope (what AuthMiddlewareStack does)."""
    inner = URLRouter(routes)

    async def app(scope, receive, send):
        scope = dict(scope)
        scope["user"] = user
        await inner(scope, receive, send)

    return app


def stroke(op_id="s1", **extra):
    """A minimal valid normalised pen stroke (page fractions)."""
    op = {
        "type": "draw",
        "tool": "pen",
        "id": op_id,
        "norm": 1,
        "page": 1,
        "points": [[0.1, 0.2], [0.2, 0.3], [0.3, 0.4]],
        "color": "#2563eb",
        "width": 4,
    }
    op.update(extra)
    return op


# --------------------------------------------------------------------------- #
# 1. Protocol
# --------------------------------------------------------------------------- #
class OpValidationTests(SimpleTestCase):
    def assert_reason(self, op, expected=None, **kwargs):
        reason = validate_op(op, **kwargs)
        if expected is None:
            self.assertIsNone(reason, reason)
        else:
            self.assertEqual(reason, expected)
        return reason

    def test_accepts_every_documented_operation(self):
        valid = [
            stroke(),
            {"type": "draw", "tool": "highlighter", "id": "h", "norm": 1, "points": [[0, 0], [1, 1]], "opacity": 0.4},
            {"type": "draw", "tool": "eraser", "id": "e", "norm": 1, "points": [[0, 0], [1, 1]], "color": None},
            {"type": "draw", "tool": "rectangle", "id": "r", "norm": 1, "points": [[0.1, 0.1], [0.5, 0.5]]},
            {"type": "draw", "tool": "star", "id": "st", "norm": 1, "points": [[0.1, 0.1], [0.5, 0.5]]},
            {"type": "text", "id": "t", "norm": 1, "x": 0.1, "y": 0.2, "text": "سلام", "size": 40, "color": "#111"},
            {"type": "sticky", "id": "n", "norm": 1, "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2, "text": "یادداشت"},
            {"type": "update", "id": "u", "norm": 1, "patch": {"x": 0.2, "text": "جدید", "color": "#000"}},
            {"type": "remove", "id": "x", "norm": 1},
            {"type": "reorder", "id": "z", "norm": 1, "move": "front"},
            {"type": "page_add", "page": 2, "id": "pa"},
            {"type": "page_add", "page": 2, "at": 1, "id": "pa2"},
            {"type": "page_dup", "page": 1, "at": 2, "id": "pd"},
            {"type": "page_remove", "page": 2, "id": "pr"},
            {"type": "page_setup", "page": 1, "color": "#ffffff", "grid": "dots", "id": "ps"},
            {"type": "page_go", "page": 3, "id": "pg"},
            {"type": "laser", "norm": 1, "x": 0.5, "y": 0.5, "id": "l"},
            {"type": "cursor", "norm": 1, "x": 0.1, "y": 0.1, "id": "c"},
            # presentation annotations stay in page pixels (no norm flag)
            {"type": "draw", "tool": "pen", "id": "f", "file_id": 7, "page": 2, "points": [[1.5, 2.5], [30, 40]], "width": 3},
            {"type": "clear", "id": "c2", "file_id": 7, "page": 2},
            # legacy geometry written by older clients must stay replayable
            {"type": "draw", "tool": "rectangle", "id": "legacy", "left": 10, "top": 20, "w": 30, "h": 40, "width": 2},
        ]
        for op in valid:
            with self.subTest(op=op.get("type"), id=op.get("id")):
                self.assert_reason(op)

    def test_creation_ops_may_omit_the_id_but_references_may_not(self):
        # older clients (and the presentation annotator) may not name a stroke
        self.assert_reason({"type": "draw", "tool": "pen", "file_id": 7, "page": 1, "points": [[1, 2], [2, 3]]})
        for op in (
            {"type": "remove", "norm": 1},
            {"type": "update", "norm": 1, "patch": {"x": 0.1}},
            {"type": "reorder", "norm": 1, "move": "front"},
        ):
            with self.subTest(op=op["type"]):
                self.assert_reason(op, "id-required")

    def test_rejects_unknown_or_malformed(self):
        cases = [
            ({"type": "nope"}, "unknown-type"),
            ("not-an-object", "not-an-object"),
            ({"type": "draw", "tool": "brush", "id": "1", "norm": 1, "points": [[0, 0], [1, 1]]}, "bad-tool"),
            ({"type": "draw", "tool": "pen", "id": "1", "norm": 1, "points": [[0, 0]]}, "bad-points"),
            ({"type": "draw", "tool": "pen", "id": "1", "norm": 1, "points": [[0, 0], [float("inf"), 1]]}, "not-serialisable"),
            ({"type": "draw", "tool": "pen", "id": "1", "norm": 1, "points": [[0, 0], [9, 1]]}, "bad-points"),
            (
                {"type": "draw", "tool": "pen", "id": "1", "norm": 1, "points": [[0, 0], [1, 1]], "pressures": [5]},
                "bad-pressures",
            ),
            ({"type": "draw", "tool": "eraser", "id": "1", "norm": 1, "points": [[0, 0], [1, 1]], "color": "#fff"}, "bad-eraser-color"),
            ({"type": "text", "id": "1", "norm": 1, "x": 0.1, "y": 0.1, "text": "x" * 700}, "bad-text"),
            ({"type": "text", "id": "1", "norm": 1, "x": 0.1, "y": 0.1, "text": "a", "align": "middle"}, "bad-align"),
            ({"type": "sticky", "id": "1", "norm": 1, "x": 0.1, "y": 0.1, "w": -1, "h": 0.1}, "bad-sticky-w"),
            ({"type": "update", "id": "1", "norm": 1, "patch": {}}, "bad-patch"),
            ({"type": "update", "id": "1", "norm": 1, "patch": {"rotation": 30}}, "unknown-patch-key"),
            ({"type": "update", "id": "1", "norm": 1, "patch": {"w": -0.2}}, "bad-patch-w"),
            ({"type": "reorder", "id": "1", "norm": 1, "move": "middle"}, "bad-move"),
            ({"type": "page_remove", "page": "2"}, "bad-page"),
            ({"type": "page_setup", "page": 1}, "empty-page-setup"),
            ({"type": "page_setup", "page": 1, "grid": "hex"}, "bad-grid"),
            ({"type": "page_go", "page": True}, "bad-page"),
            ({"type": "page_go", "page": 0}, "bad-page"),
            ({"type": "laser", "norm": 1, "x": 0.5}, "bad-pointer"),
            ({"type": "draw", "tool": "pen", "id": "1", "file_id": True, "points": [[0, 0], [1, 1]]}, "bad-file-id"),
            ({"type": "draw", "tool": "pen", "id": "1", "color": "red", "norm": 1, "points": [[0, 0], [1, 1]]}, "bad-color"),
            ({"type": "draw", "tool": "pen", "id": "1", "width": 0, "norm": 1, "points": [[0, 0], [1, 1]]}, "bad-width"),
            (stroke(id="x" * (MAX_ID_LEN + 1)), "bad-id"),
        ]
        for op, expected in cases:
            with self.subTest(expected=expected):
                self.assert_reason(op, expected)

    def test_oversized_operation_is_rejected(self):
        huge = stroke(points=[[0.1234, 0.1234]] * 9000)
        self.assertEqual(validate_op(huge), "too-large")
        # just under the byte limit, still bounded by the point limit
        self.assertEqual(validate_op(stroke(points=[[0.1, 0.1]] * 5000)), "bad-points")

    def test_live_streaming_ops_are_freehand_only_and_bounded(self):
        live = {"type": "draw", "tool": "pen", "id": "l1", "norm": 1, "live": True, "points": [[0, 0], [0.1, 0.1]]}
        self.assert_reason(live, live=True)
        shape_live = {"type": "draw", "tool": "rectangle", "id": "l2", "norm": 1, "live": True, "points": [[0, 0], [0.1, 0.1]]}
        self.assert_reason(shape_live, "live-needs-freehand", live=True)
        too_many = {"type": "draw", "tool": "pen", "id": "l3", "norm": 1, "points": [[0, 0]] * 2000}
        self.assert_reason(too_many, "bad-points", live=True)

    def test_normalise_op_rounds_and_strips_untrusted_fields(self):
        out = normalise_op(
            {
                "type": "draw",
                "tool": "pen",
                "id": "a",
                "norm": True,
                "ts": 123456,
                "live": True,
                "points": [[0.123456789, 0.2], [0.3, 0.4]],
                "width": 3.14159,
                "page": "2",
            }
        )
        self.assertEqual(out["page"], 1)  # bad page falls back to the default
        self.assertEqual(out["norm"], 1)
        self.assertNotIn("ts", out)
        self.assertNotIn("live", out)
        self.assertEqual(out["points"][0][0], 0.1235)
        self.assertEqual(out["width"], 3.1416)

    def test_op_kind_labels(self):
        self.assertEqual(op_kind(stroke()), "draw:pen")
        self.assertEqual(op_kind({"type": "clear"}), "clear")


class RateLimiterCostTests(SimpleTestCase):
    def test_cost_consumes_multiple_slots(self):
        limiter = RateLimiter(5, window=60)
        self.assertTrue(limiter.allow(3))
        self.assertFalse(limiter.allow(3))
        self.assertTrue(limiter.allow(2))
        self.assertFalse(limiter.allow())


# --------------------------------------------------------------------------- #
# 3. Services
# --------------------------------------------------------------------------- #
class BoardServiceTestCase(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="srv_owner", password="x")
        self.student = User.objects.create_user(username="srv_student", password="x")
        self.classroom = create_classroom(self.owner, title="Board")
        self.student_member = join_classroom(self.classroom, self.student)
        self.owner_member = self.classroom.members.get(user=self.owner)

    def member(self, user):
        return self.classroom.members.get(user=user)


# --------------------------------------------------------------------------- #
# 2. Client contract (captured headless-client session)
# --------------------------------------------------------------------------- #
class ClientContractTests(BoardServiceTestCase):
    """Replay of a real client session, captured from the headless JS harness.

    The capture is the *verbatim* traffic of ``static/js/whiteboard.js`` driving
    a full session (pen, highlighter, rectangle, eraser, undo/redo, text,
    sticky, move, z-order, page add/dup/remove, page style, clear) against this
    server.  It is a regression net for the two halves drifting apart: if the
    client starts sending something the server refuses, the log stops growing
    and this test fails.
    """

    SESSION = [
            {"type": "cursor", "page": 1, "norm": 1, "tool": "pen", "x": 0.0748, "y": 0.1221},
            {"type": "draw", "tool": "pen", "page": 1, "norm": 1, "color": "#dc2626", "width": 4, "points": [[0.0748, 0.1221], [0.1088, 0.1523], [0.1429, 0.1674], [0.1769, 0.1372], [0.2109, 0.1523], [0.2449, 0.1674], [0.2789, 0.1372], [0.3129, 0.1523], [0.3299, 0.1825]], "id": "u:7-mvaxplez-1"},
            {"type": "cursor", "page": 1, "norm": 1, "tool": "highlighter", "x": 0.1599, "y": 0.4244},
            {"type": "draw", "tool": "highlighter", "page": 1, "norm": 1, "color": "#dc2626", "width": 4, "points": [[0.1599, 0.4244], [0.415, 0.4546]], "opacity": 0.35, "id": "u:7-mvaxplf3-2"},
            {"type": "cursor", "page": 1, "norm": 1, "tool": "rectangle", "x": 0.5, "y": 0.1221},
            {"type": "draw", "tool": "rectangle", "page": 1, "norm": 1, "color": "#dc2626", "width": 4, "points": [[0.5, 0.1221], [0.6701, 0.3639]], "id": "u:7-mvaxplf5-3"},
            {"type": "remove", "id": "u:7-mvaxplf5-3", "page": 1, "norm": 1},
            {"type": "remove", "id": "u:7-mvaxplez-1", "page": 1, "norm": 1},
            {"type": "remove", "id": "u:7-mvaxplf3-2", "page": 1, "norm": 1},
            {"type": "cursor", "page": 1, "norm": 1, "tool": "pen", "x": 0.0323, "y": 0.5756},
            {"type": "draw", "tool": "pen", "page": 1, "norm": 1, "color": "#dc2626", "width": 4, "points": [[0.0323, 0.5756], [0.1599, 0.6058]], "id": "u:7-mvaxplfd-4"},
            {"type": "remove", "id": "u:7-mvaxplfd-4", "page": 1, "norm": 1},
            {"type": "draw", "tool": "pen", "page": 1, "norm": 1, "color": "#dc2626", "width": 4, "points": [[0.0323, 0.5756], [0.1599, 0.6058]], "id": "u:7-mvaxplfd-4"},
            {"type": "text", "id": "u:7-mvaxplho-5", "page": 1, "norm": 1, "x": 0.2449, "y": 0.7268, "text": "سلام تخته", "size": 30, "color": "#dc2626"},
            {"type": "sticky", "id": "u:7-mvaxplil-6", "page": 1, "norm": 1, "x": 0.585, "y": 0.7268, "w": 0.2652, "h": 0.3571, "text": "", "size": 26, "color": "#fde68a"},
            {"type": "update", "id": "u:7-mvaxplil-6", "page": 1, "norm": 1, "patch": {"text": "یادداشت"}},
            {"type": "update", "id": "u:7-mvaxplfd-4", "page": 1, "norm": 1, "patch": {"points": [[0.0833, 0.6361], [0.2109, 0.6663]]}},
            {"type": "remove", "id": "u:7-mvaxplfd-4", "page": 1, "norm": 1},
            {"type": "text", "id": "u:7-mvaxpln7-7", "page": 1, "norm": 1, "x": 0.269, "y": 0.7697, "text": "سلام تخته", "size": 30, "color": "#dc2626"},
            {"type": "sticky", "id": "u:7-mvaxpln7-8", "page": 1, "norm": 1, "x": 0.6091, "y": 0.7697, "w": 0.2652, "h": 0.3571, "text": "یادداشت", "size": 26, "color": "#fde68a"},
            {"type": "reorder", "id": "u:7-mvaxpln7-7", "page": 1, "norm": 1, "move": "front"},
            {"type": "reorder", "id": "u:7-mvaxpln7-8", "page": 1, "norm": 1, "move": "front"},
            {"type": "page_add", "id": "u:7-mvaxplnd-9", "page": 2, "at": 2, "norm": 1},
            {"type": "page_go", "id": "u:7-mvaxplne-10", "page": 2, "norm": 1},
            {"type": "cursor", "page": 2, "norm": 1, "tool": "pen", "x": 0.0408, "y": 0.0616},
            {"type": "draw", "tool": "pen", "page": 2, "norm": 1, "color": "#dc2626", "width": 4, "points": [[0.0408, 0.0616], [0.1259, 0.107]], "id": "u:7-mvaxploc-11"},
            {"type": "page_go", "id": "u:7-mvaxplod-12", "page": 1, "norm": 1},
            {"type": "page_dup", "id": "u:7-mvaxplpa-13", "page": 1, "at": 2, "norm": 1},
            {"type": "page_go", "id": "u:7-mvaxplpb-14", "page": 2, "norm": 1},
            {"type": "page_remove", "id": "u:7-mvaxplqu-15", "page": 3, "norm": 1},
            {"type": "page_go", "id": "u:7-mvaxplqv-16", "page": 2, "norm": 1},
            {"type": "page_setup", "id": "u:7-mvaxplrg-17", "page": 2, "color": "#fff7ed", "norm": 1},
            {"type": "page_setup", "id": "u:7-mvaxplrh-18", "page": 2, "grid": "grid", "norm": 1},
            {"type": "cursor", "page": 2, "norm": 1, "tool": "pen", "x": -0.0017, "y": 0.9535},
            {"type": "draw", "tool": "pen", "page": 2, "norm": 1, "color": "#111827", "width": 12, "points": [[-0.0017, 0.9535], [0.0663, 0.9686]], "id": "u:7-mvaxpls2-19"},
            {"type": "remove", "id": "u:7-mvaxpls2-19", "page": 2, "norm": 1},
            {"type": "draw", "tool": "pen", "page": 2, "norm": 1, "color": "#111827", "width": 12, "points": [[-0.0017, 0.9535], [0.0663, 0.9686]], "id": "u:7-mvaxpls2-19"},
            {"type": "cursor", "page": 2, "norm": 1, "tool": "pen", "x": 0.0153, "y": 0.8779},
            {"type": "draw", "tool": "pen", "page": 2, "norm": 1, "color": "#111827", "width": 12, "points": [[0.0153, 0.8779], [0.1003, 0.893]], "id": "u:7-mvaxpls4-20"},
            {"type": "cursor", "page": 2, "norm": 1, "tool": "pen", "x": 0.0663, "y": 0.107},
            {"type": "draw", "tool": "pen", "page": 2, "norm": 1, "color": "#111827", "width": 12, "points": [[0.0663, 0.107], [0.1088, 0.1523]], "id": "u:7-mvaxpm1m-21"},
            {"type": "clear", "id": "u:7-mvaxpm4a-22", "page": 2, "norm": 1},
    ]

    LIVE_TYPES = ("draw", "text", "sticky")

    def store(self, ops):
        """Persist a captured session the way the consumer does.

        Ephemeral frames (cursors, in-progress strokes) are relayed without
        being stored, so they are skipped here as well.
        """
        for op in ops:
            if op["type"] == "cursor":
                continue
            result = services.persist_ops(self.owner_member, [op])
            self.assertIsNotNone(result, f"client op rejected: {op}")
        return Whiteboard.objects.get(classroom=self.classroom)

    def expected_content(self):
        """Tiny second implementation of what the *client* ends up showing.

        Only content matters here (page structure is carried out of band by the
        board metadata), so this reduces the captured session to
        ``{page: {id: op}}`` exactly like ``wb/model.js`` would.
        """
        content = {}
        order = {}
        for op in self.SESSION:
            if op["type"] not in self.LIVE_TYPES and op["type"] not in {"update", "remove", "clear"}:
                continue
            page = content.setdefault(op["page"], {})
            order.setdefault(op["page"], [])
            if op["type"] == "clear":
                page.clear()
                order[op["page"]] = []
            elif op["type"] == "remove":
                # a re-add later in the log puts it back at its old depth
                page.pop(op["id"], None)
                if op["id"] in order[op["page"]]:
                    order[op["page"]].remove(op["id"])
            elif op["type"] == "update":
                if op["id"] in page:
                    page[op["id"]] = {**page[op["id"]], **op["patch"]}
            else:
                page[op["id"]] = op
                if op["id"] not in order[op["page"]]:
                    order[op["page"]].append(op["id"])
        return content, order

    def live_log_content(self, board):
        """Content the server would replay to a late joiner, reduced the same way."""
        content = {}
        for op in board.events.order_by("seq").values_list("operation", flat=True):
            if op["type"] not in self.LIVE_TYPES and op["type"] not in {"update", "remove", "clear"}:
                continue
            page = content.setdefault(op["page"], {})
            if op["type"] == "clear":
                page.clear()
            elif op["type"] == "remove":
                page.pop(op["id"], None)
            elif op["type"] == "update":
                if op["id"] in page:
                    page[op["id"]] = {**page[op["id"]], **op["patch"]}
            else:
                page[op["id"]] = op
        return content

    def test_a_captured_client_session_is_accepted_by_the_server(self):
        board = self.store(self.SESSION)

        # a new page, a duplicate, a page removal and a page clear all ran
        self.assertEqual(board.page_count, 2)
        self.assertGreater(WhiteboardEvent.objects.count(), 20)
        # every object the client ends up showing survived with its own id
        # (server ids are only minted for legacy id-less operations); pages the
        # session removed are compacted away and checked separately
        survivors = {
            op_id for objects in self.expected_content()[0].values() for op_id in objects
        }
        self.assertTrue(survivors)
        stored_ids = set(board.events.values_list("operation__id", flat=True))
        self.assertTrue(survivors <= stored_ids, survivors - stored_ids)

    def test_replayed_log_shows_the_same_picture_as_the_client(self):
        board = self.store(self.SESSION)
        expected, expected_order = self.expected_content()
        replayed = self.live_log_content(board)

        self.assertEqual(sorted(expected), sorted(replayed))
        for page, objects in expected.items():
            self.assertEqual(
                sorted(objects), sorted(replayed[page]),
                f"page {page}: different objects after replay",
            )
            # ...and in the same z-order
            self.assertEqual(
                list(replayed[page]), list(objects),
                f"page {page}: different painting order after replay",
            )
            for op_id, op in objects.items():
                self.assertEqual(op, replayed[page][op_id], f"{op_id} differs")

    def test_erased_objects_never_come_back(self):
        board = self.store(self.SESSION)
        survivors = {
            op_id for page in self.expected_content()[0].values() for op_id in page
        }
        self.assertTrue(survivors, "the session must leave something on the board")
        erased = sorted(survivors)[0]
        page = next(
            number for number, objects in self.expected_content()[0].items()
            if erased in objects
        )
        services.persist_ops(
            self.owner_member, [{"type": "remove", "id": erased, "page": page, "norm": 1}]
        )

        replayed = self.live_log_content(Whiteboard.objects.get(classroom=self.classroom))
        present = {op_id for objects in replayed.values() for op_id in objects}
        self.assertNotIn(erased, present)
        # ...and everything that was not erased is still there
        self.assertTrue(survivors - {erased} <= present)

    def test_ephemeral_traffic_is_refused_by_the_log(self):
        """Pointers and in-progress strokes are relayed, never recorded."""
        for op in self.SESSION:
            if op["type"] != "cursor":
                continue
            with self.assertRaises(services.OpRejected):
                services.persist_ops(self.owner_member, [op])
        for live in (
            {"type": "draw", "tool": "pen", "page": 1, "norm": 1, "live": True,
             "points": [[0.1, 0.1], [0.2, 0.2]], "color": "#000000", "width": 4},
            {"type": "laser", "page": 1, "norm": 1, "x": 0.5, "y": 0.5},
        ):
            with self.assertRaises(services.OpRejected):
                services.persist_ops(self.owner_member, [live])
        self.assertEqual(WhiteboardEvent.objects.count(), 0)

    def test_replay_is_complete_for_a_late_joiner(self):
        self.store(self.SESSION)
        snapshot = services.board_snapshot(self.classroom, member=self.owner_member)
        self.assertTrue(snapshot["full"])
        self.assertFalse(snapshot["trimmed"])
        self.assertEqual(snapshot["board"]["page_count"], 2)
        # the replayed log is a *subsequence* of what the client sent: page
        # removals compact whole pages away, but nothing is ever reordered
        sent = [op.get("id") for op in self.SESSION if op.get("id")]
        replayed = [event["op"].get("id") for event in snapshot["events"]]
        position = 0
        for op_id in replayed:
            while position < len(sent) and sent[position] != op_id:
                position += 1
            self.assertLess(position, len(sent), f"{op_id} is not in the client log order")
            position += 1


class BoardOrderingTests(BoardServiceTestCase):
    def test_sequences_are_strictly_increasing_and_survive_clear(self):
        services.persist_ops(self.owner_member, [stroke("a"), stroke("b")])
        services.persist_ops(self.owner_member, [{"type": "clear", "id": "c", "page": 1}])
        services.persist_ops(self.owner_member, [stroke("c")])

        board = Whiteboard.objects.get(classroom=self.classroom)
        seqs = list(board.events.order_by("seq").values_list("seq", flat=True))
        # the clear compacted the two strokes away (seq 1 and 2) and stayed in
        # the log itself; the next stroke continues at 4 — sequence numbers are
        # never reused, which is what makes reconnect/resync unambiguous
        self.assertEqual(seqs, [3, 4])
        self.assertEqual(board.revision, 4)
        # the clear dropped both strokes and moved the compaction watermark
        self.assertEqual(board.compacted_before, 2)
        self.assertFalse(board.events.filter(kind="draw:pen", seq__lt=3).exists())
        self.assertEqual(board.events.filter(kind="draw:pen").count(), 1)

    def test_permission_is_checked_inside_the_write(self):
        self.assertIsNone(services.persist_ops(self.member(self.student), [stroke("s")]))
        self.assertEqual(WhiteboardEvent.objects.count(), 0)

    def test_student_with_effective_permission_may_draw(self):
        self.classroom.allow_student_whiteboard = True
        self.classroom.save(update_fields=["allow_student_whiteboard"])
        set_member_permission(
            self.classroom, self.owner, self.student_member.id, "can_use_whiteboard", True
        )
        stored, _ = services.persist_ops(self.member(self.student), [stroke("s")])
        self.assertEqual(stored[0][1], 1)
        self.assertEqual(stored[0][0]["id"], "s")

    def test_rejects_malformed_batches_atomically(self):
        with self.assertRaises(services.OpRejected):
            services.persist_ops(self.owner_member, [stroke("ok"), {"type": "draw", "id": "bad"}])
        self.assertEqual(WhiteboardEvent.objects.count(), 0)


class PageStructureTests(BoardServiceTestCase):
    def test_page_add_appends_and_inserts_with_shift(self):
        services.persist_ops(self.owner_member, [stroke("p1"), {"type": "page_add", "page": 2, "id": "a2"}])
        services.persist_ops(self.owner_member, [stroke("p2", page=2)])
        # insert a fresh page before page 2 → the old page 2 moves to page 3
        services.persist_ops(self.owner_member, [{"type": "page_add", "page": 2, "at": 2, "id": "a3"}])

        board = Whiteboard.objects.get(classroom=self.classroom)
        self.assertEqual(board.page_count, 3)
        self.assertEqual(board.events.get(operation__id="p2").page, 3)
        self.assertEqual(board.events.get(operation__id="p2").operation["page"], 3)
        self.assertEqual(board.events.get(operation__id="a3").page, 2)

    def test_page_remove_renumbers_and_protects_the_last_page(self):
        services.persist_ops(
            self.owner_member,
            [stroke("one"), {"type": "page_add", "page": 2, "id": "a2"}, stroke("two", page=2)],
        )
        services.persist_ops(self.owner_member, [{"type": "page_remove", "page": 1, "id": "rm"}])
        board = Whiteboard.objects.get(classroom=self.classroom)
        self.assertEqual(board.page_count, 1)
        self.assertEqual(board.events.get(operation__id="two").page, 1)
        self.assertFalse(board.events.filter(operation__id="one").exists())
        with self.assertRaises(services.OpRejected):
            services.persist_ops(self.owner_member, [{"type": "page_remove", "page": 1, "id": "rm2"}])

    def test_page_duplicate_copies_content(self):
        services.persist_ops(self.owner_member, [stroke("orig")])
        services.persist_ops(self.owner_member, [{"type": "page_dup", "page": 1, "id": "dup"}])
        board = Whiteboard.objects.get(classroom=self.classroom)
        self.assertEqual(board.page_count, 2)
        copies = board.events.filter(kind="draw:pen", page=2)
        self.assertEqual(copies.count(), 1)
        self.assertEqual(copies.first().operation["id"], "orig")
        self.assertEqual(copies.first().operation["page"], 2)

    def test_page_setup_updates_styles(self):
        services.persist_ops(
            self.owner_member,
            [{"type": "page_setup", "page": 1, "color": "#ffefc2", "grid": "graph", "id": "s1"}],
        )
        board = Whiteboard.objects.get(classroom=self.classroom)
        self.assertEqual(board.page_style(1), {"color": "#ffefc2", "grid": "graph"})
        # unknown pages fall back to the defaults
        self.assertEqual(board.page_style(4), {"color": "#ffffff", "grid": "none"})

    def test_document_annotations_are_not_renumbered_by_page_ops(self):
        annotation = {
            "type": "draw",
            "tool": "pen",
            "id": "annot",
            "file_id": 9,
            "page": 3,
            "points": [[10, 10], [20, 20]],
            "width": 3,
        }
        services.persist_ops(self.owner_member, [annotation])
        services.persist_ops(self.owner_member, [{"type": "page_add", "page": 2, "id": "a2"}])
        services.persist_ops(self.owner_member, [{"type": "page_remove", "page": 1, "id": "rm"}])
        row = WhiteboardEvent.objects.get(operation__id="annot")
        self.assertEqual(row.scope, "file")
        self.assertEqual(row.page, 3)
        self.assertEqual(row.operation["page"], 3)

    def test_board_clear_keeps_page_structure_but_drops_content(self):
        services.persist_ops(
            self.owner_member,
            [
                stroke("a"),
                {"type": "page_setup", "page": 1, "grid": "lines", "id": "s"},
                {"type": "page_add", "page": 2, "id": "a2"},
                stroke("b", page=2),
            ],
        )
        services.persist_ops(self.owner_member, [{"type": "clear", "id": "c1", "page": 1}])
        board = Whiteboard.objects.get(classroom=self.classroom)
        self.assertFalse(board.events.filter(operation__id="a").exists())
        self.assertTrue(board.events.filter(operation__id="b").exists())
        self.assertTrue(board.events.filter(operation__id="s").exists())
        self.assertEqual(board.page_count, 2)
        self.assertEqual(board.page_style(1)["grid"], "lines")

    def test_file_clear_is_scoped_to_that_document(self):
        def annot(op_id, file_id, page=1):
            return {
                "type": "draw",
                "tool": "pen",
                "id": op_id,
                "file_id": file_id,
                "page": page,
                "points": [[1, 1], [2, 2]],
                "width": 2,
            }

        services.persist_ops(
            self.owner_member,
            [annot("f1", 5), annot("f2", 6), stroke("board")],
        )
        services.persist_ops(self.owner_member, [{"type": "clear", "id": "cf", "file_id": 5, "page": 1}])
        self.assertFalse(WhiteboardEvent.objects.filter(operation__id="f1").exists())
        self.assertTrue(WhiteboardEvent.objects.filter(operation__id="f2").exists())
        self.assertTrue(WhiteboardEvent.objects.filter(operation__id="board").exists())


class SnapshotTests(BoardServiceTestCase):
    def test_snapshot_is_delivered_and_compacts_the_log(self):
        services.persist_ops(self.owner_member, [stroke("keep"), stroke("drop")])
        services.persist_ops(
            self.owner_member, [{"type": "remove", "id": "drop", "norm": 1, "page": 1}]
        )
        board = Whiteboard.objects.get(classroom=self.classroom)
        seq = board.revision
        self.assertIsNone(
            services.store_snapshot(self.owner_member, seq, [stroke("keep")])
        )
        board.refresh_from_db()
        self.assertEqual(board.snapshot_seq, seq)
        self.assertEqual(board.compacted_before, seq)
        self.assertFalse(board.events.exists())

        payload = services.board_snapshot(self.classroom)
        self.assertEqual(payload["snapshot"], [normalise_op(stroke("keep"))])
        self.assertEqual(payload["snapshot_seq"], seq)
        self.assertEqual(payload["events"], [])
        self.assertFalse(payload["trimmed"])

    def test_snapshot_rejects_stale_or_structural_payloads(self):
        services.persist_ops(self.owner_member, [stroke("a")])
        board = Whiteboard.objects.get(classroom=self.classroom)
        self.assertEqual(
            services.store_snapshot(self.owner_member, board.revision - 1, [stroke("a")]),
            "stale-snapshot",
        )
        self.assertEqual(
            services.store_snapshot(
                self.owner_member, board.revision, [{"type": "page_add", "page": 2, "id": "p"}]
            ),
            "bad-snapshot-op:structural",
        )
        self.assertEqual(
            services.store_snapshot(
                self.owner_member, board.revision, [stroke("no-id", id=None) if False else {"type": "draw", "tool": "pen", "norm": 1, "points": [[0, 0], [1, 1]]}]
            ),
            "bad-snapshot-op:id-required",
        )
        # a member who may not draw may not publish board state either
        self.assertEqual(
            services.store_snapshot(self.member(self.student), board.revision, []), "forbidden"
        )

    def test_snapshot_is_not_taken_when_it_compacts_nothing(self):
        services.persist_ops(self.owner_member, [stroke("a"), stroke("b")])
        board = Whiteboard.objects.get(classroom=self.classroom)
        self.assertIsNone(
            services.store_snapshot(self.owner_member, board.revision, [stroke("a"), stroke("b")])
        )
        board.refresh_from_db()
        self.assertEqual(board.snapshot_seq, 0)
        self.assertEqual(board.events.count(), 2)


class BoardSnapshotSyncTests(BoardServiceTestCase):
    def test_first_connect_is_a_full_replay(self):
        services.persist_ops(self.owner_member, [stroke("a"), stroke("b")])
        payload = services.board_snapshot(self.classroom)
        self.assertTrue(payload["full"])
        self.assertEqual(payload["seq"], 2)
        self.assertEqual([event["op"]["id"] for event in payload["events"]], ["a", "b"])
        self.assertEqual(payload["board"]["page_count"], 1)

    def test_tail_resync_only_sends_what_is_missing(self):
        services.persist_ops(self.owner_member, [stroke("a")])
        services.persist_ops(self.owner_member, [stroke("b")])
        payload = services.board_snapshot(self.classroom, since=1)
        self.assertFalse(payload["full"])
        self.assertEqual([event["op"]["id"] for event in payload["events"]], ["b"])

    def test_cursor_behind_the_compaction_watermark_forces_a_full_replay(self):
        services.persist_ops(self.owner_member, [stroke("a"), stroke("b")])
        services.persist_ops(self.owner_member, [{"type": "clear", "id": "c", "page": 1}])
        board = Whiteboard.objects.get(classroom=self.classroom)
        payload = services.board_snapshot(self.classroom, since=1)
        self.assertTrue(payload["full"])
        self.assertEqual(payload["seq"], board.revision)

    def test_cursor_ahead_of_the_server_is_reset(self):
        services.persist_ops(self.owner_member, [stroke("a")])
        payload = services.board_snapshot(self.classroom, since=999)
        self.assertTrue(payload["full"])

    def test_needs_snapshot_flag_follows_the_threshold(self):
        services.persist_ops(self.owner_member, [stroke("a")])
        payload = services.board_snapshot(self.classroom, member=self.owner_member)
        self.assertFalse(payload["needs_snapshot"])

        board = Whiteboard.objects.get(classroom=self.classroom)
        Whiteboard.objects.filter(pk=board.pk).update(revision=services.SNAPSHOT_THRESHOLD + 5)
        payload = services.board_snapshot(self.classroom, member=self.owner_member)
        self.assertTrue(payload["needs_snapshot"])
        # a member who may not draw is never asked to publish state
        payload = services.board_snapshot(self.classroom, member=self.member(self.student))
        self.assertFalse(payload["needs_snapshot"])

    def test_replay_is_truncated_for_absurdly_long_logs(self):
        board = Whiteboard.objects.create(classroom=self.classroom)
        WhiteboardEvent.objects.bulk_create(
            [
                WhiteboardEvent(
                    whiteboard=board,
                    seq=i + 1,
                    kind="draw:pen",
                    actor=self.owner,
                    actor_identity=f"u:{self.owner.id}",
                    operation=stroke(f"s{i}"),
                    page=1,
                )
                for i in range(services.HISTORY_LIMIT + 25)
            ]
        )
        Whiteboard.objects.filter(pk=board.pk).update(revision=services.HISTORY_LIMIT + 25)
        payload = services.board_snapshot(self.classroom)
        self.assertTrue(payload["trimmed"])
        self.assertEqual(len(payload["events"]), services.HISTORY_LIMIT)


# --------------------------------------------------------------------------- #
# 3. Websocket consumer
# --------------------------------------------------------------------------- #
class WhiteboardConsumerTestCase(TransactionTestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="wb_owner", password="x")
        self.presenter = User.objects.create_user(username="wb_presenter", password="x")
        self.student = User.objects.create_user(username="wb_student", password="x")
        self.outsider = User.objects.create_user(username="wb_outsider", password="x")
        self.classroom = create_classroom(self.owner, title="WB")
        presenter_member = join_classroom(self.classroom, self.presenter)
        self.student_member = join_classroom(self.classroom, self.student)
        set_member_role(self.classroom, self.owner, presenter_member.id, Role.PRESENTER)

    def ws(self, user, query=""):
        return WebsocketCommunicator(
            app_with_user(user, wb_routes),
            f"/ws/classroom/{self.classroom.room_code}/whiteboard/{query}",
        )

    @staticmethod
    async def recv(ws, wanted: str, limit: int = 10):
        """Next frame of ``wanted`` type (presence frames may interleave)."""
        for _ in range(limit):
            message = await ws.receive_json_from()
            if message.get("type") == wanted:
                return message
        raise AssertionError(f"no {wanted} frame within {limit} messages")


class WhiteboardConnectionTests(WhiteboardConsumerTestCase):
    def test_history_is_the_first_frame_and_carries_board_metadata(self):
        async def scenario():
            ws = self.ws(self.owner)
            connected, _ = await ws.connect()
            assert connected
            first = await ws.receive_json_from()
            await ws.disconnect()
            return first

        first = async_to_sync(scenario)()
        self.assertEqual(first["type"], "whiteboard_history")
        self.assertTrue(first["full"])
        self.assertEqual(first["seq"], 0)
        self.assertEqual(first["board"]["page_count"], 1)
        self.assertTrue(first["you"]["can_draw"])
        self.assertEqual(first["you"]["identity"], f"u:{self.owner.id}")
        self.assertIn("max_op_bytes", first["limits"])

    def test_viewer_without_permission_still_sees_the_board(self):
        async def scenario():
            ws = self.ws(self.student)
            connected, _ = await ws.connect()
            assert connected
            first = await ws.receive_json_from()
            await ws.send_json_to({"action": "op", "op": stroke("nope")})
            err = await self.recv(ws, "error")
            await ws.disconnect()
            return first, err

        first, err = async_to_sync(scenario)()
        self.assertFalse(first["you"]["can_draw"])
        self.assertEqual(err["type"], "error")
        self.assertEqual(err["code"], "forbidden")
        self.assertEqual(err["ops"], ["nope"])
        self.assertEqual(WhiteboardEvent.objects.count(), 0)

    def test_non_member_and_anonymous_are_closed(self):
        async def scenario(user, expected):
            ws = self.ws(user)
            connected, code = await ws.connect()
            if connected:
                await ws.disconnect()
            return connected, code

        connected, code = async_to_sync(scenario)(self.outsider, 4403)
        self.assertFalse(connected)
        self.assertEqual(code, 4403)

        from django.contrib.auth.models import AnonymousUser

        connected, code = async_to_sync(scenario)(AnonymousUser(), 4401)
        self.assertFalse(connected)
        self.assertEqual(code, 4401)

    def test_waiting_room_guest_cannot_open_the_board(self):
        guest_member = join_classroom(self.classroom, self.student)
        guest_member.in_waiting_room = True
        guest_member.save(update_fields=["in_waiting_room"])

        async def scenario():
            ws = self.ws(self.student)
            connected, code = await ws.connect()
            if connected:
                await ws.disconnect()
            return connected, code

        connected, code = async_to_sync(scenario)()
        self.assertFalse(connected)
        self.assertEqual(code, 4403)

    def test_ping_is_answered_with_pong(self):
        async def scenario():
            ws = self.ws(self.owner)
            await ws.connect()
            await ws.receive_json_from()
            await ws.send_json_to({"action": "ping", "t": 42})
            pong = await ws.receive_json_from()
            await ws.disconnect()
            return pong

        self.assertEqual(async_to_sync(scenario)(), {"type": "pong", "t": 42})


class WhiteboardLiveTests(WhiteboardConsumerTestCase):
    def test_draw_is_relayed_to_peers_and_persisted(self):
        async def scenario():
            owner_ws = self.ws(self.owner)
            await owner_ws.connect()
            await owner_ws.receive_json_from()
            student_ws = self.ws(self.student)
            await student_ws.connect()
            await student_ws.receive_json_from()
            await self.recv(owner_ws, "presence")  # the student joined

            await student_ws.send_json_to({"action": "op", "op": {"type": "page_go", "page": 1, "id": "g"}})
            # a viewer may not draw, whatever the op is
            err = await self.recv(student_ws, "error")
            assert err["type"] == "error"
            await owner_ws.send_json_to({"action": "op", "op": stroke("s1")})
            seen = await self.recv(student_ws, "whiteboard_operation")
            await student_ws.disconnect()
            await owner_ws.disconnect()
            return seen

        seen = async_to_sync(scenario)()
        self.assertEqual(seen["type"], "whiteboard_operation")
        self.assertEqual(seen["op"]["id"], "s1")
        self.assertEqual(seen["seq"], 1)
        self.assertFalse(seen["ephemeral"])
        self.assertEqual(seen["actor_identity"], f"u:{self.owner.id}")
        self.assertIsNotNone(seen["event_id"])
        self.assertEqual(seen["board"]["page_count"], 1)
        row = WhiteboardEvent.objects.get()
        self.assertEqual(row.seq, 1)
        self.assertEqual(row.kind, "draw:pen")
        self.assertEqual(row.scope, "board")

    def test_batch_operations_are_stored_in_order(self):
        async def scenario():
            ws = self.ws(self.owner)
            await ws.connect()
            await ws.receive_json_from()
            await ws.send_json_to(
                {
                    "action": "ops",
                    "ops": [stroke("b1"), stroke("b2"), {"type": "page_add", "page": 2, "id": "b3"}],
                }
            )
            await asyncio.sleep(0.3)
            await ws.disconnect()

        async_to_sync(scenario)()
        rows = list(WhiteboardEvent.objects.order_by("seq"))
        self.assertEqual([row.operation["id"] for row in rows], ["b1", "b2", "b3"])
        self.assertEqual([row.seq for row in rows], [1, 2, 3])
        self.assertEqual(Whiteboard.objects.get().page_count, 2)

    def test_too_many_operations_in_one_frame_is_rejected(self):
        async def scenario():
            ws = self.ws(self.owner)
            await ws.connect()
            await ws.receive_json_from()
            await ws.send_json_to(
                {"action": "ops", "ops": [stroke(f"x{i}") for i in range(70)]}
            )
            err = await self.recv(ws, "error")
            await ws.disconnect()
            return err

        err = async_to_sync(scenario)()
        self.assertEqual(err["code"], "batch-too-large")
        self.assertEqual(WhiteboardEvent.objects.count(), 0)

    def test_invalid_operation_is_rejected_with_its_id(self):
        async def scenario():
            ws = self.ws(self.owner)
            await ws.connect()
            await ws.receive_json_from()
            await ws.send_json_to({"action": "op", "op": {"type": "draw", "tool": "pen", "id": "bad"}})
            err = await self.recv(ws, "error")
            await ws.disconnect()
            return err

        err = async_to_sync(scenario)()
        self.assertEqual(err["type"], "error")
        self.assertEqual(err["code"], "invalid-op")
        self.assertEqual(err["ops"], ["bad"])

    def test_ephemeral_operations_are_relayed_but_never_stored(self):
        async def scenario():
            owner_ws = self.ws(self.owner)
            await owner_ws.connect()
            await owner_ws.receive_json_from()
            student_ws = self.ws(self.student)
            await student_ws.connect()
            await student_ws.receive_json_from()
            await self.recv(owner_ws, "presence")

            for op in (
                {"type": "laser", "id": "l1", "norm": 1, "x": 0.4, "y": 0.4},
                {"type": "cursor", "id": "c1", "norm": 1, "x": 0.2, "y": 0.2},
                {"type": "draw", "tool": "pen", "id": "live1", "norm": 1, "live": True, "points": [[0.1, 0.1], [0.2, 0.2]]},
            ):
                await owner_ws.send_json_to({"action": "op", "op": op})
                seen = await self.recv(student_ws, "whiteboard_operation")
                assert seen["ephemeral"], seen
                assert seen["op"]["id"] == op["id"], seen

            await student_ws.disconnect()
            await owner_ws.disconnect()

        async_to_sync(scenario)()
        self.assertEqual(WhiteboardEvent.objects.count(), 0)

    def test_permission_can_be_granted_and_revoked_live(self):
        async def scenario():
            ws = self.ws(self.student)
            await ws.connect()
            await ws.receive_json_from()
            await ws.send_json_to(
                {"action": "op", "op": {"type": "draw", "tool": "pen", "id": "s1", "norm": 1, "points": [[0.1, 0.1], [0.2, 0.2]]}}
            )
            refused = await self.recv(ws, "error")
            await ws.disconnect()
            return refused

        refused = async_to_sync(scenario)()
        self.assertEqual(refused["code"], "forbidden")

        self.classroom.allow_student_whiteboard = True
        self.classroom.save(update_fields=["allow_student_whiteboard"])
        set_member_permission(
            self.classroom, self.owner, self.student_member.id, "can_use_whiteboard", True
        )

        async def scenario_granted():
            ws = self.ws(self.student)
            await ws.connect()
            first = await ws.receive_json_from()
            assert first["you"]["can_draw"] is True, first
            await ws.send_json_to(
                {"action": "op", "op": {"type": "draw", "tool": "pen", "id": "ok1", "norm": 1, "points": [[0.1, 0.1], [0.2, 0.2]]}}
            )
            await asyncio.sleep(0.2)
            await ws.disconnect()

        async_to_sync(scenario_granted)()
        self.assertTrue(WhiteboardEvent.objects.filter(operation__id="ok1").exists())

        # revoke while the socket is open → the very next op is refused
        set_member_permission(
            self.classroom, self.owner, self.student_member.id, "can_use_whiteboard", False
        )

        async def scenario_revoked():
            ws = self.ws(self.student)
            await ws.connect()
            await ws.receive_json_from()
            await ws.send_json_to(
                {"action": "op", "op": {"type": "draw", "tool": "pen", "id": "no2", "norm": 1, "points": [[0.1, 0.1], [0.2, 0.2]]}}
            )
            err = await self.recv(ws, "error")
            await ws.disconnect()
            return err

        err = async_to_sync(scenario_revoked)()
        self.assertEqual(err["code"], "forbidden")
        self.assertEqual(WhiteboardEvent.objects.filter(operation__id="no2").count(), 0)

    def test_page_operations_broadcast_the_new_board_state(self):
        async def scenario():
            owner_ws = self.ws(self.owner)
            await owner_ws.connect()
            await owner_ws.receive_json_from()
            student_ws = self.ws(self.student)
            await student_ws.connect()
            await student_ws.receive_json_from()
            await self.recv(owner_ws, "presence")

            await owner_ws.send_json_to(
                {"action": "op", "op": {"type": "page_setup", "page": 1, "grid": "dots", "color": "#fff7d6", "id": "set"}}
            )
            seen = await self.recv(student_ws, "whiteboard_operation")
            await student_ws.disconnect()
            await owner_ws.disconnect()
            return seen

        seen = async_to_sync(scenario)()
        self.assertEqual(seen["board"]["pages"]["1"]["grid"], "dots")
        self.assertEqual(seen["board"]["page_count"], 1)


class WhiteboardSyncTests(WhiteboardConsumerTestCase):
    def test_resync_sends_only_the_missing_tail(self):
        async def scenario():
            ws = self.ws(self.owner)
            await ws.connect()
            first = await ws.receive_json_from()
            await ws.send_json_to({"action": "op", "op": stroke("a")})
            await ws.send_json_to({"action": "op", "op": stroke("b")})
            await asyncio.sleep(0.3)
            await ws.send_json_to({"action": "resync", "since": 1})
            tail = await ws.receive_json_from()
            await ws.disconnect()
            return first, tail

        first, tail = async_to_sync(scenario)()
        self.assertTrue(first["full"])
        self.assertFalse(tail["full"])
        self.assertEqual([event["op"]["id"] for event in tail["events"]], ["b"])
        self.assertEqual(tail["seq"], 2)

    def test_reconnect_with_since_gets_the_tail(self):
        async def scenario():
            ws = self.ws(self.owner)
            await ws.connect()
            await ws.receive_json_from()
            await ws.send_json_to({"action": "op", "op": stroke("a")})
            await asyncio.sleep(0.2)
            await ws.disconnect()

            again = self.ws(self.owner, query="?since=1")
            await again.connect()
            payload = await again.receive_json_from()
            await again.disconnect()
            return payload

        payload = async_to_sync(scenario)()
        self.assertFalse(payload["full"])
        self.assertEqual(payload["events"], [])
        self.assertEqual(payload["seq"], 1)

    def test_published_snapshot_is_acknowledged_and_replaces_the_log(self):
        async def scenario():
            ws = self.ws(self.owner)
            await ws.connect()
            await ws.receive_json_from()
            await ws.send_json_to({"action": "op", "op": stroke("s1")})
            await ws.send_json_to({"action": "op", "op": stroke("s2")})
            await asyncio.sleep(0.3)
            await ws.send_json_to({"action": "snapshot", "seq": 2, "ops": [stroke("s1")]})
            ack = await self.recv(ws, "snapshot_stored")
            await ws.disconnect()
            return ack

        ack = async_to_sync(scenario)()
        self.assertEqual(ack, {"type": "snapshot_stored", "seq": 2})
        board = Whiteboard.objects.get()
        self.assertEqual(board.snapshot_seq, 2)
        self.assertEqual(len(board.snapshot_ops), 1)

    def test_presence_join_and_leave_are_broadcast(self):
        async def scenario():
            owner_ws = self.ws(self.owner)
            await owner_ws.connect()
            await owner_ws.receive_json_from()

            student_ws = self.ws(self.student)
            await student_ws.connect()
            await student_ws.receive_json_from()
            joined = await self.recv(owner_ws, "presence")
            await student_ws.disconnect()
            left = await self.recv(owner_ws, "presence")
            await owner_ws.disconnect()
            return joined, left

        joined, left = async_to_sync(scenario)()
        self.assertEqual(joined["type"], "presence")
        self.assertEqual(joined["action"], "join")
        self.assertEqual(joined["participant"]["identity"], f"u:{self.student.id}")
        self.assertFalse(joined["participant"]["can_draw"])
        self.assertEqual(left["action"], "leave")

    def test_unknown_actions_do_not_break_the_socket(self):
        async def scenario():
            ws = self.ws(self.owner)
            await ws.connect()
            await ws.receive_json_from()
            await ws.send_json_to({"action": "from-the-future", "payload": {}})
            await ws.send_json_to({"action": "ping", "t": 1})
            pong = await ws.receive_json_from()
            await ws.disconnect()
            return pong

        self.assertEqual(async_to_sync(scenario)()["type"], "pong")

    def test_non_object_json_frame_gets_an_error_not_a_crash(self):
        async def scenario():
            ws = self.ws(self.owner)
            await ws.connect()
            await ws.receive_json_from()
            await ws.send_to(text_data=json.dumps(["not", "an", "object"]))
            err = await ws.receive_json_from()
            await ws.send_json_to({"action": "ping", "t": 7})
            pong = await ws.receive_json_from()
            await ws.disconnect()
            return err, pong

        err, pong = async_to_sync(scenario)()
        self.assertEqual(err["type"], "error")
        self.assertEqual(pong, {"type": "pong", "t": 7})
