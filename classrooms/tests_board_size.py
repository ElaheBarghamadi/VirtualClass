"""The whiteboard's size: chosen by the presenter, obeyed by every device.

Two rules drive these tests, and both are easy to break later:

* the board is ONE shared page — its dimensions cannot depend on the screen the
  presenter is using, so the numbers are validated server-side (a closed
  allow-list), stored on the classroom and broadcast to the room;
* changing the format must never destroy or stretch ink that is already on the
  board, which is why every op carries the surface it was written against.
"""
from __future__ import annotations

from asgiref.sync import async_to_sync
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, TransactionTestCase

from .board import BOARD_PRESETS, default_size, preset_key, size_for
from .models import Classroom
from .routing import websocket_urlpatterns as classroom_routes
from .services import create_classroom, join_classroom, set_member_permission

User = get_user_model()
PASSWORD = "Pass-12345"


def make_user(username: str):
    return User.objects.create_user(username=username, password=PASSWORD, email=f"{username}@x.com")


class BoardPresetTests(TestCase):
    """The allow-list itself — the only sizes that can ever reach the wire."""

    def test_the_default_is_the_historical_page(self):
        self.assertEqual(default_size(), (1200, 700))
        self.assertEqual(BOARD_PRESETS["12:7"], (1200, 700))

    def test_a_new_classroom_starts_on_the_default(self):
        owner = make_user("board_defaults")
        classroom = create_classroom(owner, title="Board")
        self.assertEqual((classroom.whiteboard_width, classroom.whiteboard_height), (1200, 700))
        self.assertEqual(preset_key(classroom.whiteboard_width, classroom.whiteboard_height), "12:7")

    def test_every_preset_is_at_least_the_default_in_both_axes(self):
        # Growing the sheet can never push existing ink off it; shrinking could.
        for key, (width, height) in BOARD_PRESETS.items():
            with self.subTest(preset=key):
                self.assertGreaterEqual(width, 1200)
                self.assertGreaterEqual(height, 700)

    def test_areas_stay_in_the_same_order_of_magnitude(self):
        # A preset that is 10× the default area would make existing ink tiny.
        base = 1200 * 700
        for key, (width, height) in BOARD_PRESETS.items():
            with self.subTest(preset=key):
                self.assertLess((width * height) / base, 2.6)

    def test_preset_lookup_is_case_insensitive_and_closed(self):
        self.assertEqual(size_for("16:9"), (1244, 700))
        self.assertEqual(size_for("A4"), (1200, 1697))
        self.assertIsNone(size_for("100:1"))
        self.assertIsNone(size_for(""))
        self.assertIsNone(size_for(None))

    def test_unknown_dimensions_are_reported_as_custom(self):
        self.assertEqual(preset_key(1200, 700), "12:7")
        self.assertEqual(preset_key(1000, 1000), "custom")


class BoardSizeWebSocketTests(TransactionTestCase):
    """The presence socket is the single source of truth for the room."""

    def setUp(self):
        cache.clear()
        self.owner = make_user("size_owner")
        self.student = make_user("size_student")
        self.classroom = create_classroom(self.owner, title="Board size")
        self.owner_member = join_classroom(self.classroom, self.owner)
        self.stu_member = join_classroom(self.classroom, self.student)

    # -- helpers ----------------------------------------------------------
    def _ws(self, user):
        inner = URLRouter(classroom_routes)

        async def app(scope, receive, send):
            scope = dict(scope)
            scope["user"] = user
            scope["session"] = {}
            await inner(scope, receive, send)

        return WebsocketCommunicator(app, f"/ws/classroom/{self.classroom.room_code}/")

    async def _connected(self, user):
        ws = self._ws(user)
        connected, _ = await ws.connect()
        assert connected
        await ws.receive_json_from()  # participant_list snapshot
        return ws

    async def _receive_typed(self, ws, expected, timeout=3):
        for _ in range(12):
            msg = await ws.receive_json_from(timeout=timeout)
            if msg.get("type") == expected:
                return msg
        raise AssertionError(f"never received {expected!r}")

    # -- tests ------------------------------------------------------------
    def test_the_owner_changes_the_size_for_the_whole_room(self):
        async def scenario():
            owner_ws = await self._connected(self.owner)
            stu_ws = await self._connected(self.student)

            await owner_ws.send_json_to({"action": "whiteboard_size", "preset": "16:9"})
            for ws in (owner_ws, stu_ws):
                msg = await self._receive_typed(ws, "whiteboard_size")
                assert (msg["width"], msg["height"]) == (1244, 700), msg
                assert msg["preset"] == "16:9", msg
            await owner_ws.disconnect()
            await stu_ws.disconnect()

        async_to_sync(scenario)()
        self.classroom.refresh_from_db()
        self.assertEqual(self.classroom.whiteboard_width, 1244)
        self.assertEqual(self.classroom.whiteboard_height, 700)

    def test_a_student_cannot_resize_the_board(self):
        async def scenario():
            owner_ws = await self._connected(self.owner)
            stu_ws = await self._connected(self.student)

            await stu_ws.send_json_to({"action": "whiteboard_size", "preset": "1:1"})
            err = await self._receive_typed(stu_ws, "error")
            assert "اندازه" in err["message"], err
            await owner_ws.disconnect()
            await stu_ws.disconnect()

        async_to_sync(scenario)()
        self.classroom.refresh_from_db()
        self.assertEqual(self.classroom.whiteboard_width, 1200)
        self.assertEqual(self.classroom.whiteboard_height, 700)

    def test_a_presenter_may_resize(self):
        from .permissions import Role

        presenter = make_user("size_presenter")
        member = join_classroom(self.classroom, presenter)
        member.role = Role.PRESENTER
        member.save(update_fields=["role"])

        async def scenario():
            ws = await self._connected(presenter)
            await ws.send_json_to({"action": "whiteboard_size", "preset": "a4"})
            msg = await self._receive_typed(ws, "whiteboard_size")
            assert (msg["width"], msg["height"]) == (1200, 1697), msg
            await ws.disconnect()

        async_to_sync(scenario)()
        self.classroom.refresh_from_db()
        self.assertEqual(self.classroom.whiteboard_height, 1697)

    def test_a_student_with_ink_permission_still_cannot_resize(self):
        # Drawing is a grant; the page itself belongs to the board's owner.
        set_member_permission(
            self.classroom, self.owner, self.stu_member.id, "can_use_whiteboard", True,
        )

        async def scenario():
            owner_ws = await self._connected(self.owner)
            stu_ws = await self._connected(self.student)
            await stu_ws.send_json_to({"action": "whiteboard_size", "preset": "4:3"})
            await self._receive_typed(stu_ws, "error")
            await owner_ws.disconnect()
            await stu_ws.disconnect()

        async_to_sync(scenario)()
        self.classroom.refresh_from_db()
        self.assertEqual(self.classroom.whiteboard_width, 1200)

    def test_an_invented_size_is_rejected_not_stored(self):
        async def scenario():
            owner_ws = await self._connected(self.owner)
            await owner_ws.send_json_to({"action": "whiteboard_size", "preset": "9000:1"})
            err = await self._receive_typed(owner_ws, "error")
            assert "نامعتبر" in err["message"], err
            await owner_ws.send_json_to({"action": "whiteboard_size", "preset": 12})
            await self._receive_typed(owner_ws, "error")
            await owner_ws.disconnect()

        async_to_sync(scenario)()
        self.classroom.refresh_from_db()
        self.assertEqual(self.classroom.whiteboard_width, 1200)
        self.assertEqual(self.classroom.whiteboard_height, 700)

    def test_a_late_joiner_is_told_the_current_size(self):
        Classroom.objects.filter(id=self.classroom.id).update(
            whiteboard_width=1200, whiteboard_height=1200,
        )

        async def scenario():
            ws = self._ws(self.student)
            connected, _ = await ws.connect()
            assert connected
            snapshot = await ws.receive_json_from(timeout=3)
            assert snapshot["type"] == "participant_list", snapshot
            state = snapshot["classroom"]
            assert state["whiteboard_width"] == 1200, state
            assert state["whiteboard_height"] == 1200, state
            await ws.disconnect()

        async_to_sync(scenario)()


class BoardSizeRoomViewTests(TestCase):
    """The control exists for the presenter, never for a student."""

    def setUp(self):
        cache.clear()
        self.owner = make_user("size_view_owner")
        self.student = make_user("size_view_student")
        self.classroom = create_classroom(self.owner, title="Board size view")
        join_classroom(self.classroom, self.owner)
        join_classroom(self.classroom, self.student)
        Classroom.objects.filter(id=self.classroom.id).update(
            whiteboard_width=1244, whiteboard_height=700,
        )

    def _get(self, user):
        self.client.force_login(user)
        return self.client.get(f"/class/{self.classroom.room_code}/room/")

    def test_the_owner_sees_the_picker_and_the_stored_size(self):
        resp = self._get(self.owner)
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        self.assertIn('id="wb-size"', html)
        self.assertIn('data-board-width="1244"', html)
        self.assertIn('data-board-height="700"', html)
        self.assertIn('value="16:9" selected', html)

    def test_a_student_gets_no_picker(self):
        resp = self._get(self.student)
        self.assertEqual(resp.status_code, 200)
        html = resp.content.decode()
        self.assertNotIn('id="wb-size"', html)
        # the page still knows the geometry — the student's client must render
        # the same board, they just may not change it
        self.assertIn('data-board-width="1244"', html)
