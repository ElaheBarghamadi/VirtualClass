"""Phase-2 tests: host actions, permission escalation, locks, waiting room,
bans, rate limiting, files, sessions, attendance and media tokens.
"""
import base64
import io
import json
import zipfile
from datetime import timedelta

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from .models import AttendanceRecord, ClassroomMember, ClassroomSession, SharedFile
from .permissions import Role, effective_permissions
from .services import (
    ClassroomLocked,
    PermissionDenied,
    TooManyAttempts,
    UserBanned,
    attendance_join,
    attendance_leave,
    create_classroom,
    end_session,
    join_classroom,
    set_member_permission,
    set_member_role,
    set_member_muted,
    mute_all,
    remove_member,
    start_session,
)

PASSWORD = "testpass-123"


def make_user(username: str):
    from django.contrib.auth import get_user_model

    return get_user_model().objects.create_user(username=username, password=PASSWORD)


class HostActionTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("h_owner")
        self.mod = make_user("h_mod")
        self.student = make_user("h_student")
        self.outsider = make_user("h_outsider")
        self.classroom = create_classroom(self.owner, title="Host")
        self.mod_member = join_classroom(self.classroom, self.mod)
        self.stu_member = join_classroom(self.classroom, self.student)
        set_member_role(self.classroom, self.owner, self.mod_member.id, Role.MODERATOR)
        self.mod_member.refresh_from_db()
        self.client.login(username="h_owner", password=PASSWORD)

    def _url(self, name, *args):
        return reverse(name, args=[self.classroom.room_code, *args])

    # -- permission toggles ------------------------------------------------
    def test_owner_can_toggle_student_permission(self):
        response = self.client.post(
            self._url("room:member_permission", self.stu_member.id),
            json.dumps({"permission": "can_share_screen", "value": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.stu_member.refresh_from_db()
        self.assertTrue(self.stu_member.can_share_screen)

    def test_unknown_permission_rejected(self):
        response = self.client.post(
            self._url("room:member_permission", self.stu_member.id),
            json.dumps({"permission": "is_superuser", "value": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_student_cannot_manage_anyone(self):
        self.client.login(username="h_student", password=PASSWORD)
        response = self.client.post(
            self._url("room:member_permission", self.mod_member.id),
            json.dumps({"permission": "can_use_camera", "value": False}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

    def test_outsider_cannot_touch_other_classroom(self):
        """IDOR: a member of no classroom gets 403 on host endpoints."""
        self.client.login(username="h_outsider", password=PASSWORD)
        response = self.client.post(
            self._url("room:member_permission", self.stu_member.id),
            json.dumps({"permission": "can_use_camera", "value": False}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)
        self.stu_member.refresh_from_db()
        self.assertTrue(self.stu_member.can_use_camera)

    def test_moderator_cannot_promote_or_touch_moderators(self):
        self.client.login(username="h_mod", password=PASSWORD)
        other_mod = make_user("h_mod2")
        other_member = join_classroom(self.classroom, other_mod)
        set_member_role(self.classroom, self.owner, other_member.id, Role.MODERATOR)

        # Promoting is OWNER-only:
        response = self.client.post(
            self._url("room:member_role", self.stu_member.id),
            json.dumps({"role": "PRESENTER"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

        # Managing a fellow moderator is refused:
        response = self.client.post(
            self._url("room:member_permission", other_member.id),
            json.dumps({"permission": "can_use_camera", "value": False}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

    def test_owner_cannot_be_demoted(self):
        owner_member = ClassroomMember.objects.get(classroom=self.classroom, user=self.owner)
        response = self.client.post(
            self._url("room:member_role", owner_member.id),
            json.dumps({"role": "STUDENT"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)

    def test_role_change_to_invalid_role_rejected(self):
        response = self.client.post(
            self._url("room:member_role", self.stu_member.id),
            json.dumps({"role": "OWNER"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    # -- mute ----------------------------------------------------------------
    def test_mute_and_mute_all(self):
        response = self.client.post(
            self._url("room:member_mute", self.stu_member.id),
            json.dumps({"muted": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.stu_member.refresh_from_db()
        self.assertTrue(self.stu_member.muted)
        # Effective permissions reflect the mute:
        self.classroom.refresh_from_db()
        perms = effective_permissions(self.stu_member, self.classroom)
        self.assertFalse(perms["can_use_microphone"])

        response = self.client.post(self._url("room:mute_all"), "{}", content_type="application/json")
        self.assertEqual(response.status_code, 200)
        self.mod_member.refresh_from_db()
        self.assertTrue(self.mod_member.muted)

    # -- remove / ban ----------------------------------------------------------
    def test_remove_and_ban(self):
        response = self.client.post(
            self._url("room:member_remove", self.stu_member.id),
            json.dumps({"ban_minutes": 5}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.stu_member.refresh_from_db()
        self.assertFalse(self.stu_member.is_active)
        self.assertIsNotNone(self.stu_member.banned_until)

        # Banned user cannot rejoin:
        with self.assertRaises(UserBanned):
            join_classroom(self.classroom, self.student)

    # -- lock --------------------------------------------------------------------
    def test_lock_blocks_new_joins(self):
        response = self.client.post(
            self._url("room:lock"), json.dumps({"locked": True}), content_type="application/json"
        )
        self.assertEqual(response.status_code, 200)
        self.classroom.refresh_from_db()
        self.assertTrue(self.classroom.is_locked)

        stranger = make_user("h_stranger")
        with self.assertRaises(ClassroomLocked):
            join_classroom(self.classroom, stranger)

        # Existing member can still re-enter:
        member = join_classroom(self.classroom, self.student)
        self.assertTrue(member.is_active)

    # -- settings ------------------------------------------------------------------
    def test_settings_update(self):
        # Grant the member flag first (room settings only *restrict* students):
        set_member_permission(self.classroom, self.owner, self.stu_member.id, "can_share_screen", True)
        self.classroom.allow_student_screen_share = True
        self.classroom.save()
        self.stu_member.refresh_from_db()
        perms = effective_permissions(self.stu_member, self.classroom)
        self.assertTrue(perms["can_share_screen"])

        # Owner disables screen share + chat room-wide through the API:
        response = self.client.post(
            self._url("room:settings"),
            json.dumps({"settings": {"allow_student_screen_share": False, "chat_disabled": True}}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.classroom.refresh_from_db()
        self.assertFalse(self.classroom.allow_student_screen_share)
        self.assertTrue(self.classroom.chat_disabled)

        # Effective permissions follow BOTH layers:
        perms = effective_permissions(self.stu_member, self.classroom)
        self.assertFalse(perms["can_share_screen"])
        self.assertFalse(perms["can_send_messages"])  # chat_disabled

    def test_non_owner_cannot_change_settings(self):
        self.client.login(username="h_mod", password=PASSWORD)
        response = self.client.post(
            self._url("room:settings"),
            json.dumps({"settings": {"chat_disabled": True}}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)


class WaitingRoomTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("w_owner")
        self.student = make_user("w_student")
        self.classroom = create_classroom(self.owner, title="Waiting")
        self.classroom.enable_waiting_room = True
        self.classroom.save()

    def test_new_student_goes_to_waiting_room(self):
        member = join_classroom(self.classroom, self.student)
        self.assertTrue(member.in_waiting_room)

        self.client.login(username="w_student", password=PASSWORD)
        response = self.client.get(reverse("room:room", args=[self.classroom.room_code]))
        self.assertRedirects(response, reverse("room:waiting", args=[self.classroom.room_code]))

    def test_owner_approves_entry(self):
        member = join_classroom(self.classroom, self.student)
        self.client.login(username="w_owner", password=PASSWORD)
        response = self.client.post(
            reverse("room:waiting_action", args=[self.classroom.room_code, member.id]),
            json.dumps({"approve": True}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        member.refresh_from_db()
        self.assertFalse(member.in_waiting_room)

        # Now the student can enter the room:
        self.client.login(username="w_student", password=PASSWORD)
        response = self.client.get(reverse("room:room", args=[self.classroom.room_code]))
        self.assertEqual(response.status_code, 200)

    def test_deny_deactivates_membership(self):
        member = join_classroom(self.classroom, self.student)
        self.client.login(username="w_owner", password=PASSWORD)
        self.client.post(
            reverse("room:waiting_action", args=[self.classroom.room_code, member.id]),
            json.dumps({"approve": False}),
            content_type="application/json",
        )
        member.refresh_from_db()
        self.assertFalse(member.is_active)


class RateLimitTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("r_owner")
        self.attacker = make_user("r_attacker")
        self.classroom = create_classroom(
            self.owner, title="Rate", password="rightpass1", is_password_protected=True
        )

    def test_password_guessing_is_rate_limited(self):
        from .services import WrongClassroomPassword

        for _ in range(5):
            with self.assertRaises(WrongClassroomPassword):
                join_classroom(self.classroom, self.attacker, "wrong")
        with self.assertRaises(TooManyAttempts):
            join_classroom(self.classroom, self.attacker, "rightpass1")


class SessionAttendanceTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("s_owner")
        self.student = make_user("s_student")
        self.classroom = create_classroom(self.owner, title="Sessions")
        join_classroom(self.classroom, self.student)

    def test_schedule_start_end_flow(self):
        session = ClassroomSession.objects.create(
            classroom=self.classroom,
            host=self.owner,
            title="جلسهٔ ۱",
            scheduled_start=timezone.now() + timezone.timedelta(hours=1),
        )
        self.assertEqual(session.status, ClassroomSession.Status.SCHEDULED)

        live = start_session(self.classroom, self.owner, session)
        self.assertEqual(live.status, ClassroomSession.Status.LIVE)
        self.assertIsNotNone(live.started_at)

        # Attaching again returns the same live session:
        self.assertEqual(start_session(self.classroom, self.owner).id, live.id)

        end_session(live, self.owner)
        live.refresh_from_db()
        self.assertEqual(live.status, ClassroomSession.Status.ENDED)
        self.assertIsNotNone(live.duration_seconds)

    def test_student_cannot_start_session(self):
        with self.assertRaises(PermissionDenied):
            start_session(self.classroom, self.student)

    def test_attendance_multiple_joins(self):
        live = start_session(self.classroom, self.owner)
        attendance_join(self.classroom, self.student)
        attendance_leave(self.classroom, self.student)
        attendance_join(self.classroom, self.student)
        attendance_leave(self.classroom, self.student)

        records = AttendanceRecord.objects.filter(session=live, user=self.student)
        self.assertEqual(records.count(), 2)
        self.assertTrue(all(r.left_at is not None for r in records))

    def test_attendance_requires_live_session(self):
        self.assertIsNone(attendance_join(self.classroom, self.student))

    def test_attendance_page_owner_only(self):
        live = start_session(self.classroom, self.owner)
        self.client.login(username="s_student", password=PASSWORD)
        response = self.client.get(
            reverse("room:attendance", args=[self.classroom.room_code, live.id])
        )
        self.assertEqual(response.status_code, 404)

        self.client.login(username="s_owner", password=PASSWORD)
        response = self.client.get(
            reverse("room:attendance", args=[self.classroom.room_code, live.id])
        )
        self.assertEqual(response.status_code, 200)


PDF_BYTES = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"


def office_file(kind: str) -> bytes:
    """Build a minimal valid OOXML (zip) container."""
    marker = {"docx": "word/document.xml", "xlsx": "xl/workbook.xml", "pptx": "ppt/presentation.xml"}[kind]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr(marker, "<x/>")
    return buf.getvalue()


class FileUploadTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("f_owner")
        self.student = make_user("f_student")
        self.classroom = create_classroom(self.owner, title="Files")
        join_classroom(self.classroom, self.student)
        self.upload_url = reverse("room:file_upload", args=[self.classroom.room_code])

    def _upload(self, user, name, content, content_type="application/octet-stream"):
        self.client.login(username=user, password=PASSWORD)
        return self.client.post(self.upload_url, {"file": SimpleUploadedFile(name, content, content_type)})

    def test_owner_can_upload_pdf(self):
        response = self._upload("f_owner", "درس.pdf", PDF_BYTES, "application/pdf")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(SharedFile.objects.filter(original_name="درس.pdf").exists())

    def test_student_upload_denied_by_default(self):
        response = self._upload("f_student", "x.pdf", PDF_BYTES)
        self.assertEqual(response.status_code, 403)

    def test_disallowed_extension_rejected(self):
        response = self._upload("f_owner", "evil.exe", b"MZ\x90\x00")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(SharedFile.objects.count(), 0)

    def test_spoofed_extension_rejected(self):
        """An ELF binary renamed to .pdf must fail magic-byte validation."""
        response = self._upload("f_owner", "fake.pdf", b"\x7fELF" + b"\x00" * 60)
        self.assertEqual(response.status_code, 400)

    def test_empty_file_rejected(self):
        response = self._upload("f_owner", "empty.pdf", b"")
        self.assertEqual(response.status_code, 400)

    def test_office_file_validation(self):
        ok = self._upload("f_owner", "doc.docx", office_file("docx"))
        self.assertEqual(ok.status_code, 200, ok.content)
        # A zip without OOXML markers claiming to be .xlsx:
        bad = io.BytesIO()
        with zipfile.ZipFile(bad, "w") as z:
            z.writestr("readme.txt", "hi")
        response = self._upload("f_owner", "fake.xlsx", bad.getvalue())
        self.assertEqual(response.status_code, 400)

    @override_settings(MAX_UPLOAD_MB=0)
    def test_size_limit_enforced(self):
        response = self._upload("f_owner", "big.pdf", PDF_BYTES)
        self.assertEqual(response.status_code, 400)

    def test_download_requires_membership(self):
        self._upload("f_owner", "d.pdf", PDF_BYTES)
        shared = SharedFile.objects.first()
        url = reverse("room:file_download", args=[self.classroom.room_code, shared.id])

        outsider = make_user("f_outsider")
        self.client.login(username="f_outsider", password=PASSWORD)
        self.assertEqual(self.client.get(url).status_code, 404)

        self.client.login(username="f_student", password=PASSWORD)
        self.assertEqual(self.client.get(url).status_code, 200)

    def test_path_traversal_filename_sanitized(self):
        response = self._upload("f_owner", "../../etc/passwd.pdf", PDF_BYTES)
        self.assertEqual(response.status_code, 200)
        shared = SharedFile.objects.first()
        self.assertNotIn("/", shared.original_name)
        self.assertNotIn("..", shared.original_name)


@override_settings(
    LIVEKIT_URL="https://livekit.example.com",
    LIVEKIT_API_KEY="APItestkey123",
    LIVEKIT_API_SECRET="secret_at_least_32_chars_long_value!!",
)
class MediaTokenTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("m_owner")
        self.student = make_user("m_student")
        self.classroom = create_classroom(self.owner, title="Media")
        join_classroom(self.classroom, self.student)
        self.url = reverse("room:media_token", args=[self.classroom.room_code])

    @staticmethod
    def _decode(jwt: str) -> dict:
        payload = jwt.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))

    def test_owner_token_allows_all_sources(self):
        self.client.login(username="m_owner", password=PASSWORD)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        claims = self._decode(response.json()["token"])
        self.assertTrue(claims["video"]["roomJoin"])
        self.assertEqual(claims["video"]["room"], f"classroom_{self.classroom.room_code}")
        self.assertEqual(
            set(claims["video"]["canPublishSources"]), {"camera", "microphone", "screen_share"}
        )

    def test_student_token_matches_effective_permissions(self):
        self.client.login(username="m_student", password=PASSWORD)
        response = self.client.get(self.url)
        claims = self._decode(response.json()["token"])
        # STUDENT defaults: mic+camera yes, screen share no.
        self.assertEqual(set(claims["video"]["canPublishSources"]), {"camera", "microphone"})

    def test_muted_student_gets_no_microphone_grant(self):
        member = ClassroomMember.objects.get(classroom=self.classroom, user=self.student)
        set_member_muted(self.classroom, self.owner, member.id, True)
        self.client.login(username="m_student", password=PASSWORD)
        response = self.client.get(self.url)
        claims = self._decode(response.json()["token"])
        self.assertNotIn("microphone", claims["video"].get("canPublishSources") or [])

    def test_non_member_denied(self):
        outsider = make_user("m_outsider")
        self.client.login(username="m_outsider", password=PASSWORD)
        self.assertEqual(self.client.get(self.url).status_code, 403)

    @override_settings(LIVEKIT_URL="", LIVEKIT_API_KEY="", LIVEKIT_API_SECRET="")
    def test_unconfigured_returns_503(self):
        self.client.login(username="m_owner", password=PASSWORD)
        self.assertEqual(self.client.get(self.url).status_code, 503)
