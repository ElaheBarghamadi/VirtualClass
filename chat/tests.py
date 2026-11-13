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
from classrooms import consumers as classrooms_consumers
from classrooms.routing import websocket_urlpatterns as classroom_routes
from classrooms.services import create_classroom, join_classroom, set_member_permission

User = get_user_model()


def allow(classroom, owner, user, *capabilities):
    """Grant capabilities to one member, exactly like the owner does by hand."""
    member = classroom.members.get(user=user)
    for capability in capabilities:
        set_member_permission(classroom, owner, member.id, capability, True)
    return member


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

    def test_second_socket_does_not_duplicate_join_or_leave(self):
        """One person, two tabs: the roster must not blink them out of the room.

        Closing a spare tab used to broadcast ``user_left`` even though the
        student was still there (their stage tile vanished for everybody and
        their attendance was split in two).
        """
        owner = User.objects.create_user(username="ms_owner", password="x")
        student = User.objects.create_user(username="ms_student", password="x")
        classroom = create_classroom(owner, title="Multi socket")
        join_classroom(classroom, student)

        async def scenario():
            owner_ws = WebsocketCommunicator(
                app_with_user(owner, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, _ = await owner_ws.connect()
            assert connected
            await owner_ws.receive_json_from()   # participant_list
            await owner_ws.receive_json_from()   # own user_joined

            first = WebsocketCommunicator(
                app_with_user(student, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, _ = await first.connect()
            assert connected
            await first.receive_json_from()      # participant_list
            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "user_joined"
            assert msg["participant"]["user_id"] == student.id

            # The same student opens a second tab.
            second = WebsocketCommunicator(
                app_with_user(student, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, _ = await second.connect()
            assert connected
            await second.receive_json_from()     # snapshot only, no second join

            # Closing the spare tab must NOT report a departure.
            await second.disconnect()
            await owner_ws.send_json_to({"action": "ping"})
            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "pong", f"unexpected event after spare-tab close: {msg['type']}"

            # Closing the last tab does.
            await first.disconnect()
            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "user_left"
            assert msg["participant"]["user_id"] == student.id

            await owner_ws.disconnect()

        async_to_sync(scenario)()


class MediaSnapshotTests(TransactionTestCase):
    """A joining client must learn who already has a live mic or camera.

    Media flags used to exist only as a live broadcast, so anyone arriving
    after the fact received a roster with no media state at all — and with
    idle participants kept off the stage that reads as an empty classroom.
    """

    def test_late_joiner_receives_current_media_flags(self):
        owner = User.objects.create_user(username="ms_owner", password="x")
        student = User.objects.create_user(username="ms_student", password="x")
        late = User.objects.create_user(username="ms_late", password="x")
        classroom = create_classroom(owner, title="Media snapshot")
        join_classroom(classroom, student)
        join_classroom(classroom, late)
        owner_member_id = classroom.members.get(user=owner).id

        async def scenario():
            owner_ws = WebsocketCommunicator(
                app_with_user(owner, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, _ = await owner_ws.connect()
            assert connected
            await owner_ws.receive_json_from()   # snapshot
            await owner_ws.receive_json_from()   # own join

            student_ws = WebsocketCommunicator(
                app_with_user(student, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, _ = await student_ws.connect()
            assert connected
            await student_ws.receive_json_from()  # snapshot
            await student_ws.receive_json_from()  # own join
            await owner_ws.receive_json_from()    # student joined

            await owner_ws.send_json_to(
                {"action": "media_state", "mic_on": True, "camera_on": True, "screen_sharing": False}
            )
            await owner_ws.receive_json_from()    # media_state broadcast
            await student_ws.receive_json_from()

            late_ws = WebsocketCommunicator(
                app_with_user(late, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, _ = await late_ws.connect()
            assert connected
            snapshot = await late_ws.receive_json_from()
            assert snapshot["type"] == "participant_list"
            by_id = {p["member_id"]: p for p in snapshot["participants"]}
            owner_row = by_id[owner_member_id]
            assert owner_row["mic_on"] is True
            assert owner_row["camera_on"] is True
            assert owner_row["screen_sharing"] is False

            await late_ws.disconnect()
            await student_ws.disconnect()
            await owner_ws.disconnect()

        async_to_sync(scenario)()

    def test_media_state_is_dropped_when_the_member_leaves(self):
        owner = User.objects.create_user(username="md_owner", password="x")
        student = User.objects.create_user(username="md_student", password="x")
        classroom = create_classroom(owner, title="Media cleanup")
        join_classroom(classroom, student)

        async def scenario():
            ws = WebsocketCommunicator(
                app_with_user(student, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, _ = await ws.connect()
            assert connected
            await ws.receive_json_from()   # snapshot
            await ws.receive_json_from()   # own join
            await ws.send_json_to(
                {"action": "media_state", "mic_on": True, "camera_on": False, "screen_sharing": False}
            )
            await ws.receive_json_from()   # broadcast
            await ws.disconnect()

        async_to_sync(scenario)()
        key = (classroom.room_code, classroom.members.get(user=student).id)
        assert key not in classrooms_consumers._media_states


class RaiseHandTests(TransactionTestCase):
    def test_raise_and_lower_hand_broadcast(self):
        owner = User.objects.create_user(username="rh_owner", password="x")
        student = User.objects.create_user(username="rh_student", password="x")
        classroom = create_classroom(owner, title="Hands")
        join_classroom(classroom, student)
        allow(classroom, owner, student, "can_raise_hand")

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


class ReactionTests(TransactionTestCase):
    """Quick reactions are ephemeral: validated, broadcast, never stored."""

    def test_reaction_broadcast_to_room(self):
        owner = User.objects.create_user(username="rx_owner", password="x")
        student = User.objects.create_user(username="rx_student", password="x")
        classroom = create_classroom(owner, title="Reactions")
        join_classroom(classroom, student)
        # Reactions ride the raise-hand grant: nothing is on by default.
        student_member_id = allow(classroom, owner, student, "can_raise_hand").id

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

            await student_ws.send_json_to({"action": "reaction", "reaction": "heart"})
            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "reaction"
            assert msg["reaction"] == "heart"
            assert msg["member_id"] == student_member_id

            # An unknown key must be silently dropped, not broadcast: the next
            # thing the owner sees is the following valid reaction.
            await student_ws.send_json_to({"action": "reaction", "reaction": "banana"})
            await student_ws.send_json_to({"action": "reaction", "reaction": "star"})
            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "reaction" and msg["reaction"] == "star", msg

            await student_ws.disconnect()
            await owner_ws.disconnect()

        async_to_sync(scenario)()

    def test_reaction_requires_membership(self):
        owner = User.objects.create_user(username="rx_owner2", password="x")
        stranger = User.objects.create_user(username="rx_stranger", password="x")
        classroom = create_classroom(owner, title="NoReact")

        async def scenario():
            ws = WebsocketCommunicator(
                app_with_user(stranger, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, _ = await ws.connect()
            assert not connected

        async_to_sync(scenario)()


class CaptionRelayTests(TransactionTestCase):
    """Captions are recognised on the device and only relayed by the server."""

    def test_caption_is_relayed_and_truncated(self):
        owner = User.objects.create_user(username="cap_owner", password="x")
        student = User.objects.create_user(username="cap_student", password="x")
        classroom = create_classroom(owner, title="Captions")
        join_classroom(classroom, student)
        # Captions are the speaker's own words: they follow the microphone grant.
        student_member_id = allow(classroom, owner, student, "can_use_microphone").id

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

            await student_ws.send_json_to({"action": "caption", "text": "سلام  کلاس", "final": True})
            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "caption", msg
            assert msg["text"] == "سلام کلاس"          # whitespace normalised
            assert msg["final"] is True
            assert msg["member_id"] == student_member_id

            # Over-long text is clipped, never relayed at full size.
            await student_ws.send_json_to({"action": "caption", "text": "ی" * 500, "final": True})
            msg = await owner_ws.receive_json_from()
            assert msg["type"] == "caption"
            assert len(msg["text"]) == 200

            await student_ws.disconnect()
            await owner_ws.disconnect()

        async_to_sync(scenario)()

    def test_non_member_cannot_send_captions(self):
        owner = User.objects.create_user(username="cap_owner2", password="x")
        stranger = User.objects.create_user(username="cap_stranger", password="x")
        classroom = create_classroom(owner, title="NoCaption")

        async def scenario():
            ws = WebsocketCommunicator(
                app_with_user(stranger, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            connected, _ = await ws.connect()
            assert not connected

        async_to_sync(scenario)()


class ReactionSummaryTests(TransactionTestCase):
    """Reactions stay ephemeral, but each window posts one digest line in chat."""

    def setUp(self):
        # Shrink the aggregation window so the test does not sleep for seconds.
        self._delay = classrooms_consumers.REACTION_SUMMARY_DELAY
        classrooms_consumers.REACTION_SUMMARY_DELAY = 0.05

    def tearDown(self):
        classrooms_consumers.REACTION_SUMMARY_DELAY = self._delay
        classrooms_consumers._reaction_windows.clear()

    def _setup_room(self):
        owner = User.objects.create_user(username="rs_owner", password="x")
        first = User.objects.create_user(username="rs_one", password="x")
        second = User.objects.create_user(username="rs_two", password="x")
        classroom = create_classroom(owner, title="Digest")
        join_classroom(classroom, first)
        join_classroom(classroom, second)
        allow(classroom, owner, first, "can_raise_hand")
        allow(classroom, owner, second, "can_raise_hand")
        return owner, first, second, classroom

    def test_multiple_reactions_become_one_chat_digest(self):
        owner, first, second, classroom = self._setup_room()

        async def scenario():
            chat_ws = WebsocketCommunicator(
                app_with_user(owner, chat_routes), f"/ws/classroom/{classroom.room_code}/chat/"
            )
            connected, _ = await chat_ws.connect()
            assert connected
            await chat_ws.receive_json_from()  # history

            sockets = []
            for user in (first, second):
                ws = WebsocketCommunicator(
                    app_with_user(user, classroom_routes),
                    f"/ws/classroom/{classroom.room_code}/",
                )
                await ws.connect()
                await ws.receive_json_from()  # snapshot
                await ws.receive_json_from()  # own join
                sockets.append(ws)

            for ws in sockets:
                await ws.send_json_to({"action": "reaction", "reaction": "thumbs"})

            msg = await chat_ws.receive_json_from(timeout=2)
            assert msg["type"] == "reaction_summary", msg
            assert msg["text"] == "2 نفر تأیید کردند", msg

            for ws in sockets:
                await ws.disconnect()
            await chat_ws.disconnect()

        async_to_sync(scenario)()

    def test_single_reaction_does_not_post_to_chat(self):
        owner, first, _second, classroom = self._setup_room()

        async def scenario():
            chat_ws = WebsocketCommunicator(
                app_with_user(owner, chat_routes), f"/ws/classroom/{classroom.room_code}/chat/"
            )
            await chat_ws.connect()
            await chat_ws.receive_json_from()

            ws = WebsocketCommunicator(
                app_with_user(first, classroom_routes), f"/ws/classroom/{classroom.room_code}/"
            )
            await ws.connect()
            await ws.receive_json_from()
            await ws.receive_json_from()

            await ws.send_json_to({"action": "reaction", "reaction": "heart"})

            quiet = await chat_ws.receive_nothing(timeout=0.5)
            assert quiet, "a lone reaction must not spam the chat"

            await ws.disconnect()
            await chat_ws.disconnect()

        async_to_sync(scenario)()


class ChatConsumerTests(TransactionTestCase):
    def test_send_message_persists_and_broadcasts(self):
        owner = User.objects.create_user(username="c_owner", password="x")
        student = User.objects.create_user(username="c_student", password="x")
        classroom = create_classroom(owner, title="Chat")
        join_classroom(classroom, student)
        allow(classroom, owner, student, "can_send_messages")

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


class ChatPrivacyModeTests(TransactionTestCase):
    """Who reads a student's message is the owner's call, not the student's.

    »chat_private« on the classroom means: a student message is addressed to the
    host team (and its author) and never leaves that circle.  Off means the
    class reads it.  The consumer reads the setting from the database for every
    message, so flipping it mid-lesson takes effect on the next line.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="pv_owner", password="x")
        self.student = User.objects.create_user(username="pv_student", password="x")
        self.other = User.objects.create_user(username="pv_other", password="x")
        self.classroom = create_classroom(self.owner, title="Private")
        join_classroom(self.classroom, self.student)
        join_classroom(self.classroom, self.other)
        allow(self.classroom, self.owner, self.student, "can_send_messages")
        allow(self.classroom, self.owner, self.other, "can_send_messages")

    def _ws(self, user):
        return WebsocketCommunicator(
            app_with_user(user, chat_routes),
            f"/ws/classroom/{self.classroom.room_code}/chat/",
        )

    def _set_mode(self, private: bool):
        self.classroom.refresh_from_db()
        self.classroom.chat_private = private
        self.classroom.save(update_fields=["chat_private"])

    def test_public_mode_reaches_the_whole_class(self):
        from chat.models import ChatMessage

        async def scenario():
            owner_ws, student_ws, other_ws = self._ws(self.owner), self._ws(self.student), self._ws(self.other)
            for ws in (owner_ws, student_ws, other_ws):
                await ws.connect()
                await ws.receive_json_from()  # history

            await student_ws.send_json_to({"action": "send_message", "message": "سلام"})

            host_copy = await owner_ws.receive_json_from()
            assert host_copy["message"]["is_private"] is False
            echo = await student_ws.receive_json_from()
            assert echo["message"]["is_private"] is False
            classmate = await other_ws.receive_json_from()
            assert classmate["message"]["message"] == "سلام"

            for ws in (owner_ws, student_ws, other_ws):
                await ws.disconnect()

        async_to_sync(scenario)()
        self.assertFalse(ChatMessage.objects.get().is_private)

    def test_private_mode_only_reaches_the_host_team(self):
        from chat.models import ChatMessage

        self._set_mode(True)

        async def scenario():
            owner_ws, student_ws, other_ws = self._ws(self.owner), self._ws(self.student), self._ws(self.other)
            for ws in (owner_ws, student_ws, other_ws):
                await ws.connect()
                await ws.receive_json_from()

            await student_ws.send_json_to({"action": "send_message", "message": "نمره‌ام چند شد؟"})

            host_copy = await owner_ws.receive_json_from()
            assert host_copy["type"] == "chat_message"
            assert host_copy["message"]["is_private"] is True
            assert host_copy["message"]["message"] == "نمره‌ام چند شد؟"

            echo = await student_ws.receive_json_from()
            assert echo["message"]["is_private"] is True

            # The classmate must not see the bubble, the event or anything else.
            assert await other_ws.receive_nothing(), "private chat leaked to a classmate"

            for ws in (owner_ws, student_ws, other_ws):
                await ws.disconnect()

        async_to_sync(scenario)()
        row = ChatMessage.objects.get()
        self.assertTrue(row.is_private)
        self.assertEqual(row.audience_member.user, self.student)

    def test_host_messages_stay_public_in_private_mode(self):
        from chat.models import ChatMessage

        self._set_mode(True)

        async def scenario():
            owner_ws, other_ws = self._ws(self.owner), self._ws(self.other)
            for ws in (owner_ws, other_ws):
                await ws.connect()
                await ws.receive_json_from()

            await owner_ws.send_json_to({"action": "send_message", "message": "شروع می‌کنیم"})
            seen = await other_ws.receive_json_from()
            assert seen["message"]["is_private"] is False
            await owner_ws.receive_json_from()

            await owner_ws.disconnect()
            await other_ws.disconnect()

        async_to_sync(scenario)()
        self.assertFalse(ChatMessage.objects.get().is_private)

    def test_flipping_the_mode_applies_to_the_next_message(self):
        from chat.models import ChatMessage

        async def scenario():
            student_ws = self._ws(self.student)
            await student_ws.connect()
            await student_ws.receive_json_from()

            await student_ws.send_json_to({"action": "send_message", "message": "اول"})
            first = await student_ws.receive_json_from()
            assert first["message"]["is_private"] is False

            # the owner flips the switch between two messages
            from asgiref.sync import sync_to_async
            await sync_to_async(self._set_mode)(True)

            await student_ws.send_json_to({"action": "send_message", "message": "دوم"})
            second = await student_ws.receive_json_from()
            assert second["message"]["is_private"] is True
            await student_ws.disconnect()

        async_to_sync(scenario)()
        flags = list(ChatMessage.objects.order_by("id").values_list("is_private", flat=True))
        self.assertEqual(flags, [False, True])

    def test_private_history_is_filtered_per_member(self):
        from chat.consumers import _visible_messages
        from chat.models import ChatMessage
        from classrooms.models import ClassroomMember

        student_member = ClassroomMember.objects.get(classroom=self.classroom, user=self.student)
        other_member = ClassroomMember.objects.get(classroom=self.classroom, user=self.other)
        owner_member = ClassroomMember.objects.get(classroom=self.classroom, user=self.owner)

        ChatMessage.objects.create(
            classroom=self.classroom, sender=self.owner, sender_member=owner_member,
            sender_name="مالک", message="عمومی",
        )
        ChatMessage.objects.create(
            classroom=self.classroom, sender=self.student, sender_member=student_member,
            sender_name="دانش‌آموز", message="خصوصی", is_private=True,
            audience_member=student_member,
        )

        def texts(member):
            return [m.message for m in _visible_messages(self.classroom, member)]

        self.assertEqual(texts(student_member), ["عمومی", "خصوصی"])
        self.assertEqual(texts(other_member), ["عمومی"])
        self.assertEqual(texts(owner_member), ["عمومی", "خصوصی"])

    def test_host_reply_in_the_private_thread_stays_with_that_student(self):
        from chat.models import ChatMessage

        self._set_mode(True)

        async def scenario():
            owner_ws, student_ws, other_ws = self._ws(self.owner), self._ws(self.student), self._ws(self.other)
            for ws in (owner_ws, student_ws, other_ws):
                await ws.connect()
                await ws.receive_json_from()

            await student_ws.send_json_to({"action": "send_message", "message": "سوال خصوصی"})
            asked = await student_ws.receive_json_from()
            await owner_ws.receive_json_from()
            await other_ws.receive_nothing()

            # the browser sends no privacy flag at all: the server decides
            await owner_ws.send_json_to({
                "action": "send_message", "message": "جواب شما",
                "reply_to": asked["message"]["id"],
            })
            answer = await student_ws.receive_json_from()
            assert answer["message"]["message"] == "جواب شما"
            assert answer["message"]["is_private"] is True
            assert answer["message"]["reply_to"]["id"] == asked["message"]["id"]
            await owner_ws.receive_json_from()
            assert await other_ws.receive_nothing(), "host reply leaked to a classmate"

            for ws in (owner_ws, student_ws, other_ws):
                await ws.disconnect()

        async_to_sync(scenario)()
        reply = ChatMessage.objects.exclude(reply_to=None).get()
        self.assertTrue(reply.is_private)
        self.assertEqual(reply.audience_member.user, self.student)

    def test_a_reply_to_a_private_message_stays_private_after_the_room_turns_public(self):
        """A quote must never drag its parent into the class."""
        from chat.models import ChatMessage

        self._set_mode(True)

        async def scenario():
            from asgiref.sync import sync_to_async

            owner_ws, student_ws, other_ws = self._ws(self.owner), self._ws(self.student), self._ws(self.other)
            for ws in (owner_ws, student_ws, other_ws):
                await ws.connect()
                await ws.receive_json_from()

            await student_ws.send_json_to({"action": "send_message", "message": "سوال خصوصی"})
            asked = await student_ws.receive_json_from()
            await owner_ws.receive_json_from()
            assert await other_ws.receive_nothing()

            # the owner flips the room back to public before answering
            await sync_to_async(self._set_mode)(False)

            await owner_ws.send_json_to({
                "action": "send_message", "message": "جواب خصوصی",
                "reply_to": asked["message"]["id"],
            })
            answer = await student_ws.receive_json_from()
            assert answer["message"]["is_private"] is True, answer["message"]
            assert answer["message"]["reply_to"]["message"] == "سوال خصوصی"
            assert await other_ws.receive_nothing(), "the quoted private question leaked"

            for ws in (owner_ws, student_ws, other_ws):
                await ws.disconnect()

        async_to_sync(scenario)()
        reply = ChatMessage.objects.exclude(reply_to=None).get()
        self.assertTrue(reply.is_private)
        self.assertEqual(reply.audience_member.user, self.student)

    def test_a_student_cannot_make_a_private_message_public(self):
        """Whatever the client claims, ``chat_private`` wins."""
        from chat.models import ChatMessage
        from classrooms.models import ClassroomMember

        self._set_mode(True)

        async def scenario():
            student_ws, other_ws = self._ws(self.student), self._ws(self.other)
            for ws in (student_ws, other_ws):
                await ws.connect()
                await ws.receive_json_from()

            await student_ws.send_json_to({"action": "send_message", "message": "ببینید!"})
            await student_ws.receive_json_from()
            assert await other_ws.receive_nothing(), "a classmate received a private message"

            await student_ws.disconnect()
            await other_ws.disconnect()

        async_to_sync(scenario)()
        self.assertTrue(ChatMessage.objects.get().is_private)

    def test_public_reply_carries_a_snippet(self):
        from chat.models import ChatMessage

        async def scenario():
            owner_ws = self._ws(self.owner)
            await owner_ws.connect()
            await owner_ws.receive_json_from()

            await owner_ws.send_json_to({"action": "send_message", "message": "پیام اول"})
            first = await owner_ws.receive_json_from()
            assert first["message"]["reply_to"] is None

            await owner_ws.send_json_to({
                "action": "send_message", "message": "پیام دوم",
                "reply_to": first["message"]["id"],
            })
            second = await owner_ws.receive_json_from()
            quote = second["message"]["reply_to"]
            assert quote["id"] == first["message"]["id"]
            assert quote["message"] == "پیام اول"
            await owner_ws.disconnect()

        async_to_sync(scenario)()
        self.assertEqual(ChatMessage.objects.count(), 2)

    def test_reply_to_a_message_you_cannot_read_is_dropped(self):
        from chat.models import ChatMessage
        from classrooms.models import ClassroomMember

        owner_member = ClassroomMember.objects.get(classroom=self.classroom, user=self.owner)
        secret = ChatMessage.objects.create(
            classroom=self.classroom, sender=self.owner, sender_member=owner_member,
            sender_name="مالک", message="فقط کارکنان", is_private=True,
        )

        async def scenario():
            ws = self._ws(self.student)
            await ws.connect()
            history = await ws.receive_json_from()
            assert history["messages"] == []
            await ws.send_json_to({
                "action": "send_message", "message": "نقل قول",
                "reply_to": secret.id,
            })
            sent = await ws.receive_json_from()
            assert sent["message"]["reply_to"] is None
            await ws.disconnect()

        async_to_sync(scenario)()
        self.assertEqual(ChatMessage.objects.filter(reply_to=secret).count(), 0)

    def test_only_the_owner_can_flip_the_mode(self):
        from classrooms.services import PermissionDenied, update_settings

        with self.assertRaises(PermissionDenied):
            update_settings(self.classroom, self.student, {"chat_private": True})
        self.classroom.refresh_from_db()
        self.assertFalse(self.classroom.chat_private)

        update_settings(self.classroom, self.owner, {"chat_private": True})
        self.classroom.refresh_from_db()
        self.assertTrue(self.classroom.chat_private)
