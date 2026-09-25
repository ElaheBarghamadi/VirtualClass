"""WebSocket tests for the collaborative whiteboard + chat moderation.

Consumers run through their real ASGI routing with the authenticated
user injected into the scope the way ``AuthMiddlewareStack`` would.
"""
import asyncio

from asgiref.sync import async_to_sync
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
from whiteboard.models import Whiteboard, WhiteboardEvent
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
            await ws.send_json_to({"action": "op", "op": {"type": "draw", "tool": "laser", "points": []}})
            msg = await ws.receive_json_from()
            assert msg["type"] == "error"
            await ws.disconnect()

        async_to_sync(scenario)()
        self.assertEqual(WhiteboardEvent.objects.count(), 0)

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
