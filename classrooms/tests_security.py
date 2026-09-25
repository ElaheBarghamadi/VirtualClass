"""Security regression tests — every fix for an exploitable bug.

Each test reproduces the attack first (what a hostile client would do),
then asserts the server refuses it.  Covers:

* Cross-Site WebSocket Hijacking (Origin validation)
* login / registration brute-force throttling
* classroom-password guessing via rotating guest names (per-IP cap)
* waiting-room members reaching shared files before admission
* malformed JSON bodies → clean 400, never 500
* JSON type confusion (``file_id: true``, huge page numbers)
* API detail view crash for owner-who-is-also-member (500 → 200)
* REST auth throttling
"""
from __future__ import annotations

import json

from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.base import ContentFile
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APIClient

from chat.routing import websocket_urlpatterns as chat_routes
from classrooms.routing import websocket_urlpatterns as presence_routes
from classrooms.models import SharedFile
from classrooms.services import create_classroom, join_classroom
from whiteboard.models import WhiteboardEvent
from whiteboard.routing import websocket_urlpatterns as wb_routes

User = get_user_model()

PDF_HEAD = b"%PDF-1.4 minimal"


def app_with_user(user, routes):
    inner = URLRouter(routes)

    async def app(scope, receive, send):
        scope = dict(scope)
        scope["user"] = user
        await inner(scope, receive, send)

    return app


class SecurityTestBase(TransactionTestCase):
    """Shared fixtures; cache cleared so throttles never leak between tests."""

    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="sec_owner", password="Str0ng!Pass")
        self.student = User.objects.create_user(username="sec_student", password="Str0ng!Pass")
        self.classroom = create_classroom(self.owner, title="Sec")
        join_classroom(self.classroom, self.student)

    def tearDown(self):
        cache.clear()


# ---------------------------------------------------------------------------
# 1. Cross-Site WebSocket Hijacking
# ---------------------------------------------------------------------------
class WsOriginTests(SecurityTestBase):
    """A foreign website must not ride the victim's cookies over WS."""

    def _connect(self, routes, path, origin: bytes | None):
        # NOTE: passing headers replaces the communicator defaults, so the
        # host header (what the origin is checked against) must be explicit.
        headers = [(b"host", b"testserver")]
        if origin is not None:
            headers.append((b"origin", origin))
        return WebsocketCommunicator(app_with_user(self.owner, routes), path, headers=headers)

    async def _expect(self, routes, path, origin, allowed: bool):
        ws = self._connect(routes, path, origin)
        connected, code = await ws.connect()
        if allowed:
            assert connected, f"same-origin handshake rejected ({code}) for {path}"
            await ws.disconnect()
        else:
            assert not connected and code == 4403, f"foreign origin accepted for {path}: {connected} {code}"

    def test_foreign_origin_rejected_on_all_sockets(self):
        async def scenario():
            await self._expect(wb_routes, f"/ws/classroom/{self.classroom.room_code}/whiteboard/", b"http://evil.example", False)
            await self._expect(chat_routes, f"/ws/classroom/{self.classroom.room_code}/chat/", b"http://evil.example", False)
            await self._expect(presence_routes, f"/ws/classroom/{self.classroom.room_code}/", b"https://attacker.test", False)
            # same origin + no origin (native clients) still work
            await self._expect(wb_routes, f"/ws/classroom/{self.classroom.room_code}/whiteboard/", b"http://testserver", True)
            await self._expect(wb_routes, f"/ws/classroom/{self.classroom.room_code}/whiteboard/", None, True)

        import asyncio
        asyncio.get_event_loop().run_until_complete(scenario())

    def test_origin_matching_host_allowed(self):
        import asyncio

        async def scenario():
            ws = WebsocketCommunicator(
                app_with_user(self.owner, wb_routes),
                f"/ws/classroom/{self.classroom.room_code}/whiteboard/",
                headers=[(b"origin", b"http://testserver"), (b"host", b"testserver")],
            )
            connected, _ = await ws.connect()
            assert connected
            history = await ws.receive_json_from()
            assert history["type"] == "whiteboard_history"
            await ws.disconnect()

        asyncio.get_event_loop().run_until_complete(scenario())


# ---------------------------------------------------------------------------
# 2. Login brute force
# ---------------------------------------------------------------------------
class LoginRateLimitTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="victim", password="Sup3r!Secret")

    def tearDown(self):
        cache.clear()

    def test_repeated_failures_lock_the_ip_user_pair(self):
        # 8 wrong attempts are tolerated; after that even the CORRECT
        # password is refused until the window expires.
        for _ in range(9):
            resp = self.client.post("/accounts/login/", {"username": "victim", "password": "wrong"})
            self.assertEqual(resp.status_code, 200)  # stays on the form
        resp = self.client.post("/accounts/login/", {"username": "victim", "password": "Sup3r!Secret"})
        self.assertEqual(resp.status_code, 200)  # blocked, NOT logged in
        self.assertContains(resp, "بیش از حد مجاز")
        self.assertFalse("_auth_user_id" in self.client.session)

    def test_successful_login_resets_counter(self):
        for _ in range(4):
            self.client.post("/accounts/login/", {"username": "victim", "password": "wrong"})
        resp = self.client.post("/accounts/login/", {"username": "victim", "password": "Sup3r!Secret"})
        self.assertEqual(resp.status_code, 302)  # logged in
        # counter cleared: failures may start again without instant lock
        for _ in range(4):
            self.client.post("/accounts/login/", {"username": "victim", "password": "wrong"})
        resp = self.client.post("/accounts/login/", {"username": "victim", "password": "Sup3r!Secret"})
        self.assertEqual(resp.status_code, 302)


# ---------------------------------------------------------------------------
# 3. Registration flooding
# ---------------------------------------------------------------------------
class RegisterRateLimitTests(TestCase):
    def setUp(self):
        cache.clear()

    def tearDown(self):
        cache.clear()

    def test_registration_capped_per_ip(self):
        for i in range(12):
            self.client.post("/accounts/register/", {
                "username": f"flood{i}", "first_name": "F", "last_name": "L",
                "password1": "Zx9!mnQ2vL", "password2": "Zx9!mnQ2vL",
            })
        before = User.objects.count()
        resp = self.client.post("/accounts/register/", {
            "username": "flood_final", "first_name": "F", "last_name": "L",
            "password1": "Zx9!mnQ2vL", "password2": "Zx9!mnQ2vL",
        })
        self.assertContains(resp, "محدود شده")
        self.assertEqual(User.objects.count(), before)


# ---------------------------------------------------------------------------
# 4. Classroom password guessing with rotating guest names
# ---------------------------------------------------------------------------
class ClassroomPasswordIpLimitTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="pw_owner", password="x")
        self.classroom = create_classroom(self.owner, title="PW", password="S3cret!Room", is_password_protected=True)

    def tearDown(self):
        cache.clear()

    def _guest_join(self, name, password):
        return self.client.post(
            f"/class/{self.classroom.room_code}/lobby/",
            {"display_name": name, "password": password},
        )

    def test_rotating_names_cannot_brute_force(self):
        # Per-name limit is 5, but the per-IP cap (15) stops name rotation.
        for i in range(16):
            resp = self._guest_join(f"Guest{i}", "wrong-pass")
            self.assertEqual(resp.status_code, 200)
        resp = self._guest_join("GuestFinal", "S3cret!Room")
        # blocked by the IP cap even though the password is right
        self.assertContains(resp, "بیش از حد مجاز")
        self.assertFalse(self.client.session.get(f"guest_member_{self.classroom.room_code}"))

    def test_correct_password_within_limit_works(self):
        resp = self._guest_join("GoodGuest", "S3cret!Room")
        self.assertEqual(resp.status_code, 302)  # admitted


# ---------------------------------------------------------------------------
# 5. Waiting-room members must not reach shared files
# ---------------------------------------------------------------------------
class WaitingRoomFileAccessTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="wr_owner", password="x")
        self.classroom = create_classroom(self.owner, title="WR")
        self.classroom.enable_waiting_room = True
        self.classroom.save(update_fields=["enable_waiting_room"])
        self.student = User.objects.create_user(username="wr_student", password="x")
        join_classroom(self.classroom, self.student)  # lands in waiting room
        self.file = SharedFile.objects.create(
            classroom=self.classroom,
            uploader=self.owner,
            file=ContentFile(PDF_HEAD, name="deck.pdf"),
            original_name="deck.pdf",
            size=len(PDF_HEAD),
            content_type="application/pdf",
        )

    def tearDown(self):
        cache.clear()

    def test_waiting_member_download_404(self):
        self.client.force_login(self.student)
        resp = self.client.get(f"/class/{self.classroom.room_code}/files/{self.file.id}/download/")
        self.assertEqual(resp.status_code, 404)

    def test_admitted_member_download_ok(self):
        from classrooms.models import ClassroomMember

        ClassroomMember.objects.filter(classroom=self.classroom, user=self.student).update(in_waiting_room=False)
        self.client.force_login(self.student)
        resp = self.client.get(f"/class/{self.classroom.room_code}/files/{self.file.id}/download/")
        self.assertEqual(resp.status_code, 200)

    def test_waiting_member_api_403(self):
        client = APIClient()
        client.force_authenticate(self.student)
        resp = client.get(f"/api/classrooms/{self.classroom.room_code}/files/")
        self.assertEqual(resp.status_code, 403)


# ---------------------------------------------------------------------------
# 6. Malformed JSON bodies → 400, never 500
# ---------------------------------------------------------------------------
class MalformedJsonTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="json_owner", password="x")
        self.classroom = create_classroom(self.owner, title="JSON")
        self.client.force_login(self.owner)

    def tearDown(self):
        cache.clear()

    def test_garbage_body_is_400_not_500(self):
        endpoints = [
            f"/class/{self.classroom.room_code}/lock/",
            f"/class/{self.classroom.room_code}/presentation/",
            f"/class/{self.classroom.room_code}/settings/",
            f"/class/{self.classroom.room_code}/sessions/start/",
        ]
        for url in endpoints:
            resp = self.client.post(
                url, data="{oops-not-json", content_type="application/json",
                HTTP_X_CSRFTOKEN=self.client.get("/accounts/login/").cookies["csrftoken"].value,
            )
            self.assertEqual(resp.status_code, 400, f"{url} returned {resp.status_code}")

    def test_array_body_is_400(self):
        resp = self.client.post(
            f"/class/{self.classroom.room_code}/lock/",
            data="[1,2,3]", content_type="application/json",
            HTTP_X_CSRFTOKEN=self.client.get("/accounts/login/").cookies["csrftoken"].value,
        )
        self.assertEqual(resp.status_code, 400)

    def test_non_int_session_id_is_400(self):
        resp = self.client.post(
            f"/class/{self.classroom.room_code}/sessions/start/",
            data=json.dumps({"session_id": "not-an-int"}), content_type="application/json",
            HTTP_X_CSRFTOKEN=self.client.get("/accounts/login/").cookies["csrftoken"].value,
        )
        self.assertEqual(resp.status_code, 400)


# ---------------------------------------------------------------------------
# 7. Presentation type confusion + overflow
# ---------------------------------------------------------------------------
class PresentationHardeningTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="pres_owner", password="x")
        self.classroom = create_classroom(self.owner, title="PRES")
        self.client.force_login(self.owner)
        self._csrf = self.client.get("/accounts/login/").cookies["csrftoken"].value

    def tearDown(self):
        cache.clear()

    def _post(self, payload: dict):
        return self.client.post(
            f"/class/{self.classroom.room_code}/presentation/",
            data=json.dumps(payload), content_type="application/json",
            HTTP_X_CSRFTOKEN=self._csrf,
        )

    def test_bool_file_id_rejected(self):
        resp = self._post({"file_id": True, "page": 1})
        self.assertEqual(resp.status_code, 400)

    def test_huge_page_clamped_not_crash(self):
        resp = self._post({"page": 10 ** 20})
        self.assertEqual(resp.status_code, 200)
        self.classroom.refresh_from_db()
        self.assertEqual(self.classroom.current_page, 9999)

    def test_non_student_cannot_present(self):
        student = User.objects.create_user(username="pres_student", password="x")
        join_classroom(self.classroom, student)
        self.client.force_login(student)
        resp = self._post({"page": 3})
        self.assertEqual(resp.status_code, 403)
        self.classroom.refresh_from_db()
        self.assertEqual(self.classroom.current_page, 1)


# ---------------------------------------------------------------------------
# 8. Whiteboard JSON type confusion
# ---------------------------------------------------------------------------
class WhiteboardTypeConfusionTests(SecurityTestBase):
    def test_bool_file_id_op_rejected(self):
        import asyncio

        async def scenario():
            ws = WebsocketCommunicator(
                app_with_user(self.owner, wb_routes),
                f"/ws/classroom/{self.classroom.room_code}/whiteboard/",
            )
            connected, _ = await ws.connect()
            assert connected
            await ws.receive_json_from()  # history

            await ws.send_json_to({"action": "op", "op": {"type": "draw", "tool": "pen", "points": [[1, 2]], "file_id": True}})
            msg = await ws.receive_json_from()
            assert msg["type"] == "error", msg

            await ws.send_json_to({"action": "op", "op": {"type": "page_go", "page": True}})
            msg = await ws.receive_json_from()
            assert msg["type"] == "error", msg

            # legit int file_id still accepted
            await ws.send_json_to({"action": "op", "op": {"type": "draw", "tool": "pen", "points": [[1, 2]], "file_id": 7, "page": 1}})
            await asyncio.sleep(0.2)  # let the consumer persist
            await ws.disconnect()

        asyncio.get_event_loop().run_until_complete(scenario())
        # DB assertion runs OUTSIDE the async context (sync ORM)
        self.assertEqual(WhiteboardEvent.objects.filter(operation__file_id=7).count(), 1)


# ---------------------------------------------------------------------------
# 9. API detail view — owner who is also an active member
# ---------------------------------------------------------------------------
class ApiDistinctTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = User.objects.create_user(username="api_owner", password="x")
        self.classroom = create_classroom(self.owner, title="API")

    def tearDown(self):
        cache.clear()

    def test_detail_no_500_for_owner_member(self):
        client = APIClient()
        client.force_authenticate(self.owner)
        resp = client.get(f"/api/classrooms/{self.classroom.room_code}/")
        self.assertEqual(resp.status_code, 200)


# ---------------------------------------------------------------------------
# 10. REST login throttling
# ---------------------------------------------------------------------------
class ApiLoginThrottleTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="api_victim", password="Sup3r!Secret")

    def tearDown(self):
        cache.clear()

    def test_token_login_throttled(self):
        client = APIClient()
        last = None
        for _ in range(31):
            last = client.post("/api/auth/login/", {"username": "api_victim", "password": "wrong"})
        self.assertEqual(last.status_code, 429)
