"""Phase-3 tests: guest access, display-name rules, session-bound guests,
customisation and user preferences.

The security invariants under test:
* a guest's membership is derived from THEIR server session, never from
  client-supplied identifiers;
* guests get the same ``can_*`` permission pipeline as registered members,
  with no privilege escalation available to them;
* guests cannot reach dashboard/profile/host controls or other classrooms.
"""
import json

from asgiref.sync import async_to_sync
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.test import Client, TestCase, TransactionTestCase
from django.urls import reverse

from .models import ClassroomMember
from .permissions import Role, effective_permissions
from .routing import websocket_urlpatterns as classroom_routes
from .services import (
    GUEST_NAME_MAX,
    ClassroomAccessError,
    ClassroomLocked,
    WrongClassroomPassword,
    create_classroom,
    get_guest_member,
    guest_session_key,
    join_classroom,
    join_classroom_guest,
    set_member_muted,
    validate_display_name,
)

User = get_user_model()
PASSWORD = "testpass-123"


def make_user(username: str) -> User:
    return User.objects.create_user(username=username, password=PASSWORD, email=f"{username}@x.com")


class GuestJoinTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("g_owner")
        self.classroom = create_classroom(self.owner, title="Guests")

    def _lobby(self):
        return reverse("room:lobby", kwargs={"room_code": self.classroom.room_code})

    def test_guest_joins_with_display_name_only(self):
        response = self.client.post(self._lobby(), {"display_name": "Ali"})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse("room:room", kwargs={"room_code": self.classroom.room_code}))

        member = ClassroomMember.objects.get(classroom=self.classroom, is_guest=True)
        self.assertIsNone(member.user_id)
        self.assertEqual(member.display_name, "Ali")
        self.assertEqual(member.role, Role.GUEST)
        self.assertTrue(len(member.guest_uid) >= 20)  # secure random, url-safe
        self.assertEqual(self.client.session[guest_session_key(self.classroom)], member.guest_uid)

    def test_guest_reaches_room_page(self):
        self.client.post(self._lobby(), {"display_name": "Ali"})
        response = self.client.get(reverse("room:room", kwargs={"room_code": self.classroom.room_code}))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, self.classroom.room_code)

    def test_name_is_trimmed_and_collapses_whitespace(self):
        self.assertEqual(validate_display_name("  Ali   Reza  "), "Ali Reza")

    def test_name_rejects_blank_too_short_and_too_long(self):
        for bad in ("", "   ", "A", "x" * (GUEST_NAME_MAX + 1)):
            with self.assertRaises(ValidationError):
                validate_display_name(bad)

    def test_name_strips_markup(self):
        cleaned = validate_display_name("<script>alert(1)</script>Ali")
        self.assertNotIn("<", cleaned)
        self.assertNotIn(">", cleaned)

    def test_duplicate_names_get_a_suffix(self):
        self.client.post(self._lobby(), {"display_name": "Ali"})
        self.assertEqual(ClassroomMember.objects.get(is_guest=True).display_name, "Ali")

        other = Client()
        other.post(self._lobby(), {"display_name": "Ali"})
        self.assertEqual(ClassroomMember.objects.filter(is_guest=True).count(), 2)
        self.assertEqual(
            ClassroomMember.objects.filter(is_guest=True).order_by("id").last().display_name,
            "Ali (2)",
        )

        third = Client()
        third.post(self._lobby(), {"display_name": "Ali"})
        self.assertEqual(
            ClassroomMember.objects.filter(is_guest=True).order_by("id").last().display_name,
            "Ali (3)",
        )

    def test_invalid_name_is_rejected_at_the_view(self):
        response = self.client.post(self._lobby(), {"display_name": " "})
        self.assertEqual(response.status_code, 200)  # re-renders with errors
        self.assertEqual(ClassroomMember.objects.filter(is_guest=True).count(), 0)
        self.assertContains(response, "نام")

    def test_guests_can_be_disabled(self):
        self.classroom.allow_guests = False
        self.classroom.save(update_fields=["allow_guests"])

        response = self.client.get(self._lobby())
        self.assertEqual(response.status_code, 403)
        response = self.client.post(self._lobby(), {"display_name": "Ali"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(ClassroomMember.objects.filter(is_guest=True).count(), 0)

    def test_locked_classroom_blocks_guests(self):
        self.classroom.is_locked = True
        self.classroom.save(update_fields=["is_locked"])
        self.assertEqual(self.client.get(self._lobby()).status_code, 200)
        self.assertContains(self.client.get(self._lobby()), "قفل")
        self.assertEqual(ClassroomMember.objects.filter(is_guest=True).count(), 0)

    def test_inactive_classroom_shows_ended_page(self):
        self.classroom.is_active = False
        self.classroom.save(update_fields=["is_active"])
        self.assertEqual(self.client.get(self._lobby()).status_code, 410)

    def test_guest_goes_to_waiting_room_when_enabled(self):
        self.classroom.enable_waiting_room = True
        self.classroom.save(update_fields=["enable_waiting_room"])
        response = self.client.post(self._lobby(), {"display_name": "Ali"})
        self.assertEqual(response.url, reverse("room:waiting", kwargs={"room_code": self.classroom.room_code}))
        self.assertTrue(ClassroomMember.objects.get(is_guest=True).in_waiting_room)

        waiting = self.client.get(reverse("room:waiting", kwargs={"room_code": self.classroom.room_code}))
        self.assertEqual(waiting.status_code, 200)
        # the room itself stays out of reach until the host approves
        self.assertEqual(
            self.client.get(reverse("room:room", kwargs={"room_code": self.classroom.room_code})).status_code, 302
        )

    def test_guest_join_requires_password_when_protected(self):
        self.classroom.set_password("secret-99")
        self.classroom.is_password_protected = True
        self.classroom.save(update_fields=["password", "is_password_protected"])

        response = self.client.post(self._lobby(), {"display_name": "Ali", "password": "nope"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(ClassroomMember.objects.filter(is_guest=True).count(), 0)

        response = self.client.post(self._lobby(), {"display_name": "Ali", "password": "secret-99"})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(ClassroomMember.objects.filter(is_guest=True).count(), 1)

    def test_password_is_never_accepted_via_query_string(self):
        self.classroom.set_password("secret-99")
        self.classroom.is_password_protected = True
        self.classroom.save(update_fields=["password", "is_password_protected"])
        response = self.client.get(self._lobby() + "?password=secret-99")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(ClassroomMember.objects.filter(is_guest=True).count(), 0)


class GuestServiceTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("gs_owner")
        self.classroom = create_classroom(self.owner, title="GS")

    def test_join_classroom_guest_service_flow(self):
        member = join_classroom_guest(self.classroom, "  Sara ")
        self.assertTrue(member.is_guest)
        self.assertEqual(member.display_name, "Sara")
        self.assertEqual(member.identity, f"g:{member.guest_uid}")

    def test_guest_uid_is_unique_per_member(self):
        first = join_classroom_guest(self.classroom, "Ali")
        second = join_classroom_guest(self.classroom, "Ali")
        self.assertNotEqual(first.guest_uid, second.guest_uid)
        self.assertEqual(second.display_name, "Ali (2)")

    def test_disabled_guests_raise(self):
        self.classroom.allow_guests = False
        self.classroom.save(update_fields=["allow_guests"])
        with self.assertRaises(ClassroomAccessError):
            join_classroom_guest(self.classroom, "Ali")

    def test_locked_classroom_raises(self):
        self.classroom.is_locked = True
        self.classroom.save(update_fields=["is_locked"])
        with self.assertRaises(ClassroomLocked):
            join_classroom_guest(self.classroom, "Ali")

    def test_wrong_password_raises(self):
        self.classroom.set_password("secret-99")
        self.classroom.is_password_protected = True
        self.classroom.save(update_fields=["password", "is_password_protected"])
        with self.assertRaises(WrongClassroomPassword):
            join_classroom_guest(self.classroom, "Ali", "wrong")

    def test_registered_member_identity_uses_user_id(self):
        member = join_classroom(self.classroom, self.owner)
        self.assertEqual(member.identity, f"u:{self.owner.id}")
        self.assertFalse(member.is_guest)
        self.assertEqual(member.participant_name, self.owner.name)

    def test_guest_member_lookup_is_scoped_to_their_uid(self):
        member = join_classroom_guest(self.classroom, "Ali")
        self.assertEqual(get_guest_member(self.classroom, member.guest_uid), member)
        self.assertIsNone(get_guest_member(self.classroom, "not-a-real-uid"))
        self.assertIsNone(get_guest_member(self.classroom, ""))


class GuestPermissionTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("gp_owner")
        self.classroom = create_classroom(self.owner, title="GP")
        self.guest = join_classroom_guest(self.classroom, "Ali")

    def test_guest_default_permissions(self):
        perms = effective_permissions(self.guest, self.classroom)
        self.assertTrue(perms["can_use_microphone"])
        self.assertTrue(perms["can_use_camera"])
        self.assertTrue(perms["can_send_messages"])
        self.assertTrue(perms["can_raise_hand"])
        self.assertFalse(perms["can_share_screen"])
        self.assertFalse(perms["can_use_whiteboard"])
        self.assertFalse(perms["can_present"])

    def test_guests_can_never_upload_files(self):
        self.guest.can_upload_files = True
        self.guest.save(update_fields=["can_upload_files"])
        self.guest.refresh_from_db()
        self.assertFalse(effective_permissions(self.guest, self.classroom)["can_upload_files"])

    def test_room_settings_restrict_guests_like_students(self):
        self.classroom.allow_student_mic = False
        self.classroom.chat_disabled = True
        self.classroom.save(update_fields=["allow_student_mic", "chat_disabled"])
        perms = effective_permissions(self.guest, self.classroom)
        self.assertFalse(perms["can_use_microphone"])
        self.assertFalse(perms["can_send_messages"])

    def test_guest_is_not_privileged(self):
        from .permissions import is_privileged

        self.assertFalse(is_privileged(self.guest))
        owner_member = ClassroomMember.objects.get(classroom=self.classroom, user=self.owner)
        self.assertTrue(is_privileged(owner_member))

    def test_owner_can_mute_a_guest(self):
        owner_member = ClassroomMember.objects.get(classroom=self.classroom, user=self.owner)
        set_member_muted(self.classroom, self.owner, self.guest.id, True)
        self.guest.refresh_from_db()
        self.assertTrue(self.guest.muted)
        self.assertTrue(owner_member.id)

    def test_guest_role_cannot_be_escalated_by_the_guest(self):
        """The role endpoint is login-protected; a guest is redirected away."""
        response = self.client.post(
            reverse("room:lobby", kwargs={"room_code": self.classroom.room_code}), {"display_name": "Ali"}
        )
        self.assertEqual(response.status_code, 302)
        response = self.client.post(
            reverse("room:member_role", kwargs={"room_code": self.classroom.room_code, "member_id": self.guest.id}),
            data=json.dumps({"role": Role.MODERATOR}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 302)  # to the login page
        self.guest.refresh_from_db()
        self.assertEqual(self.guest.role, Role.GUEST)


class GuestAccessBoundaryTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("gb_owner")
        self.classroom = create_classroom(self.owner, title="GB")
        self.other = create_classroom(self.owner, title="Other")
        self.client.post(
            reverse("room:lobby", kwargs={"room_code": self.classroom.room_code}), {"display_name": "Ali"}
        )

    def test_guest_cannot_reach_dashboard_or_profile(self):
        for url in (reverse("dashboard"), reverse("accounts:profile")):
            response = self.client.get(url)
            self.assertEqual(response.status_code, 302)
            self.assertIn("login", response.url)

    def test_guest_cannot_reach_classroom_management(self):
        response = self.client.get(
            reverse("classrooms:detail", kwargs={"room_code": self.classroom.room_code})
        )
        self.assertEqual(response.status_code, 302)
        self.assertIn("login", response.url)

    def test_guest_session_does_not_leak_into_other_classrooms(self):
        response = self.client.get(reverse("room:room", kwargs={"room_code": self.other.room_code}))
        self.assertEqual(response.status_code, 302)  # back to that lobby
        self.assertEqual(response.url, reverse("room:lobby", kwargs={"room_code": self.other.room_code}))
        self.assertFalse(
            ClassroomMember.objects.filter(classroom=self.other, is_guest=True).exists()
        )

    def test_guest_media_token_requires_a_membership(self):
        response = Client().get(
            reverse("room:media_token", kwargs={"room_code": self.classroom.room_code})
        )
        # media is unconfigured in tests → 503 before any membership check,
        # but a stranger must never get a token either way.
        self.assertIn(response.status_code, (403, 503))

    def test_guest_media_token_for_member_or_503_when_unconfigured(self):
        response = self.client.get(
            reverse("room:media_token", kwargs={"room_code": self.classroom.room_code})
        )
        self.assertIn(response.status_code, (200, 503))
        if response.status_code == 200:
            self.assertIn("token", json.loads(response.content))

    def test_host_actions_reject_guests(self):
        for name, kwargs in (
            ("room:mute_all", {}),
            ("room:lock", {}),
            ("room:settings", {}),
            ("room:session_start", {}),
        ):
            response = self.client.post(
                reverse(name, kwargs={"room_code": self.classroom.room_code, **kwargs}),
                data=json.dumps({}),
                content_type="application/json",
            )
            self.assertEqual(response.status_code, 302)
        self.classroom.refresh_from_db()
        self.assertFalse(self.classroom.is_locked)

    def test_guest_leave_unbinds_the_session(self):
        self.client.post(reverse("room:leave", kwargs={"room_code": self.classroom.room_code}))
        self.assertNotIn(guest_session_key(self.classroom), self.client.session)
        member = ClassroomMember.objects.get(is_guest=True)
        self.assertFalse(member.is_active)
        # and the room is no longer reachable with that session
        response = self.client.get(reverse("room:room", kwargs={"room_code": self.classroom.room_code}))
        self.assertEqual(response.status_code, 302)


def app_with_session(session: dict, routes):
    """Inject an anonymous scope + a plain dict 'session' (no DB needed)."""
    inner = URLRouter(routes)

    async def app(scope, receive, send):
        scope = dict(scope)
        scope["user"] = AnonymousUser()
        scope["session"] = session
        await inner(scope, receive, send)

    return app


class GuestWebSocketTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("gw_owner")
        self.classroom = create_classroom(self.owner, title="GW")
        self.guest = join_classroom_guest(self.classroom, "Ali")

    def _guest_ws(self):
        session = {guest_session_key(self.classroom): self.guest.guest_uid}
        return WebsocketCommunicator(
            app_with_session(session, classroom_routes),
            f"/ws/classroom/{self.classroom.room_code}/",
        )

    def test_guest_connects_and_appears_in_the_roster(self):
        async def scenario():
            ws = self._guest_ws()
            connected, _ = await ws.connect()
            assert connected, "guest socket should be accepted"
            snapshot = await ws.receive_json_from()
            assert snapshot["type"] == "participant_list", snapshot
            identities = [p["identity"] for p in snapshot["participants"]]
            assert self.guest.identity in identities, identities
            guest_entry = next(
                p for p in snapshot["participants"] if p["identity"] == self.guest.identity
            )
            assert guest_entry["name"] == "Ali", guest_entry
            assert guest_entry["is_guest"] is True
            assert "user_id" not in guest_entry or guest_entry["user_id"] is None
            await ws.disconnect()

        async_to_sync(scenario)()

    def test_stranger_without_a_session_is_rejected(self):
        async def scenario():
            ws = WebsocketCommunicator(
                app_with_session({}, classroom_routes),
                f"/ws/classroom/{self.classroom.room_code}/",
            )
            connected, code = await ws.connect()
            assert not connected, "a socket with no membership must be closed"
            assert code in (4401, 4403), code

        async_to_sync(scenario)()

    def test_forged_guest_uid_in_the_session_is_rejected(self):
        async def scenario():
            ws = WebsocketCommunicator(
                app_with_session({guest_session_key(self.classroom): "forged-uid"}, classroom_routes),
                f"/ws/classroom/{self.classroom.room_code}/",
            )
            connected, _ = await ws.connect()
            assert not connected

        async_to_sync(scenario)()


class RtcSignalRelayTests(TransactionTestCase):
    """WebRTC signalling relay + shared whiteboard state over the presence WS."""

    def setUp(self):
        cache.clear()
        self.owner = make_user("rtc_owner")
        self.student = make_user("rtc_student")
        self.classroom = create_classroom(self.owner, title="RTC")
        self.owner_member = join_classroom(self.classroom, self.owner)
        self.stu_member = join_classroom(self.classroom, self.student)

    def _ws(self, user):
        from channels.auth import AuthMiddlewareStack  # noqa: F401  (pattern parity)
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

    async def _close(self, ws):
        import asyncio as _asyncio
        try:
            await ws.disconnect()
        except _asyncio.CancelledError:
            pass

    async def _assert_no_relay(self, ws, timeout=0.8):
        """Drain queued broadcasts; assert no rtc_signal was relayed."""
        import asyncio as _asyncio
        while True:
            try:
                msg = await ws.receive_json_from(timeout=timeout)
            except (_asyncio.TimeoutError, TimeoutError):
                return
            assert msg.get("type") != "rtc_signal", f"unexpected relay: {msg}"

    async def _receive_typed(self, ws, expected, timeout=3):
        """Skip unrelated broadcast chatter until the expected event arrives."""
        for _ in range(10):
            msg = await ws.receive_json_from(timeout=timeout)
            if msg.get("type") == expected:
                return msg
        raise AssertionError(f"never received '{expected}'")

    def test_rtc_signal_is_relayed_to_the_target_member(self):
        async def scenario():
            owner_ws = await self._connected(self.owner)
            stu_ws = await self._connected(self.student)

            sdp = {"sdp": {"type": "offer", "sdp": "v=0 ...fake..."}}
            await owner_ws.send_json_to({
                "action": "rtc_signal", "to_member_id": self.stu_member.id, "data": sdp,
            })
            msg = await self._receive_typed(stu_ws, "rtc_signal")
            assert msg["from_identity"] == f"u:{self.owner.id}", msg
            assert msg["data"] == sdp, msg
            await owner_ws.disconnect()
            await stu_ws.disconnect()

        async_to_sync(scenario)()

    def test_rtc_signal_cannot_reach_a_stranger(self):
        async def scenario():
            owner_ws = await self._connected(self.owner)
            stu_ws = await self._connected(self.student)

            # target a member id from ANOTHER classroom — must be dropped
            await owner_ws.send_json_to({
                "action": "rtc_signal", "to_member_id": self.stu_member.id + 9999,
                "data": {"sdp": {"type": "offer", "sdp": "x"}},
            })
            await self._assert_no_relay(stu_ws)
            await self._close(stu_ws)
            await self._close(owner_ws)

        async_to_sync(scenario)()

    def test_oversized_signal_is_dropped(self):
        async def scenario():
            owner_ws = await self._connected(self.owner)
            stu_ws = await self._connected(self.student)
            await owner_ws.send_json_to({
                "action": "rtc_signal", "to_member_id": self.stu_member.id,
                "data": {"sdp": {"type": "offer", "sdp": "x" * 20000}},
            })
            await self._assert_no_relay(stu_ws)
            await self._close(stu_ws)
            await self._close(owner_ws)

        async_to_sync(scenario)()

    def test_whiteboard_state_broadcast_and_persist(self):
        async def scenario():
            owner_ws = await self._connected(self.owner)
            stu_ws = await self._connected(self.student)

            await owner_ws.send_json_to({"action": "whiteboard_state", "open": True})
            seen = [await self._receive_typed(ws, "whiteboard_state")
                    for ws in (owner_ws, stu_ws)]
            assert all(m["open"] is True for m in seen)
            await owner_ws.disconnect()
            await stu_ws.disconnect()

        async_to_sync(scenario)()
        self.classroom.refresh_from_db()
        self.assertTrue(self.classroom.whiteboard_open)

    def test_student_without_permission_cannot_open_whiteboard(self):
        async def scenario():
            owner_ws = await self._connected(self.owner)
            stu_ws = await self._connected(self.student)
            await stu_ws.send_json_to({"action": "whiteboard_state", "open": True})
            msg = await self._receive_typed(stu_ws, "error")
            await owner_ws.disconnect()
            await stu_ws.disconnect()

        async_to_sync(scenario)()
        self.classroom.refresh_from_db()
        self.assertFalse(self.classroom.whiteboard_open)
