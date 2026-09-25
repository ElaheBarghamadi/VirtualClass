"""WebSocket tests for the classroom presence consumer and the chat consumer.

Consumers are exercised through their real ASGI stack (URLRouter +
consumers), with the authenticated user injected into the scope the same
way ``AuthMiddlewareStack`` would.
"""
from asgiref.sync import async_to_sync
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.test import TransactionTestCase

from chat.routing import websocket_urlpatterns as chat_routes
from classrooms.routing import websocket_urlpatterns as classroom_routes
from classrooms.services import create_classroom, join_classroom

User = get_user_model()


def app_with_user(user, routes):
    """Wrap the given WS routes in an app that injects ``user`` into the scope."""
    inner = URLRouter(routes)

    async def app(scope, receive, send):
        scope = dict(scope)
        scope["user"] = user
        await inner(scope, receive, send)

    return app


class PresenceConsumerTests(TransactionTestCase):
    def test_join_and_leave_events(self):
        owner = User.objects.create_user(username="p_owner", password="x")
        student = User.objects.create_user(username="p_student", password="x")
        classroom = create_classroom(owner, title="Presence")
        join_classroom(classroom, student)

        async def scenario():
            owner_ws = WebsocketCommunicator(
                app_with_user(owner, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, _ = await owner_ws.connect()
            assert connected

            # Owner receives its own snapshot on connect.
            data = await owner_ws.receive_json_from()
            assert data["type"] == "participant_list"
            assert len(data["participants"]) == 2

            # Then its own join broadcast.
            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "user_joined"
            assert msg["participant"]["user_id"] == owner.id

            # A second member joins → owner gets user_joined for them.
            student_ws = WebsocketCommunicator(
                app_with_user(student, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, _ = await student_ws.connect()
            assert connected

            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "user_joined"
            assert msg["participant"]["user_id"] == student.id

            # Student leaves → owner gets user_left.
            await student_ws.disconnect()
            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "user_left"
            assert msg["participant"]["user_id"] == student.id

            await owner_ws.disconnect()

        async_to_sync(scenario)()

    def test_non_member_rejected(self):
        owner = User.objects.create_user(username="p_owner2", password="x")
        stranger = User.objects.create_user(username="stranger", password="x")
        classroom = create_classroom(owner, title="Private")

        async def scenario():
            ws = WebsocketCommunicator(
                app_with_user(stranger, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, code = await ws.connect()
            assert not connected
            assert code == 4403

        async_to_sync(scenario)()

    def test_anonymous_rejected(self):
        from django.contrib.auth.models import AnonymousUser

        owner = User.objects.create_user(username="p_owner3", password="x")
        classroom = create_classroom(owner, title="Anon")

        async def scenario():
            ws = WebsocketCommunicator(
                app_with_user(AnonymousUser(), classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, code = await ws.connect()
            assert not connected
            assert code == 4401

        async_to_sync(scenario)()


class RaiseHandTests(TransactionTestCase):
    def test_raise_and_lower_hand_broadcast(self):
        owner = User.objects.create_user(username="rh_owner", password="x")
        student = User.objects.create_user(username="rh_student", password="x")
        classroom = create_classroom(owner, title="Hands")
        join_classroom(classroom, student)

        async def scenario():
            owner_ws = WebsocketCommunicator(
                app_with_user(owner, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            await owner_ws.connect()
            await owner_ws.receive_json_from()  # snapshot
            await owner_ws.receive_json_from()  # own join

            student_ws = WebsocketCommunicator(
                app_with_user(student, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            await student_ws.connect()
            await owner_ws.receive_json_from()  # student joined

            await student_ws.send_json_to({"action": "raise_hand", "raised": True})
            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "raise_hand" and msg["participant"]["user_id"] == student.id

            await student_ws.send_json_to({"action": "raise_hand", "raised": False})
            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "lower_hand"

            await student_ws.disconnect()
            await owner_ws.disconnect()

        async_to_sync(scenario)()

        member = classroom.members.get(user=student)
        self.assertIsNone(member.hand_raised_at)


class ChatConsumerTests(TransactionTestCase):
    def test_send_message_persists_and_broadcasts(self):
        owner = User.objects.create_user(username="c_owner", password="x")
        student = User.objects.create_user(username="c_student", password="x")
        classroom = create_classroom(owner, title="Chat")
        join_classroom(classroom, student)

        async def scenario():
            owner_ws = WebsocketCommunicator(
                app_with_user(owner, chat_routes), f"/ws/classroom/{classroom.room_code}/chat/"
            )
            connected, _ = await owner_ws.connect()
            assert connected
            history = await owner_ws.receive_json_from()
            assert history["type"] == "chat_history"

            student_ws = WebsocketCommunicator(
                app_with_user(student, chat_routes), f"/ws/classroom/{classroom.room_code}/chat/"
            )
            connected, _ = await student_ws.connect()
            assert connected
            await student_ws.receive_json_from()  # history

            await student_ws.send_json_to({"action": "send_message", "message": "سلام کلاس!"})

            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "chat_message"
            assert msg["message"]["message"] == "سلام کلاس!"
            assert msg["message"]["sender_name"] == "c_student"

            echo = await student_ws.receive_json_from()
            assert echo["message"]["message"] == "سلام کلاس!"

            await owner_ws.disconnect()
            await student_ws.disconnect()

        async_to_sync(scenario)()

        # The message must be persisted in the database.
        from chat.models import ChatMessage

        self.assertEqual(ChatMessage.objects.filter(classroom=classroom).count(), 1)

    def test_non_member_rejected(self):
        owner = User.objects.create_user(username="c_owner2", password="x")
        stranger = User.objects.create_user(username="c_stranger", password="x")
        classroom = create_classroom(owner, title="NoChat")

        async def scenario():
            ws = WebsocketCommunicator(
                app_with_user(stranger, chat_routes), f"/ws/classroom/{classroom.room_code}/chat/"
            )
            connected, code = await ws.connect()
            assert not connected
            assert code == 4403

        async_to_sync(scenario)()
