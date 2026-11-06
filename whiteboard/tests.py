"""WebSocket tests for the collaborative whiteboard + chat moderation.

Consumers run through their real ASGI routing with the authenticated
user injected into the scope the way ``AuthMiddlewareStack`` would.
"""
import asyncio
import json

from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.test import TransactionTestCase

from chat.models import ChatMessage
from chat.routing import websocket_urlpatterns as chat_routes
from classrooms.permissions import Role
from classrooms.services import (
    create_classroom,
    join_classroom,
    set_member_permission,
    set_member_role,
)
from whiteboard.consumers import HISTORY_CHUNK_BYTES, WhiteboardConsumer
from whiteboard.models import Whiteboard, WhiteboardEvent, WhiteboardSnapshot
from whiteboard.snapshot import apply_op, compact_board, empty_state, normalise_state
from whiteboard.routing import websocket_urlpatterns as wb_routes

User = get_user_model()


def app_with_user(user, routes):
    inner = URLRouter(routes)

    async def app(scope, receive, send):
        scope = dict(scope)
        scope["user"] = user
        await inner(scope, receive, send)

    return app


class WhiteboardConsumerTests(TransactionTestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="wb_owner", password="x")
        self.presenter = User.objects.create_user(username="wb_presenter", password="x")
        self.student = User.objects.create_user(username="wb_student", password="x")
        self.classroom = create_classroom(self.owner, title="WB")
        pm = join_classroom(self.classroom, self.presenter)
        join_classroom(self.classroom, self.student)
        set_member_role(self.classroom, self.owner, pm.id, Role.PRESENTER)

    def _ws(self, user):
        return WebsocketCommunicator(
            app_with_user(user, wb_routes), f"/ws/classroom/{self.classroom.room_code}/whiteboard/"
        )

    def test_draw_op_broadcast_and_persist(self):
        async def scenario():
            owner_ws = self._ws(self.owner)
            connected, _ = await owner_ws.connect()
            assert connected
            history = await owner_ws.receive_json_from()
            assert history["type"] == "whiteboard_history"

            student_ws = self._ws(self.student)  # students lack whiteboard by default
            connected, _ = await student_ws.connect()
            assert connected
            await student_ws.receive_json_from()

            presenter_ws = self._ws(self.presenter)
            connected, _ = await presenter_ws.connect()
            assert connected
            await presenter_ws.receive_json_from()

            # Note: senders apply ops optimistically and are not echoed
            # back their own op (the consumer's seq guard drops it).
            op = {"type": "draw", "tool": "pen", "points": [[1, 2], [3, 4]], "color": "#000", "width": 2, "id": "op-1"}
            await presenter_ws.send_json_to({"action": "op", "op": op})

            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "whiteboard_operation", msg
            assert msg["op"]["tool"] == "pen"
            assert msg["actor_identity"] == f"u:{self.presenter.id}"

            # The student (viewer, no draw permission) still sees the op,
            # but their own draw attempt is refused server-side.
            seen = await student_ws.receive_json_from()
            assert seen["type"] == "whiteboard_operation"
            await student_ws.send_json_to({"action": "op", "op": op})
            err = await student_ws.receive_json_from()
            assert err["type"] == "error", err

            await owner_ws.disconnect()
            await student_ws.disconnect()
            await presenter_ws.disconnect()

        async_to_sync(scenario)()

        board = Whiteboard.objects.get(classroom=self.classroom)
        self.assertEqual(board.events.count(), 1)
        self.assertEqual(board.events.first().operation["tool"], "pen")

    def test_student_granted_permission_can_draw(self):
        member = self.classroom.members.get(user=self.student)
        # Both layers must allow it: the member flag AND the room setting.
        self.classroom.allow_student_whiteboard = True
        self.classroom.save()
        set_member_permission(self.classroom, self.owner, member.id, "can_use_whiteboard", True)

        async def scenario():
            ws = self._ws(self.student)
            connected, _ = await ws.connect()
            assert connected
            await ws.receive_json_from()
            await ws.send_json_to({
                "action": "op",
                "op": {"type": "draw", "tool": "line", "points": [[0, 0], [9, 9]], "color": "#f00", "width": 1, "id": "op-2"},
            })
            await asyncio.sleep(0.2)  # sender is not echoed its own op
            await ws.disconnect()

        async_to_sync(scenario)()
        board = Whiteboard.objects.get(classroom=self.classroom)
        self.assertEqual(board.events.count(), 1)
        self.assertEqual(board.events.first().actor, self.student)

    def test_invalid_op_rejected(self):
        async def scenario():
            ws = self._ws(self.owner)
            await ws.connect()
            await ws.receive_json_from()
            await ws.send_json_to({
                "action": "op",
                "op": {"type": "draw", "tool": "laser", "points": [], "id": "too-thin"},
            })
            msg = await ws.receive_json_from()
            assert msg["type"] == "error"
            # The refusal names the op so the client can drop its optimistic
            # copy instead of keeping ink nobody else received.
            assert msg["op_id"] == "too-thin", msg
            await ws.disconnect()

        async_to_sync(scenario)()
        self.assertEqual(WhiteboardEvent.objects.count(), 0)

    def test_non_object_json_frame_is_rejected_without_crashing_socket(self):
        async def scenario():
            ws = self._ws(self.owner)
            connected, _ = await ws.connect()
            assert connected
            await ws.receive_json_from()  # history
            await ws.send_to(text_data="[]")
            error = await ws.receive_json_from(timeout=3)
            assert error["type"] == "error", error
            await ws.send_json_to({"action": "op", "op": {
                "type": "draw", "tool": "pen", "points": [[1, 2], [3, 4]],
                "color": "#000", "width": 2, "id": "after-bad-frame",
            }})
            await asyncio.sleep(0.2)
            await ws.disconnect()

        async_to_sync(scenario)()
        self.assertTrue(WhiteboardEvent.objects.filter(operation__id="after-bad-frame").exists())

    def test_clear_compacts_history(self):
        async def scenario():
            ws = self._ws(self.owner)
            await ws.connect()
            await ws.receive_json_from()
            for i in range(3):
                await ws.send_json_to({
                    "action": "op",
                    "op": {"type": "draw", "tool": "pen", "points": [[i, i], [i + 1, i + 1]], "color": "#000", "width": 1, "id": f"c-{i}"},
                })
            await ws.send_json_to({"action": "op", "op": {"type": "clear", "id": "clr"}})
            await asyncio.sleep(0.3)
            await ws.disconnect()

        async_to_sync(scenario)()

        board = Whiteboard.objects.get(classroom=self.classroom)
        self.assertEqual(board.events.count(), 1)  # only the clear event
        self.assertEqual(board.events.first().operation["type"], "clear")

    def test_ops_reuse_one_board_row_and_do_not_rewrite_its_timestamp(self):
        """Write amplification guard.

        Every stroke used to cost ``get_or_create(board)`` plus an extra
        ``UPDATE whiteboard SET updated_at``.  The board is resolved once per
        connection and the timestamp is refreshed on an interval instead.
        """
        read_stamp = database_sync_to_async(
            lambda: Whiteboard.objects.get(classroom=self.classroom).updated_at
        )

        async def scenario():
            ws = self._ws(self.owner)
            await ws.connect()
            await ws.receive_json_from()
            op = lambda i: {  # noqa: E731 - tiny inline builder
                "action": "op",
                "op": {"type": "draw", "tool": "pen", "points": [[i, i], [i + 1, i + 1]], "color": "#000", "width": 1, "id": f"w-{i}"},
            }
            await ws.send_json_to(op(1))
            await asyncio.sleep(0.2)
            first = await read_stamp()
            # Three more ops on the same connection must not re-stamp the board.
            for i in range(2, 5):
                await ws.send_json_to(op(i))
            await asyncio.sleep(0.3)
            second = await read_stamp()
            await ws.disconnect()
            return first, second

        first, second = async_to_sync(scenario)()

        self.assertEqual(Whiteboard.objects.count(), 1)
        board = Whiteboard.objects.get(classroom=self.classroom)
        self.assertEqual(board.events.count(), 4)
        self.assertIsNotNone(board.updated_at)
        self.assertEqual(first, second)

    def test_history_is_streamed_in_frame_sized_chunks(self):
        """A full board must not be sent as one >1 MiB WebSocket frame.

        autobahn/daphne refuse frames above 1 MiB; the resulting
        PayloadExceededError used to abort ``connect`` and leave the board
        empty (with the client reconnecting forever).
        """
        board, _ = Whiteboard.objects.get_or_create(classroom=self.classroom)
        points = [[0.1 + (i % 40) / 100, 0.2 + (i // 40) / 100] for i in range(200)]
        WhiteboardEvent.objects.bulk_create([
            WhiteboardEvent(
                whiteboard=board, actor=self.presenter, actor_identity="u:1", page=1,
                operation={"type": "draw", "tool": "pen", "norm": 1, "id": f"k-{i}", "page": 1,
                           "color": "#2563eb", "width": 3, "points": points},
            )
            for i in range(400)
        ])

        async def scenario():
            ws = self._ws(self.owner)
            connected, _ = await ws.connect()
            assert connected
            chunks = []
            while True:
                msg = await ws.receive_json_from()
                assert msg["type"] == "whiteboard_history", msg
                chunks.append(msg)
                if not msg.get("more"):
                    break
            await ws.disconnect()
            return chunks

        chunks = async_to_sync(scenario)()
        total = sum(len(c["events"]) for c in chunks)
        self.assertEqual(total, 400)
        self.assertGreater(len(chunks), 1, "history should have been split")
        for chunk in chunks:
            self.assertLessEqual(
                len(json.dumps(chunk, separators=(",", ":"))),
                HISTORY_CHUNK_BYTES + 128 * 1024,
            )
        # seq and ordering survive the split
        self.assertEqual(chunks[-1]["seq"], WhiteboardEvent.objects.order_by("-id").first().id)
        ids = [e["id"] for c in chunks for e in c["events"]]
        self.assertEqual(ids, sorted(ids))

    def test_non_member_rejected(self):
        stranger = User.objects.create_user(username="wb_stranger", password="x")

        async def scenario():
            ws = self._ws(stranger)
            connected, code = await ws.connect()
            assert not connected and code == 4403

        async_to_sync(scenario)()


class ChatModerationTests(TransactionTestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="cm_owner", password="x")
        self.student = User.objects.create_user(username="cm_student", password="x")
        self.classroom = create_classroom(self.owner, title="CM")
        join_classroom(self.classroom, self.student)

    def _ws(self, user):
        return WebsocketCommunicator(
            app_with_user(user, chat_routes), f"/ws/classroom/{self.classroom.room_code}/chat/"
        )

    def test_moderator_can_delete_message(self):
        async def scenario():
            student_ws = self._ws(self.student)
            await student_ws.connect()
            await student_ws.receive_json_from()
            owner_ws = self._ws(self.owner)
            await owner_ws.connect()
            await owner_ws.receive_json_from()

            await student_ws.send_json_to({"action": "send_message", "message": "حذف شو"})
            await owner_ws.receive_json_from()   # broadcast
            echo = await student_ws.receive_json_from()
            message_id = echo["message"]["id"]

            await owner_ws.send_json_to({"action": "delete_message", "message_id": message_id})
            del_msg = await student_ws.receive_json_from()
            assert del_msg["type"] == "chat_deleted" and del_msg["message_id"] == message_id
            assert (await owner_ws.receive_json_from())["type"] == "chat_deleted"

            await student_ws.disconnect()
            await owner_ws.disconnect()

        async_to_sync(scenario)()
        self.assertTrue(ChatMessage.objects.first().is_deleted)

    def test_student_cannot_delete(self):
        async def scenario():
            student_ws = self._ws(self.student)
            await student_ws.connect()
            await student_ws.receive_json_from()
            await student_ws.send_json_to({"action": "send_message", "message": "سلام"})
            await student_ws.receive_json_from()
            await student_ws.send_json_to({"action": "delete_message", "message_id": 1})
            err = await student_ws.receive_json_from()
            assert err["type"] == "error"
            await student_ws.disconnect()

        async_to_sync(scenario)()
        self.assertFalse(ChatMessage.objects.first().is_deleted)

    def test_chat_disabled_blocks_students_live(self):
        self.classroom.chat_disabled = True
        self.classroom.save()

        async def scenario():
            student_ws = self._ws(self.student)
            await student_ws.connect()
            await student_ws.receive_json_from()
            await student_ws.send_json_to({"action": "send_message", "message": "هست کسی؟"})
            err = await student_ws.receive_json_from()
            assert err["type"] == "error", err
            await student_ws.disconnect()

        async_to_sync(scenario)()
        self.assertEqual(ChatMessage.objects.count(), 0)


class WhiteboardPageTests(TransactionTestCase):
    """Multi-page whiteboard: page tagging, isolation and validation."""

    def setUp(self):
        self.owner = User.objects.create_user(username="pg_owner", password="x")
        self.classroom = create_classroom(self.owner, title="Pages")

    def _ws(self, user):
        return WebsocketCommunicator(
            app_with_user(user, wb_routes), f"/ws/classroom/{self.classroom.room_code}/whiteboard/"
        )

    def test_ops_carry_pages_and_clear_is_per_page(self):
        async def scenario():
            ws = self._ws(self.owner)
            connected, _ = await ws.connect()
            assert connected
            await ws.receive_json_from()  # history

            draw1 = {"type": "draw", "tool": "pen", "points": [[1, 2], [3, 4]], "color": "#000", "width": 2, "id": "p1"}
            await ws.send_json_to({"action": "op", "op": draw1})
            await ws.send_json_to({"action": "op", "op": {"type": "page_add", "page": 2, "id": "padd"}})
            draw2 = {"type": "draw", "tool": "pen", "points": [[5, 6], [7, 8]], "color": "#f00", "width": 2, "id": "p2", "page": 2}
            await ws.send_json_to({"action": "op", "op": draw2})
            await ws.send_json_to({"action": "op", "op": {"type": "clear", "id": "clr", "page": 2}})
            await asyncio.sleep(0.4)
            await ws.disconnect()

        async_to_sync(scenario)()

        events = list(WhiteboardEvent.objects.order_by("id"))
        pages = [(e.operation.get("type"), e.page) for e in events]
        # draw p1 survives; page 2 was compacted by the clear (its draw is
        # gone) but the page_add marker stays so the page still exists
        assert pages == [("draw", 1), ("page_add", 2), ("clear", 2)], pages
        # page 1 drawing survived the page-2 clear (only page 2 compacted)
        surviving = WhiteboardEvent.objects.filter(operation__type="draw")
        assert [(e.page) for e in surviving] == [1], [(e.page) for e in surviving]
        # op payloads are tagged too (clients filter by page)
        assert events[0].operation["page"] == 1
        assert events[1].operation["page"] == 2

    def test_page_add_validation(self):
        async def scenario():
            ws = self._ws(self.owner)
            connected, _ = await ws.connect()
            assert connected
            await ws.receive_json_from()

            # page must be an int ≥ 2
            await ws.send_json_to({"action": "op", "op": {"type": "page_add", "page": 1}})
            msg = await ws.receive_json_from()
            assert msg["type"] == "error", msg

            await ws.send_json_to({"action": "op", "op": {"type": "page_add"}})
            msg = await ws.receive_json_from()
            assert msg["type"] == "error", msg

            await ws.send_json_to({"action": "op", "op": {"type": "page_add", "page": 3, "id": "ok"}})
            await asyncio.sleep(0.3)
            await ws.disconnect()

        async_to_sync(scenario)()
        assert WhiteboardEvent.objects.filter(operation__type="page_add", page=3).exists()

    def test_history_returns_pages_for_replay(self):
        async def scenario():
            ws = self._ws(self.owner)
            connected, _ = await ws.connect()
            assert connected
            await ws.receive_json_from()
            await ws.send_json_to({"action": "op", "op": {
                "type": "draw", "tool": "pen", "points": [[1, 2], [3, 4]],
                "color": "#000", "width": 2, "id": "h1", "page": 4,
            }})
            await asyncio.sleep(0.3)
            await ws.disconnect()

            ws2 = self._ws(self.owner)
            connected, _ = await ws2.connect()
            assert connected
            history = await ws2.receive_json_from()
            assert history["type"] == "whiteboard_history"
            assert history["events"][0]["op"]["page"] == 4, history
            await ws2.disconnect()

        async_to_sync(scenario)()


class WhiteboardStyleOpsTests(TransactionTestCase):
    """page_setup / page_go / laser: validation, persistence, relay."""

    def setUp(self):
        self.owner = User.objects.create_user(username="st_owner", password="x")
        self.viewer = User.objects.create_user(username="st_viewer", password="x")
        self.classroom = create_classroom(self.owner, title="Style")
        join_classroom(self.classroom, self.viewer)

    def _ws(self, user):
        return WebsocketCommunicator(
            app_with_user(user, wb_routes), f"/ws/classroom/{self.classroom.room_code}/whiteboard/"
        )

    def test_page_setup_persisted_and_broadcast(self):
        async def scenario():
            ow = self._ws(self.owner)
            connected, _ = await ow.connect()
            assert connected
            await ow.receive_json_from()
            vw = self._ws(self.viewer)
            connected, _ = await vw.connect()
            assert connected
            await vw.receive_json_from()

            await ow.send_json_to({"action": "op", "op": {
                "type": "page_setup", "page": 1, "color": "#123abc", "grid": "grid", "id": "ps1",
            }})
            msg = await vw.receive_json_from()
            assert msg["type"] == "whiteboard_operation", msg
            assert msg["op"]["color"] == "#123abc" and msg["op"]["grid"] == "grid"

            # invalid colour rejected
            await ow.send_json_to({"action": "op", "op": {"type": "page_setup", "page": 1, "color": "red"}})
            msg = await ow.receive_json_from()
            assert msg["type"] == "error", msg
            # invalid grid rejected
            await ow.send_json_to({"action": "op", "op": {"type": "page_setup", "page": 1, "grid": "waves"}})
            msg = await ow.receive_json_from()
            assert msg["type"] == "error", msg
            await ow.disconnect()
            await vw.disconnect()

        async_to_sync(scenario)()
        ev = WhiteboardEvent.objects.get(operation__type="page_setup")
        assert ev.page == 1 and ev.operation["color"] == "#123abc"
        assert WhiteboardEvent.objects.filter(operation__type="page_setup").count() == 1

    def test_page_go_relayed_and_validated(self):
        async def scenario():
            ow = self._ws(self.owner)
            connected, _ = await ow.connect()
            assert connected
            await ow.receive_json_from()
            vw = self._ws(self.viewer)
            connected, _ = await vw.connect()
            assert connected
            await vw.receive_json_from()

            await ow.send_json_to({"action": "op", "op": {"type": "page_go", "page": 3, "id": "go1"}})
            msg = await vw.receive_json_from()
            assert msg["type"] == "whiteboard_operation" and msg["op"]["type"] == "page_go", msg
            assert msg["op"]["page"] == 3

            await ow.send_json_to({"action": "op", "op": {"type": "page_go"}})
            msg = await ow.receive_json_from()
            assert msg["type"] == "error", msg
            await ow.disconnect()
            await vw.disconnect()

        async_to_sync(scenario)()
        assert WhiteboardEvent.objects.filter(operation__type="page_go", page=3).exists()

    def test_laser_is_ephemeral_and_relayed(self):
        async def scenario():
            ow = self._ws(self.owner)
            connected, _ = await ow.connect()
            assert connected
            await ow.receive_json_from()
            vw = self._ws(self.viewer)
            connected, _ = await vw.connect()
            assert connected
            await vw.receive_json_from()

            await ow.send_json_to({"action": "op", "op": {"type": "laser", "page": 1, "x": 42, "y": 7}})
            msg = await vw.receive_json_from()
            assert msg["type"] == "whiteboard_operation", msg
            assert msg["op"]["type"] == "laser" and msg["op"]["x"] == 42
            assert msg.get("ephemeral") is True

            # invalid laser rejected (skip our own relayed-laser echo first)
            await ow.send_json_to({"action": "op", "op": {"type": "laser", "page": 1, "x": "a", "y": 2}})
            for _ in range(5):
                msg = await ow.receive_json_from()
                if msg.get("type") == "error":
                    break
            assert msg["type"] == "error", msg
            await ow.disconnect()
            await vw.disconnect()

        async_to_sync(scenario)()
        assert not WhiteboardEvent.objects.filter(operation__type="laser").exists()

    def test_clear_keeps_page_setup_marker(self):
        async def scenario():
            ow = self._ws(self.owner)
            connected, _ = await ow.connect()
            assert connected
            await ow.receive_json_from()
            await ow.send_json_to({"action": "op", "op": {
                "type": "draw", "tool": "pen", "points": [[1, 2], [3, 4]],
                "color": "#000", "width": 2, "id": "d1", "page": 1,
            }})
            await ow.send_json_to({"action": "op", "op": {
                "type": "page_setup", "page": 1, "color": "#fefefe", "id": "ps",
            }})
            await ow.send_json_to({"action": "op", "op": {"type": "clear", "id": "cl", "page": 1}})
            await asyncio.sleep(0.4)
            await ow.disconnect()

        async_to_sync(scenario)()
        remaining = [(e.operation.get("type"), e.page) for e in WhiteboardEvent.objects.order_by("id")]
        # the draw is compacted; the setup marker + the clear itself remain
        assert ("draw", 1) not in remaining, remaining
        assert ("page_setup", 1) in remaining, remaining


class PresentationAnnotationTests(TransactionTestCase):
    """File annotations ride the whiteboard protocol tagged with file_id."""

    def setUp(self):
        self.owner = User.objects.create_user(username="pa_owner", password="x")
        self.viewer = User.objects.create_user(username="pa_viewer", password="x")
        self.classroom = create_classroom(self.owner, title="Annot")
        join_classroom(self.classroom, self.viewer)

    def _ws(self, user):
        return WebsocketCommunicator(
            app_with_user(user, wb_routes), f"/ws/classroom/{self.classroom.room_code}/whiteboard/"
        )

    def test_file_ops_relayed_and_clear_is_scoped(self):
        async def scenario():
            ow = self._ws(self.owner)
            connected, _ = await ow.connect()
            assert connected
            await ow.receive_json_from()
            vw = self._ws(self.viewer)
            connected, _ = await vw.connect()
            assert connected
            await vw.receive_json_from()

            # a board stroke and a file annotation on the same page number
            await ow.send_json_to({"action": "op", "op": {
                "type": "draw", "tool": "pen", "points": [[1, 2], [3, 4]],
                "color": "#000", "width": 2, "id": "board1", "page": 1,
            }})
            msg = await vw.receive_json_from()
            assert msg["op"]["id"] == "board1" and "file_id" not in msg["op"]

            await ow.send_json_to({"action": "op", "op": {
                "type": "draw", "tool": "highlighter", "points": [[5, 6], [7, 8]],
                "color": "#ff0", "width": 8, "id": "file1", "page": 1, "file_id": 42,
            }})
            msg = await vw.receive_json_from()
            assert msg["op"]["id"] == "file1" and msg["op"]["file_id"] == 42

            # clearing the FILE annotations must not touch the board stroke
            await ow.send_json_to({"action": "op", "op": {
                "type": "clear", "id": "fclr", "page": 1, "file_id": 42,
            }})
            await asyncio.sleep(0.3)

            # clearing the BOARD must not re-remove file rows (already gone)
            # but we assert board clear leaves nothing of the board either
            await ow.send_json_to({"action": "op", "op": {
                "type": "draw", "tool": "pen", "points": [[9, 9], [8, 8]],
                "color": "#0f0", "width": 2, "id": "board2", "page": 1,
            }})
            await ow.send_json_to({"action": "op", "op": {
                "type": "draw", "tool": "pen", "points": [[2, 2], [4, 4]],
                "color": "#00f", "width": 2, "id": "file2", "page": 1, "file_id": 42,
            }})
            await ow.send_json_to({"action": "op", "op": {"type": "clear", "id": "bclr", "page": 1}})
            await asyncio.sleep(0.4)
            await ow.disconnect()
            await vw.disconnect()

        async_to_sync(scenario)()

        draws = [(e.operation.get("id"), e.operation.get("file_id"))
                 for e in WhiteboardEvent.objects.filter(operation__type="draw")]
        # board1 compacted by board clear; file2 survives (different scope)
        assert ("board1", None) not in draws, draws
        assert ("file2", 42) in draws, draws

    def test_invalid_file_id_rejected(self):
        async def scenario():
            ow = self._ws(self.owner)
            connected, _ = await ow.connect()
            assert connected
            await ow.receive_json_from()
            await ow.send_json_to({"action": "op", "op": {
                "type": "draw", "tool": "pen", "points": [[1, 2], [3, 4]],
                "color": "#000", "width": 2, "id": "bad", "page": 1, "file_id": "x",
            }})
            msg = await ow.receive_json_from()
            assert msg["type"] == "error", msg
            await ow.disconnect()

        async_to_sync(scenario)()
        assert not WhiteboardEvent.objects.filter(operation__id="bad").exists()


class SharedSlideAnnotationTests(TransactionTestCase):
    """Writing on the *presented* file is open to the room by default.

    Board permission (``can_use_whiteboard``) still guards the free
    whiteboard; a shared slide is meant to be written on by everybody, and
    the presenter keeps a live switch to lock it.
    """

    def setUp(self):
        from django.core.files.base import ContentFile

        from classrooms.models import SharedFile

        self.owner = User.objects.create_user(username="sa_owner", password="x")
        self.viewer = User.objects.create_user(username="sa_viewer", password="x")
        self.classroom = create_classroom(self.owner, title="Slides")
        join_classroom(self.classroom, self.viewer)
        self.shared = SharedFile.objects.create(
            classroom=self.classroom, uploader=self.owner,
            original_name="deck.pdf", size=12, content_type="application/pdf",
        )
        self.shared.file.save("deck.pdf", ContentFile(b"%PDF-1.4 test"), save=True)
        # the room is presenting it
        self.classroom.current_file = self.shared
        self.classroom.save(update_fields=["current_file"])

    def _ws(self, user):
        return WebsocketCommunicator(
            app_with_user(user, wb_routes), f"/ws/classroom/{self.classroom.room_code}/whiteboard/"
        )

    def _draw(self, fid, ident):
        return {"action": "op", "op": {
            "type": "draw", "tool": "pen", "points": [[1, 2], [3, 4]],
            "color": "#000", "width": 2, "id": ident, "page": 1, "file_id": fid,
        }}

    def test_viewer_without_board_permission_can_annotate_the_slide(self):
        async def scenario():
            ow = self._ws(self.owner)
            connected, _ = await ow.connect()
            assert connected
            await ow.receive_json_from()          # history
            vw = self._ws(self.viewer)
            connected, _ = await vw.connect()
            assert connected
            await vw.receive_json_from()

            await vw.send_json_to(self._draw(self.shared.id, "note1"))
            msg = await ow.receive_json_from()
            assert msg["type"] == "whiteboard_operation", msg
            assert msg["op"]["file_id"] == self.shared.id
            assert msg["actor_identity"] == f"u:{self.viewer.id}"
            await ow.disconnect()
            await vw.disconnect()

        async_to_sync(scenario)()
        assert WhiteboardEvent.objects.filter(operation__id="note1").exists()

    def test_locked_presentation_rejects_viewer_ink(self):
        self.classroom.annotation_open = False
        self.classroom.save(update_fields=["annotation_open"])

        async def scenario():
            vw = self._ws(self.viewer)
            connected, _ = await vw.connect()
            assert connected
            await vw.receive_json_from()
            await vw.send_json_to(self._draw(self.shared.id, "note2"))
            msg = await vw.receive_json_from()
            assert msg["type"] == "error", msg
            await vw.disconnect()

        async_to_sync(scenario)()
        assert not WhiteboardEvent.objects.filter(operation__id="note2").exists()

    def test_viewer_cannot_ink_a_file_that_is_not_on_screen(self):
        async def scenario():
            vw = self._ws(self.viewer)
            connected, _ = await vw.connect()
            assert connected
            await vw.receive_json_from()
            await vw.send_json_to(self._draw(self.shared.id + 999, "note3"))
            msg = await vw.receive_json_from()
            assert msg["type"] == "error", msg
            await vw.disconnect()

        async_to_sync(scenario)()
        assert not WhiteboardEvent.objects.filter(operation__id="note3").exists()

    def test_viewer_still_cannot_draw_the_free_whiteboard(self):
        async def scenario():
            vw = self._ws(self.viewer)
            connected, _ = await vw.connect()
            assert connected
            await vw.receive_json_from()
            await vw.send_json_to({"action": "op", "op": {
                "type": "draw", "tool": "pen", "points": [[1, 2], [3, 4]],
                "color": "#000", "width": 2, "id": "board9", "page": 1,
            }})
            msg = await vw.receive_json_from()
            assert msg["type"] == "error", msg
            await vw.disconnect()

        assert not WhiteboardEvent.objects.filter(operation__id="board9").exists()


class OpValidationTests(TransactionTestCase):
    """Unit tests for the consumer's op validator (pure function)."""

    def setUp(self):
        from whiteboard.consumers import WhiteboardConsumer
        self.valid = WhiteboardConsumer._valid_op

    def test_pen_points_ok(self):
        self.assertTrue(self.valid({
            "type": "draw", "tool": "pen", "norm": 1,
            "points": [[0.1, 0.2], [0.3, 0.4]], "color": "#000000", "width": 3,
            "id": "x-1", "page": 1,
        }))

    def test_rectangle_geometry_ok(self):
        # normalised rect (w/h) — previously REJECTED for missing points
        self.assertTrue(self.valid({
            "type": "draw", "tool": "rectangle", "norm": 1,
            "left": 0.1, "top": 0.2, "w": 0.3, "h": 0.4,
            "color": "#000000", "width": 3, "id": "x-2", "page": 1,
        }))

    def test_circle_geometry_ok(self):
        self.assertTrue(self.valid({
            "type": "draw", "tool": "circle", "norm": 1,
            "left": 0.1, "top": 0.2, "rx": 0.15, "ry": 0.1,
            "color": "#000000", "width": 3, "id": "x-3", "page": 1,
        }))

    def test_rectangle_missing_geometry_rejected(self):
        self.assertFalse(self.valid({"type": "draw", "tool": "rectangle", "id": "x", "page": 1}))

    def test_pen_without_points_rejected(self):
        self.assertFalse(self.valid({"type": "draw", "tool": "pen", "id": "x", "page": 1}))

    def test_unknown_tool_rejected(self):
        self.assertFalse(self.valid({"type": "draw", "tool": "spray", "points": [], "id": "x", "page": 1}))

    def test_non_finite_coordinates_rejected(self):
        import math
        base = {"type": "draw", "tool": "pen", "points": [[0, 0], [1, 1]], "id": "x"}
        self.assertFalse(self.valid({**base, "points": [[0, 0], [math.inf, 1]]}))
        self.assertFalse(self.valid({**base, "points": [[0, 0], [math.nan, 1]]}))

    def test_out_of_range_normalized_coordinates_rejected(self):
        self.assertFalse(self.valid({
            "type": "draw", "tool": "pen", "norm": 1,
            "points": [[0, 0], [5000, 1]], "id": "x",
        }))

    def test_malformed_or_excessive_points_rejected(self):
        self.assertFalse(self.valid({
            "type": "draw", "tool": "pen", "points": [[1, 2]], "id": "x",
        }))
        self.assertFalse(self.valid({
            "type": "draw", "tool": "pen", "points": [[1, 2], [3]], "id": "x",
        }))
        self.assertFalse(self.valid({
            "type": "draw", "tool": "pen", "points": [[0, 0], [1, 1]] * 4097, "id": "x",
        }))

    def test_tap_is_sent_as_a_two_point_dot(self):
        """A tap (a dot — every Persian letter needs one) is encoded as a
        two-point stroke whose points sit a hair apart, so the round pen cap
        paints a dab. The server must accept it: a single point used to be
        refused, which silently swallowed the author's dots."""
        self.assertTrue(self.valid({
            "type": "draw", "tool": "pen", "norm": 1,
            "points": [[0.4, 0.5], [0.4006, 0.501]],
            "color": "#2563eb", "width": 3, "id": "dot-1", "page": 1,
        }))

    def test_dot_flag_is_accepted(self):
        """`dot:1` marks a tap: the points stay put and clients paint a circle."""
        self.assertTrue(self.valid({
            "type": "draw", "tool": "pen", "norm": 1, "dot": 1,
            "points": [[0.4, 0.5], [0.4, 0.5]],
            "color": "#2563eb", "width": 3, "id": "dot-2", "page": 1,
        }))

    def test_stroke_width_is_reference_px(self):
        """Widths travel in reference px (0.4 .. 512), independent of the
        sender's window size; the two extremes are the eraser and a fat marker."""
        base = {
            "type": "draw", "tool": "pen", "norm": 1,
            "points": [[0.1, 0.2], [0.3, 0.4]], "color": "#000000",
            "id": "w-1", "page": 1,
        }
        self.assertTrue(self.valid({**base, "width": 0.4}))
        self.assertTrue(self.valid({**base, "width": 110}))
        self.assertTrue(self.valid({**base, "width": 512}))
        self.assertFalse(self.valid({**base, "width": 512.5}))
        self.assertFalse(self.valid({**base, "width": 0}))

    def test_non_boolean_normalization_and_invalid_page_rejected(self):
        self.assertFalse(self.valid({
            "type": "draw", "tool": "pen", "norm": "false",
            "points": [[0, 0], [1, 1]], "id": "x",
        }))
        self.assertFalse(self.valid({"type": "page_go", "page": True}))
        self.assertFalse(self.valid({"type": "page_go", "page": 1000}))


class WhiteboardSnapshotTests(TransactionTestCase):
    """Replay must stay complete however long the class has been running.

    The old replay sent only the newest 2000 events, so a busy board silently
    lost its first pages for anybody who joined late or refreshed.  A board is
    now folded into a snapshot, and replay is snapshot + the events on top.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="snap_owner", password="x")
        self.classroom = create_classroom(self.owner, title="Snapshot")
        self.board, _ = Whiteboard.objects.get_or_create(classroom=self.classroom)

    def _draw_op(self, index, page=1):
        return {
            "type": "draw", "tool": "pen", "norm": 1, "id": f"op-{index}", "page": page,
            "color": "#2563eb", "width": 3,
            "points": [[0.1 + (index % 50) / 100, 0.2 + (index % 30) / 100],
                       [0.2 + (index % 50) / 100, 0.3 + (index % 30) / 100]],
        }

    def _seed(self, count, page=1, start=0):
        WhiteboardEvent.objects.bulk_create([
            WhiteboardEvent(
                whiteboard=self.board, actor=self.owner, actor_identity="u:1", page=page,
                operation=self._draw_op(i, page=page),
            )
            for i in range(start, start + count)
        ])
        return [f"op-{i}" for i in range(start, start + count)]

    def _add_event(self, op):
        return WhiteboardEvent.objects.create(
            whiteboard=self.board, actor=self.owner, actor_identity="u:1",
            page=op.get("page", 1), operation=op,
        )

    def _replay(self):
        """Connect as the owner and collect the whole replay."""
        async def scenario():
            ws = WebsocketCommunicator(
                app_with_user(self.owner, wb_routes),
                f"/ws/classroom/{self.classroom.room_code}/whiteboard/",
            )
            connected, _ = await ws.connect()
            assert connected
            snapshots, history = [], []
            while True:
                msg = await ws.receive_json_from()
                assert msg["type"] in {"whiteboard_snapshot", "whiteboard_history"}, msg
                (snapshots if msg["type"] == "whiteboard_snapshot" else history).append(msg)
                if msg["type"] == "whiteboard_history" and not msg.get("more"):
                    break
            await ws.disconnect()
            return snapshots, history

        return async_to_sync(scenario)()

    def test_whole_board_survives_compaction(self):
        """1000+ operations come back in full — none of them is dropped."""
        ids = self._seed(1300)
        snapshots, history = self._replay()

        replayed = [op["id"] for chunk in snapshots for op in chunk["ops"]]
        replayed += [e["op"]["id"] for chunk in history for e in chunk["events"]]
        self.assertEqual(len(set(replayed)), 1300)
        self.assertEqual(set(replayed), set(ids))
        # The tail was folded: replay is bounded, not 1300 events.
        self.assertTrue(snapshots, "a big board must replay as a snapshot")
        self.assertEqual(WhiteboardEvent.objects.count(), 0, "folded events are deleted")
        self.assertGreater(WhiteboardSnapshot.objects.get(whiteboard=self.board).seq, 0)

    def test_replay_frames_arrive_in_a_usable_order(self):
        """Snapshot chunks first, then the tail; exactly one closing frame.

        The client rebuilds the pages from the snapshot and then applies the
        tail on top, finishing when it sees a history frame with ``more:false``.
        """
        self._seed(1300)
        compact_board(self.board.id, force=True)
        self._seed(2, start=7000)

        async def scenario():
            ws = WebsocketCommunicator(
                app_with_user(self.owner, wb_routes),
                f"/ws/classroom/{self.classroom.room_code}/whiteboard/",
            )
            connected, _ = await ws.connect()
            assert connected
            frames = []
            while True:
                msg = await ws.receive_json_from()
                frames.append(msg)
                if msg["type"] == "whiteboard_history" and not msg.get("more"):
                    break
            await ws.disconnect()
            return frames

        frames = async_to_sync(scenario)()
        kinds = [f["type"] for f in frames]
        first_history = kinds.index("whiteboard_history")
        self.assertTrue(all(k == "whiteboard_snapshot" for k in kinds[:first_history]))
        self.assertTrue(all(k == "whiteboard_history" for k in kinds[first_history:]))
        self.assertEqual([f["chunk"] for f in frames[:first_history]], list(range(first_history)))
        # Each series ends with its own ``more:false``; the history series is
        # the one that finishes the replay for the client.
        closing = [f for f in frames if f["type"] == "whiteboard_history" and not f.get("more")]
        self.assertEqual(len(closing), 1)
        self.assertIs(frames[-1], closing[0])

    def test_snapshot_is_followed_by_the_live_tail(self):
        self._seed(1300)
        compact_board(self.board.id, force=True)
        tail_ids = self._seed(3, start=9000)

        snapshots, history = self._replay()
        snapshot_ids = [op["id"] for chunk in snapshots for op in chunk["ops"]]
        tail = [e["op"]["id"] for chunk in history for e in chunk["events"]]
        self.assertEqual(len(snapshot_ids), 1300)
        self.assertEqual(tail, tail_ids)

    def test_clear_after_snapshot_stays_applied(self):
        """A clear that lands after compaction must not be undone by old state."""
        page_one = self._seed(5, page=1)
        self._seed(4, page=2, start=100)
        compact_board(self.board.id, force=True)
        self._add_event({"type": "clear", "id": "clr-1", "page": 1})
        compact_board(self.board.id, force=True)

        snapshots, _history = self._replay()
        ids = [op["id"] for chunk in snapshots for op in chunk["ops"]]
        for op_id in page_one:
            self.assertNotIn(op_id, ids)
        self.assertEqual(len(ids), 4)

    def test_remove_after_snapshot_drops_one_operation(self):
        self._seed(3, page=1)
        compact_board(self.board.id, force=True)
        self._add_event({"type": "remove", "id": "op-1", "page": 1})
        compact_board(self.board.id, force=True)

        snapshots, _history = self._replay()
        ids = [op["id"] for chunk in snapshots for op in chunk["ops"]]
        self.assertEqual(ids, ["op-0", "op-2"])

    def test_snapshot_keeps_page_markers_and_count(self):
        self._seed(2, page=1)
        self._add_event({"type": "page_setup", "id": "setup-1", "page": 1, "grid": "dots"})
        self._add_event({"type": "page_add", "id": "page-2", "page": 2})
        compact_board(self.board.id, force=True)

        snapshots, _history = self._replay()
        self.assertEqual(snapshots[0]["pageCount"], 2)
        self.assertEqual([op["id"] for chunk in snapshots for op in chunk["ops"]],
                         ["op-0", "op-1", "setup-1"])

    def test_fold_ignores_transient_operations(self):
        state = empty_state()
        apply_op(state, {"型": "nope"})
        apply_op(state, {"type": "laser", "page": 1, "x": 0.1, "y": 0.2})
        apply_op(state, {"type": "page_go", "page": 3})
        self.assertEqual(state["ops"], [])
        self.assertEqual(state["pageCount"], 1)
        apply_op(state, {"type": "page_add", "page": 5})
        self.assertEqual(state["pageCount"], 5)
        self.assertEqual(state["ops"], [])

    def test_normalise_state_survives_junk(self):
        self.assertEqual(normalise_state(None)["ops"], [])
        self.assertEqual(normalise_state({"ops": "nope", "pageCount": "x"})["pageCount"], 1)
        state = normalise_state({"ops": [{"type": "draw", "id": "a"}, "junk"], "pageCount": 3})
        self.assertEqual(len(state["ops"]), 1)
        self.assertEqual(state["pageCount"], 3)

    def test_snapshot_chunks_stay_under_the_frame_limit(self):
        """A big materialised board must still fit into WebSocket frames."""
        op = {
            "type": "draw", "tool": "pen", "norm": 1, "id": "big", "page": 1,
            "color": "#2563eb", "width": 3,
            "points": [[round(0.0001 * i, 4), round(0.0002 * i, 4)] for i in range(400)],
        }
        state = {"version": 1, "pageCount": 1, "ops": [{**op, "id": f"big-{i}"} for i in range(600)]}
        chunks = WhiteboardConsumer._snapshot_chunks(state, 42)
        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertLessEqual(len(json.dumps(chunk, separators=(",", ":"))), 1024 * 1024)
        self.assertFalse(chunks[-1]["more"])
        self.assertEqual(sum(len(c["ops"]) for c in chunks), 600)


class WhiteboardHistoryTailTests(TransactionTestCase):
    """A long board replays in full, in chronological order, in safe frames."""

    def setUp(self):
        self.owner = User.objects.create_user(username="hist_owner", password="x")
        self.classroom = create_classroom(self.owner, title="History tail")

    def test_long_history_replays_every_operation(self):
        """2000+ operations: the old replay cut everything before the last 2000.

        With snapshots the whole board comes back — the folded state first, then
        whatever tail is newer than it.
        """
        board = Whiteboard.objects.create(classroom=self.classroom)
        WhiteboardEvent.objects.bulk_create([
            WhiteboardEvent(
                whiteboard=board,
                actor=self.owner,
                actor_identity=f"u:{self.owner.id}",
                page=1,
                operation={
                    "type": "draw", "tool": "pen", "norm": 1, "id": f"event-{i}", "page": 1,
                    "color": "#2563eb", "width": 3, "points": [[0.1, 0.2], [0.3, 0.4]],
                },
            )
            for i in range(2001)
        ])
        last_id = WhiteboardEvent.objects.order_by("-id").first().id

        async def scenario():
            ws = WebsocketCommunicator(
                app_with_user(self.owner, wb_routes),
                f"/ws/classroom/{self.classroom.room_code}/whiteboard/",
            )
            connected, code = await ws.connect()
            assert connected, code
            snapshot, events, last = [], [], None
            while True:
                msg = await ws.receive_json_from(timeout=5)
                last = msg
                if msg["type"] == "whiteboard_snapshot":
                    snapshot.extend(op["id"] for op in msg["ops"])
                elif msg["type"] == "whiteboard_history":
                    events.extend(e["id"] for e in msg["events"])
                    if not msg.get("more"):
                        break
                else:  # pragma: no cover - protocol guard
                    raise AssertionError(msg)
            await ws.disconnect()
            return snapshot, events, last

        snapshot_ids, tail_ids, last_frame = async_to_sync(scenario)()
        replayed = snapshot_ids + [e for e in tail_ids]
        self.assertEqual(replayed, [f"event-{i}" for i in range(2001)])
        self.assertEqual(last_frame["seq"], last_id)
        self.assertLessEqual(WhiteboardEvent.objects.count(), 1200)
