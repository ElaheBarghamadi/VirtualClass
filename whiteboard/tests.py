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
