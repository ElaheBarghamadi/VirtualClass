"""View-only classroom: a student watches, they do not operate.

The policy these tests pin down (and the reason it exists):

* a STUDENT or GUEST gets **no** shared-content capability by default — no
  whiteboard ink, no screen share, no file upload, no presenting;
* the *room-wide* switches must not be able to hand those to everybody at once:
  the only way a student gains ink is an explicit per-member grant the owner
  makes by hand (participants panel);
* opening/closing the board and changing its pages (add / switch / clear /
  background) belong to OWNER / MODERATOR / PRESENTER — a per-member ink grant
  never widens into "may reorganise what the class is looking at";
* none of this may take *viewing* away: a read-only member still connects and
  still receives the board replay.
"""
from __future__ import annotations

import re

from asgiref.sync import async_to_sync
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.test import TestCase, TransactionTestCase
from django.urls import reverse

from .models import ClassroomMember
from .permissions import (
    Role,
    effective_permissions,
    is_authority,
    may_control_board,
    may_write_board,
)
from .routing import websocket_urlpatterns as classroom_routes
from .services import (
    create_classroom,
    join_classroom,
    join_classroom_guest,
    set_member_permission,
    set_member_role,
    set_presentation,
)

User = get_user_model()
PASSWORD = "Pass-12345"


def make_user(username: str) -> User:
    return User.objects.create_user(username=username, password=PASSWORD, email=f"{username}@x.com")


def app_with_user(user, routes):
    inner = URLRouter(routes)

    async def app(scope, receive, send):
        scope = dict(scope)
        scope["user"] = user
        await inner(scope, receive, send)

    return app


class ViewOnlyPermissionTests(TestCase):
    def setUp(self):
        self.owner = make_user("vo_owner")
        self.student_user = make_user("vo_student")
        self.classroom = create_classroom(self.owner, title="View only")
        self.student = join_classroom(self.classroom, self.student_user)
        self.owner_member = ClassroomMember.objects.get(classroom=self.classroom, user=self.owner)

    def _grant(self, member, capability="can_use_whiteboard"):
        set_member_permission(self.classroom, self.owner, member.id, capability, True)
        member.refresh_from_db()
        return member

    def test_student_defaults_are_read_only_for_shared_content(self):
        perms = effective_permissions(self.student, self.classroom)
        self.assertFalse(perms["can_use_whiteboard"])
        self.assertFalse(perms["can_share_screen"])
        self.assertFalse(perms["can_upload_files"])
        self.assertFalse(perms["can_present"])

    def test_guest_defaults_are_read_only_too(self):
        guest = join_classroom_guest(self.classroom, "مهمان")
        perms = effective_permissions(guest, self.classroom)
        self.assertFalse(perms["can_use_whiteboard"])
        self.assertFalse(perms["can_share_screen"])
        self.assertFalse(perms["can_upload_files"])
        self.assertFalse(perms["can_present"])

    def test_manual_grant_is_the_only_way_in(self):
        self.assertFalse(effective_permissions(self.student, self.classroom)["can_use_whiteboard"])
        self._grant(self.student)
        self.assertTrue(effective_permissions(self.student, self.classroom)["can_use_whiteboard"])

    def test_legacy_room_wide_switch_cannot_grant_the_board(self):
        """The old «تختهٔ دانشآموزان» switch handed the board to every student."""
        self.classroom.allow_student_whiteboard = True
        self.classroom.allow_student_screen_share = True
        self.classroom.save(update_fields=["allow_student_whiteboard", "allow_student_screen_share"])
        perms = effective_permissions(self.student, self.classroom)
        self.assertFalse(perms["can_use_whiteboard"])
        self.assertFalse(perms["can_share_screen"])

    def test_authority_roles_own_the_board(self):
        presenter = join_classroom(self.classroom, make_user("vo_presenter"))
        set_member_role(self.classroom, self.owner, presenter.id, Role.PRESENTER)
        moderator = join_classroom(self.classroom, make_user("vo_mod"))
        set_member_role(self.classroom, self.owner, moderator.id, Role.MODERATOR)

        for member in (self.owner_member, presenter, moderator):
            member.refresh_from_db()
            self.assertTrue(is_authority(member), member.role)
            self.assertTrue(may_control_board(member, self.classroom), member.role)
            self.assertTrue(effective_permissions(member, self.classroom)["can_use_whiteboard"])

        self.student.refresh_from_db()
        self.assertFalse(is_authority(self.student))
        self.assertFalse(may_control_board(self.student, self.classroom))

    def test_a_granted_student_may_write_but_never_control_the_board(self):
        self._grant(self.student)
        self.student.refresh_from_db()
        ink = {"type": "draw", "tool": "pen", "page": 1}
        self.assertTrue(may_write_board(self.student, self.classroom, ink))
        # …but the page structure stays with the roles
        for op in (
            {"type": "page_add", "page": 2},
            {"type": "page_go", "page": 2},
            {"type": "page_setup", "page": 1, "grid": "grid"},
            {"type": "clear", "page": 1},
        ):
            self.assertFalse(may_write_board(self.student, self.classroom, op), op)
        self.assertFalse(may_control_board(self.student, self.classroom))

    def test_student_without_grant_cannot_write_at_all(self):
        for op in ({"type": "draw", "tool": "pen", "page": 1}, {"type": "laser", "page": 1}):
            self.assertFalse(may_write_board(self.student, self.classroom, op), op)

    def test_slide_annotation_needs_the_grant_and_the_presenters_switch(self):
        from classrooms.models import SharedFile

        shared = SharedFile.objects.create(
            classroom=self.classroom, uploader=self.owner,
            original_name="deck.pdf", size=12, content_type="application/pdf",
        )
        self.classroom.current_file = shared
        self.classroom.annotation_open = True
        self.classroom.save(update_fields=["current_file", "annotation_open"])
        op = {"type": "draw", "tool": "pen", "page": 1, "file_id": shared.id}

        # no grant → nothing, even though annotation is "open" for the room
        self.assertFalse(may_write_board(self.student, self.classroom, op))

        self._grant(self.student)
        self.assertTrue(may_write_board(self.student, self.classroom, op))

        # the presenter's lock still applies to a granted student
        self.classroom.annotation_open = False
        self.classroom.save(update_fields=["annotation_open"])
        self.assertFalse(may_write_board(self.student, self.classroom, op))

        # …and an authority role is not affected by its own switch
        self.assertTrue(may_write_board(self.owner_member, self.classroom, op))

    def test_students_cannot_drive_the_deck_or_manage_the_room(self):
        client = self.client_class()
        client.force_login(self.student_user)
        room = self.classroom.room_code

        self.assertEqual(
            client.post(reverse("room:presentation", args=[room]),
                        data="{}", content_type="application/json").status_code,
            403,
        )
        for name in ("presentation_annotation", "lock", "settings", "mute_all", "end_class"):
            url = reverse(f"room:{name}", args=[room])
            response = client.post(url, data="{}", content_type="application/json")
            self.assertIn(response.status_code, (403, 400), f"{name} → {response.status_code}")


class ViewOnlyRoomTests(TestCase):
    """The room page tells the browser the truth about who controls the board."""

    def setUp(self):
        self.owner = make_user("vr_owner")
        self.student_user = make_user("vr_student")
        self.classroom = create_classroom(self.owner, title="Room")
        self.student = join_classroom(self.classroom, self.student_user)

    def _room(self, user):
        client = self.client_class()
        client.force_login(user)
        return client.get(reverse("room:room", args=[self.classroom.room_code]))

    def test_student_room_is_marked_read_only(self):
        response = self._room(self.student_user)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.context["can_control_board"])
        self.assertFalse(response.context["permissions"]["can_use_whiteboard"])
        self.assertContains(response, 'data-can-control-board="0"')

    @staticmethod
    def _banner(response) -> str:
        return re.search(r'<div class="readonly-banner"[^>]*>', response.content.decode()).group(0)

    def test_ungranted_student_sees_a_read_only_notice(self):
        response = self._room(self.student_user)
        self.assertTrue(response.context["read_only"])
        self.assertContains(response, "فقط‌خواندنی")
        # Visible (the element never carries `hidden` when the server says
        # read-only) — room.js keeps it in sync while the lesson runs.
        self.assertNotIn("hidden", self._banner(response))

    def test_notice_is_hidden_once_a_grant_exists(self):
        set_member_permission(self.classroom, self.owner, self.student.id, "can_send_messages", True)
        response = self._room(self.student_user)
        self.assertFalse(response.context["read_only"])
        self.assertIn("hidden", self._banner(response))

    def test_owner_room_is_never_read_only(self):
        response = self._room(self.owner)
        self.assertFalse(response.context["read_only"])

    def test_owner_room_may_control_the_board(self):
        response = self._room(self.owner)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.context["can_control_board"])
        self.assertContains(response, 'data-can-control-board="1"')

    # -- the «سوالات» tab and the chat channel switch are host tools ---------
    def test_owner_sees_the_question_composer(self):
        response = self._room(self.owner)
        self.assertContains(response, 'id="quiz-compose"')
        self.assertContains(response, 'id="quiz-ask"')
        self.assertContains(response, 'id="quiz-option-inputs"')

    def test_student_gets_no_question_composer(self):
        response = self._room(self.student_user)
        self.assertNotContains(response, 'id="quiz-compose"')
        self.assertNotContains(response, 'id="quiz-ask"')
        # ... but the tab itself stays: a student still answers live questions.
        self.assertContains(response, "سوالات")

    def test_only_hosts_get_the_private_chat_switch(self):
        owner_page = self._room(self.owner)
        self.assertContains(owner_page, 'data-channel="private"')
        student_page = self._room(self.student_user)
        self.assertNotContains(student_page, 'data-channel="private"')
        # the composer is shared by everybody
        self.assertContains(student_page, 'id="chat-form"')


class BoardOpenWebSocketTests(TransactionTestCase):
    """Opening the board switches the view for the whole class."""

    def setUp(self):
        from django.core.cache import cache

        cache.clear()
        self.owner = make_user("bo_owner")
        self.presenter_user = make_user("bo_presenter")
        self.student_user = make_user("bo_student")
        self.classroom = create_classroom(self.owner, title="Board")
        self.student = join_classroom(self.classroom, self.student_user)
        self.presenter = join_classroom(self.classroom, self.presenter_user)
        set_member_role(self.classroom, self.owner, self.presenter.id, Role.PRESENTER)

    def _ws(self, user):
        return WebsocketCommunicator(
            app_with_user(user, classroom_routes),
            f"/ws/classroom/{self.classroom.room_code}/",
        )

    def _open_attempt(self, user):
        async def scenario():
            ws = self._ws(user)
            connected, _ = await ws.connect()
            assert connected
            first = await ws.receive_json_from()   # participant_list snapshot
            await ws.send_json_to({"action": "whiteboard_state", "open": True})
            # Skip unrelated chatter (user_joined, …) until the answer.
            for _ in range(10):
                reply = await ws.receive_json_from(timeout=3)
                if reply.get("type") in {"error", "whiteboard_state"}:
                    break
            await ws.disconnect()
            return first, reply

        return async_to_sync(scenario)()

    def test_granted_student_still_cannot_open_the_board_for_the_room(self):
        set_member_permission(self.classroom, self.owner, self.student.id, "can_use_whiteboard", True)
        _, reply = self._open_attempt(self.student_user)
        self.assertEqual(reply["type"], "error", reply)
        self.classroom.refresh_from_db()
        self.assertFalse(self.classroom.whiteboard_open)

    def test_presenter_can_open_the_board(self):
        _, reply = self._open_attempt(self.presenter_user)
        self.assertEqual(reply["type"], "whiteboard_state", reply)
        self.assertTrue(reply["open"])
        self.classroom.refresh_from_db()
        self.assertTrue(self.classroom.whiteboard_open)

    def test_read_only_student_still_gets_the_room_and_the_roster(self):
        """Viewing is not a privilege: a student always connects and is listed."""
        first, reply = self._open_attempt(self.student_user)
        self.assertEqual(first["type"], "participant_list")
        self.assertTrue(any(p["identity"] == f"u:{self.student_user.id}" for p in first["participants"]))
        self.assertEqual(reply["type"], "error", reply)


class ParticipationGrantTests(TransactionTestCase):
    """Talking, typing and reacting are grants too — never defaults.

    The board is the loudest example of a shared surface, but a view-only
    member is view-only everywhere: chat, raised hands, emoji reactions and
    live captions all need the owner's per-member permission, and the server
    drops the frame when it is missing.
    """

    def setUp(self):
        from django.core.cache import cache

        cache.clear()
        self.owner = make_user("pg_owner")
        self.student_user = make_user("pg_student")
        self.classroom = create_classroom(self.owner, title="Participation")
        self.student = join_classroom(self.classroom, self.student_user)

    # -- chat ------------------------------------------------------------------
    def _chat_ws(self, user):
        from chat.routing import websocket_urlpatterns as chat_routes

        return WebsocketCommunicator(
            app_with_user(user, chat_routes),
            f"/ws/classroom/{self.classroom.room_code}/chat/",
        )

    def _send_message(self, message: str):
        async def scenario():
            ws = self._chat_ws(self.student_user)
            connected, _ = await ws.connect()
            assert connected
            await ws.receive_json_from(timeout=3)  # chat_history
            await ws.send_json_to({"action": "send_message", "message": message})
            for _ in range(10):
                reply = await ws.receive_json_from(timeout=3)
                if reply.get("type") in {"error", "chat_message"}:
                    break
            await ws.disconnect()
            return reply

        return async_to_sync(scenario)()

    def test_read_only_student_cannot_post_to_chat(self):
        from chat.models import ChatMessage

        reply = self._send_message("سلام")
        self.assertEqual(reply["type"], "error", reply)
        self.assertEqual(ChatMessage.objects.filter(classroom=self.classroom).count(), 0)

    def test_chat_grant_lets_the_student_post(self):
        from chat.models import ChatMessage

        set_member_permission(self.classroom, self.owner, self.student.id, "can_send_messages", True)
        reply = self._send_message("سلام")
        self.assertEqual(reply["type"], "chat_message", reply)
        self.assertEqual(ChatMessage.objects.filter(classroom=self.classroom).count(), 1)

    # -- presence: hands, reactions, captions -----------------------------------
    def _presence_ws(self, user):
        return WebsocketCommunicator(
            app_with_user(user, classroom_routes),
            f"/ws/classroom/{self.classroom.room_code}/",
        )

    def _presence_reply(self, action: dict, expect=("error",)):
        async def scenario():
            ws = self._presence_ws(self.student_user)
            connected, _ = await ws.connect()
            assert connected
            await ws.receive_json_from(timeout=3)  # participant_list
            await ws.send_json_to(action)
            reply = None
            for _ in range(10):
                candidate = await ws.receive_json_from(timeout=3)
                if candidate.get("type") in expect:
                    reply = candidate
                    break
            await ws.disconnect()
            return reply

        return async_to_sync(scenario)()

    def test_read_only_student_cannot_raise_a_hand(self):
        reply = self._presence_reply({"action": "raise_hand", "raised": True})
        self.assertIsNotNone(reply, "the server must answer a refused raise_hand")
        self.assertEqual(reply["type"], "error", reply)
        self.student.refresh_from_db()
        self.assertIsNone(self.student.hand_raised_at)

    def test_read_only_student_cannot_send_a_reaction(self):
        reply = self._presence_reply({"action": "reaction", "reaction": "heart"})
        self.assertIsNotNone(reply, "the server must answer a refused reaction")
        self.assertEqual(reply["type"], "error", reply)

    def test_caption_needs_the_microphone_grant(self):
        """Captions relay the speaker's own words, so they follow the mic grant."""

        async def scenario():
            owner_ws = self._presence_ws(self.owner)
            await owner_ws.connect()
            await owner_ws.receive_json_from(timeout=3)   # snapshot
            await owner_ws.receive_json_from(timeout=3)   # own join

            student_ws = self._presence_ws(self.student_user)
            await student_ws.connect()
            await owner_ws.receive_json_from(timeout=3)   # student joined

            await student_ws.send_json_to({"action": "caption", "text": "متن", "final": True})
            quiet = await owner_ws.receive_nothing(timeout=0.4)
            assert quiet, "an ungranted member must not relay captions"

            await student_ws.disconnect()
            await owner_ws.disconnect()

        async_to_sync(scenario)()

    def test_hand_and_reaction_grants_are_independent_of_the_board(self):
        set_member_permission(self.classroom, self.owner, self.student.id, "can_raise_hand", True)
        self.student.refresh_from_db()
        perms = effective_permissions(self.student, self.classroom)
        self.assertTrue(perms["can_raise_hand"])
        self.assertFalse(perms["can_use_whiteboard"])
        self.assertFalse(perms["can_send_messages"])
