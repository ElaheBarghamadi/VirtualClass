"""Tests for classrooms: HTTP flows, models, permissions and API."""
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from .models import Classroom, ClassroomMember, SharedFile
from .permissions import Role, defaults_for_role
from .services import create_classroom, join_classroom, WrongClassroomPassword

User = get_user_model()


def make_user(username: str, password: str = "testpass-123") -> User:
    return User.objects.create_user(username=username, password=password, email=f"{username}@x.com")


class AuthFlowTests(TestCase):
    def test_register_login_logout(self):
        response = self.client.post(
            reverse("accounts:register"),
            {
                "username": "elahe",
                "email": "elahe@example.com",
                "first_name": "Elahe",
                "last_name": "",
                "password1": "S0mething!complex",
                "password2": "S0mething!complex",
            },
        )
        self.assertRedirects(response, reverse("accounts:post_login"), target_status_code=302,
                             fetch_redirect_response=False)
        self.assertTrue(User.objects.filter(username="elahe").exists())

        self.client.logout()
        response = self.client.post(
            reverse("accounts:login"), {"username": "elahe", "password": "S0mething!complex"}
        )
        # login lands on the landing-preference redirect, then the dashboard
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse("accounts:post_login"))
        response = self.client.get(reverse("accounts:post_login"))
        self.assertRedirects(response, reverse("dashboard"))

        response = self.client.post(reverse("accounts:logout"))
        self.assertRedirects(response, reverse("home"))

    def test_dashboard_requires_login(self):
        response = self.client.get(reverse("dashboard"))
        self.assertEqual(response.status_code, 302)
        self.assertIn(reverse("accounts:login"), response.url)


class ClassroomModelTests(TestCase):
    def setUp(self):
        self.owner = make_user("owner")

    def test_room_codes_are_unique_and_unguessable(self):
        c1 = create_classroom(self.owner, title="فیزیک ۱")
        c2 = create_classroom(self.owner, title="فیزیک ۲")
        self.assertNotEqual(c1.room_code, c2.room_code)
        self.assertEqual(len(c1.room_code), 11)

    def test_owner_gets_owner_membership(self):
        classroom = create_classroom(self.owner, title="ریاضی")
        member = ClassroomMember.objects.get(classroom=classroom, user=self.owner)
        self.assertEqual(member.role, Role.OWNER)
        self.assertTrue(member.is_active)
        self.assertTrue(member.can_share_screen)  # owner default

    def test_password_is_hashed_not_plaintext(self):
        classroom = create_classroom(
            self.owner, title="شیمی", password="secret123", is_password_protected=True
        )
        self.assertTrue(classroom.is_password_protected)
        self.assertNotEqual(classroom.password, "secret123")
        self.assertNotIn("secret123", classroom.password)
        self.assertTrue(classroom.check_password("secret123"))
        self.assertFalse(classroom.check_password("wrong"))

    def test_join_wrong_password_rejected(self):
        classroom = create_classroom(
            self.owner, title="شیمی", password="secret123", is_password_protected=True
        )
        student = make_user("student")
        with self.assertRaises(WrongClassroomPassword):
            join_classroom(classroom, student, "nope")
        member = join_classroom(classroom, student, "secret123")
        self.assertEqual(member.role, Role.STUDENT)
        self.assertTrue(member.is_active)

    def test_join_reactivates_membership(self):
        classroom = create_classroom(self.owner, title="زیست")
        student = make_user("student")
        join_classroom(classroom, student)
        join_classroom(classroom, student)  # idempotent
        self.assertEqual(classroom.members.filter(user=student).count(), 1)

    def test_role_defaults(self):
        student_defaults = defaults_for_role(Role.STUDENT)
        self.assertFalse(student_defaults.can_share_screen)
        self.assertFalse(student_defaults.can_use_whiteboard)
        self.assertTrue(student_defaults.can_send_messages)


class ClassroomViewTests(TestCase):
    def setUp(self):
        self.owner = make_user("owner")
        self.student = make_user("student")
        self.classroom = create_classroom(
            self.owner, title="فیزیک - فصل ۱", password="roompass1", is_password_protected=True
        )

    def test_create_classroom_via_form(self):
        self.client.login(username="owner", password="testpass-123")
        response = self.client.post(
            reverse("classrooms:create"),
            {"title": "کلاس جدید", "description": "توضیح", "is_password_protected": "on", "password": "abcd"},
        )
        classroom = Classroom.objects.get(title="کلاس جدید")
        # Redirects to the lobby; the lobby then bounces the owner (already a
        # member) into the room, so only assert the first hop here.
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.url, reverse("room:lobby", args=[classroom.room_code]))
        self.assertTrue(classroom.is_password_protected)

    def test_create_form_requires_password_when_protected(self):
        self.client.login(username="owner", password="testpass-123")
        response = self.client.post(
            reverse("classrooms:create"),
            {"title": "بدون رمز", "description": "", "is_password_protected": "on", "password": ""},
        )
        self.assertEqual(response.status_code, 200)
        self.assertFalse(Classroom.objects.filter(title="بدون رمز").exists())

    def test_room_redirects_non_member_to_lobby(self):
        self.client.login(username="student", password="testpass-123")
        response = self.client.get(reverse("room:room", args=[self.classroom.room_code]))
        self.assertRedirects(response, reverse("room:lobby", args=[self.classroom.room_code]))

    def test_lobby_join_flow(self):
        self.client.login(username="student", password="testpass-123")
        lobby = reverse("room:lobby", args=[self.classroom.room_code])

        # Wrong password → stays in lobby.
        response = self.client.post(lobby, {"password": "wrong"})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(
            ClassroomMember.objects.filter(classroom=self.classroom, user=self.student, is_active=True).exists()
        )

        # Correct password → into the room.
        response = self.client.post(lobby, {"password": "roompass1"})
        self.assertRedirects(response, reverse("room:room", args=[self.classroom.room_code]))
        self.assertTrue(
            ClassroomMember.objects.filter(classroom=self.classroom, user=self.student, is_active=True).exists()
        )

    def test_room_view_shows_only_own_permissions(self):
        join_classroom(self.classroom, self.student, "roompass1")
        self.client.login(username="student", password="testpass-123")
        response = self.client.get(reverse("room:room", args=[self.classroom.room_code]))
        self.assertEqual(response.status_code, 200)
        perms = response.context["permissions"]
        self.assertTrue(perms["can_send_messages"])
        self.assertFalse(perms["can_share_screen"])  # STUDENT default

    def test_public_link_redirects_to_lobby(self):
        self.client.login(username="student", password="testpass-123")
        response = self.client.get(f"/class/{self.classroom.room_code}/")
        self.assertRedirects(response, reverse("room:lobby", args=[self.classroom.room_code]))

    def test_leave_deactivates_membership(self):
        join_classroom(self.classroom, self.student, "roompass1")
        self.client.login(username="student", password="testpass-123")
        self.client.post(reverse("room:leave", args=[self.classroom.room_code]))
        member = ClassroomMember.objects.get(classroom=self.classroom, user=self.student)
        self.assertFalse(member.is_active)


class ApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.owner = make_user("owner")

    def test_register_and_login_token(self):
        response = self.client.post(
            reverse("api_register"),
            {"username": "apiuser", "email": "a@x.com", "password": "Str0ng!pass"},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)

        response = self.client.post(
            reverse("api_login"), {"username": "apiuser", "password": "Str0ng!pass"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("token", response.data)

    def test_classroom_crud_and_participants(self):
        self.client.force_authenticate(self.owner)

        response = self.client.post(
            reverse("api_classroom_list"),
            {"title": "API کلاس", "is_password_protected": True, "password": "abcd"},
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        room_code = response.data["room_code"]
        self.assertNotIn("password", response.data)  # never expose the hash

        response = self.client.get(reverse("api_classroom_list"))
        self.assertEqual(response.data["count"], 1)

        response = self.client.get(reverse("api_classroom_detail", args=[room_code]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["room_code"], room_code)

        response = self.client.get(reverse("api_classroom_participants", args=[room_code]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.data), 1)  # the owner
        self.assertEqual(response.data[0]["role"], Role.OWNER)

    def test_api_requires_auth(self):
        response = self.client.get(reverse("api_classroom_list"))
        self.assertEqual(response.status_code, 401)


class StalePermissionFlagTests(TestCase):
    """Regression: `can_present` was added by migration 0002 with
    default=False, so membership rows created earlier (including the OWNER
    of old classrooms) could never present — file rows silently did nothing
    and the only working action was download.
    """

    def setUp(self):
        self.owner = make_user("old_owner")
        self.classroom = create_classroom(self.owner, title="Old class")
        self.member = ClassroomMember.objects.get(classroom=self.classroom, user=self.owner)

    def test_owner_with_stale_flags_still_has_full_permissions(self):
        from .permissions import effective_permissions
        # simulate a membership row created before migration 0002
        ClassroomMember.objects.filter(pk=self.member.pk).update(
            can_present=False, can_share_screen=False,
            can_use_whiteboard=False, can_upload_files=False,
        )
        self.member.refresh_from_db()
        perms = effective_permissions(self.member, self.classroom)
        self.assertTrue(perms["can_present"], "owner must always be able to present")
        self.assertTrue(all(perms.values()), f"owner must hold every capability: {perms}")

    def test_backfill_migration_repairs_privileged_roles(self):
        import importlib
        from django.apps import apps as global_apps
        migration = importlib.import_module(
            "classrooms.migrations.0005_backfill_can_present")
        presenter = join_classroom(self.classroom, make_user("pres"))
        student = join_classroom(self.classroom, make_user("stud"))
        ClassroomMember.objects.filter(pk__in=[self.member.pk, presenter.pk]).update(
            can_present=False)
        presenter.role = Role.PRESENTER
        presenter.save(update_fields=["role"])

        migration.backfill_can_present(global_apps, None)

        self.member.refresh_from_db(); presenter.refresh_from_db(); student.refresh_from_db()
        self.assertTrue(self.member.can_present)   # OWNER repaired
        self.assertTrue(presenter.can_present)     # PRESENTER repaired
        self.assertFalse(student.can_present)      # STUDENT untouched

    def test_owner_room_page_marks_files_presentable(self):
        from django.core.files.base import ContentFile
        from .models import SharedFile
        ClassroomMember.objects.filter(pk=self.member.pk).update(can_present=False)
        sf = SharedFile.objects.create(
            classroom=self.classroom, uploader=self.owner,
            original_name="deck.pdf", size=10, content_type="application/pdf",
        )
        sf.file.save("deck.pdf", ContentFile(b"%PDF-1.4 test"), save=True)
        self.client.force_login(self.owner)
        resp = self.client.get(reverse("room:room", args=[self.classroom.room_code]))
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "data-present")  # owner row is presentable
        self.assertTrue(resp.context["permissions"]["can_present"])

    def test_owner_with_stale_flags_can_start_presentation(self):
        from django.core.files.base import ContentFile
        from .models import SharedFile
        from .services import set_presentation
        ClassroomMember.objects.filter(pk=self.member.pk).update(can_present=False)
        sf = SharedFile.objects.create(
            classroom=self.classroom, uploader=self.owner,
            original_name="deck.pdf", size=10, content_type="application/pdf",
        )
        sf.file.save("deck.pdf", ContentFile(b"%PDF-1.4 test"), save=True)
        set_presentation(self.classroom, self.owner, sf.id, 1)  # must not raise
        self.classroom.refresh_from_db()
        self.assertEqual(self.classroom.current_file_id, sf.id)
        self.assertEqual(self.classroom.current_page, 1)


class FileSharingTests(TestCase):
    """Files panel rebuild: delete rights, presentation cleanup, quota."""

    def setUp(self):
        from django.core.files.base import ContentFile
        from .models import SharedFile
        self.owner = make_user("f_owner")
        self.student = make_user("f_stu")
        self.other = make_user("f_other")
        self.classroom = create_classroom(self.owner, title="Files")
        join_classroom(self.classroom, self.student)
        join_classroom(self.classroom, self.other)
        self.sf = SharedFile.objects.create(
            classroom=self.classroom, uploader=self.owner,
            original_name="deck.pdf", size=15, content_type="application/pdf",
        )
        self.sf.file.save("deck.pdf", ContentFile(b"%PDF-1.4 hello"), save=True)
        self.path = self.sf.file.path

    def _upload(self, user, name="up.pdf"):
        from django.core.files.uploadedfile import SimpleUploadedFile
        self.client.force_login(user)
        return self.client.post(
            reverse("room:file_upload", args=[self.classroom.room_code]),
            {"file": SimpleUploadedFile(name, b"%PDF-1.4 test", content_type="application/pdf")},
        )

    def test_owner_deletes_any_file_and_physical_copy_goes(self):
        import os
        self.client.force_login(self.owner)
        resp = self.client.post(
            reverse("room:file_delete", args=[self.classroom.room_code, self.sf.id]))
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(SharedFile.objects.filter(id=self.sf.id).exists())
        self.assertFalse(os.path.exists(self.path), "physical file must be removed")

    def test_uploader_without_privileges_deletes_own_file(self):
        from .models import ClassroomMember
        import os
        # student granted upload rights — not privileged
        ClassroomMember.objects.filter(classroom=self.classroom, user=self.student).update(
            can_upload_files=True)
        resp = self._upload(self.student)
        self.assertEqual(resp.status_code, 200)
        fid = resp.json()["id"]
        path = SharedFile.objects.get(id=fid).file.path
        resp = self.client.post(
            reverse("room:file_delete", args=[self.classroom.room_code, fid]))
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(os.path.exists(path))

    def test_student_cannot_delete_others_file(self):
        self.client.force_login(self.other)
        resp = self.client.post(
            reverse("room:file_delete", args=[self.classroom.room_code, self.sf.id]))
        self.assertEqual(resp.status_code, 403)
        self.assertTrue(SharedFile.objects.filter(id=self.sf.id).exists())

    def test_non_member_cannot_delete(self):
        outsider = make_user("f_out")
        self.client.force_login(outsider)
        resp = self.client.post(
            reverse("room:file_delete", args=[self.classroom.room_code, self.sf.id]))
        self.assertIn(resp.status_code, (403, 404))

    def test_deleting_presented_file_clears_presentation(self):
        from .services import set_presentation
        set_presentation(self.classroom, self.owner, self.sf.id, 1)
        self.classroom.refresh_from_db()
        self.assertEqual(self.classroom.current_file_id, self.sf.id)
        self.client.force_login(self.owner)
        resp = self.client.post(
            reverse("room:file_delete", args=[self.classroom.room_code, self.sf.id]))
        self.assertEqual(resp.status_code, 200)
        self.classroom.refresh_from_db()
        self.assertIsNone(self.classroom.current_file_id)

    def test_upload_quota_enforced(self):
        from unittest import mock
        with mock.patch("classrooms.views.MAX_FILES_PER_CLASSROOM", 1):
            resp = self._upload(self.owner)  # one file already exists
        self.assertEqual(resp.status_code, 400)
        self.assertIn("حداکثر", resp.json()["detail"])

    def test_type_icon_per_extension(self):
        from .models import SharedFile
        for name, icon in [("a.pdf", "📄"), ("b.png", "🖼️"), ("c.docx", "📝"),
                           ("d.xlsx", "📊"), ("e.pptx", "📽️"), ("f.zip", "📦"), ("g", "📎")]:
            sf = SharedFile(original_name=name, size=1)
            self.assertEqual(sf.type_icon, icon, name)


class RemainingHardeningTests(TestCase):
    """The five remaining review items: upload throttle, storage cleanup
    signal, deploy checks, ICE config plumbing."""

    def setUp(self):
        from django.core.cache import cache
        cache.clear()
        self.owner = make_user("h_owner")
        self.classroom = create_classroom(self.owner, title="Hardening")

    def tearDown(self):
        from django.core.cache import cache
        cache.clear()

    def _upload(self, name="up.pdf"):
        from django.core.files.uploadedfile import SimpleUploadedFile
        self.client.force_login(self.owner)
        return self.client.post(
            reverse("room:file_upload", args=[self.classroom.room_code]),
            {"file": SimpleUploadedFile(name, b"%PDF-1.4 test", content_type="application/pdf")},
        )

    def test_upload_rate_limit_returns_429(self):
        from unittest import mock
        with mock.patch("django.conf.settings.UPLOAD_RATE_LIMIT", 2):
            r1 = self._upload("a.pdf"); r2 = self._upload("b.pdf"); r3 = self._upload("c.pdf")
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r3.status_code, 429)
        self.assertIn("صبر", r3.json()["detail"])

    def test_classroom_delete_removes_physical_files(self):
        import os
        from django.core.files.base import ContentFile
        sf = SharedFile.objects.create(
            classroom=self.classroom, uploader=self.owner,
            original_name="x.pdf", size=10, content_type="application/pdf")
        sf.file.save("x.pdf", ContentFile(b"%PDF-1.4 data"), save=True)
        path = sf.file.path
        self.assertTrue(os.path.exists(path))
        self.classroom.delete()  # cascade → post_delete signal
        self.assertFalse(os.path.exists(path), "physical file must not be orphaned")

    def test_deploy_check_warns_on_debug_with_public_hosts(self):
        from core.checks import deploy_configuration
        with self.settings(DEBUG=True, ALLOWED_HOSTS=["classroom.example.com"]):
            issues = deploy_configuration(None)
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].id, "deploy.W001")
        with self.settings(DEBUG=True, ALLOWED_HOSTS=["localhost", "127.0.0.1"]):
            self.assertEqual(deploy_configuration(None), [])

    def test_ice_servers_config_parsed_and_shipped_to_page(self):
        import json as _json
        from config.settings import _parse_ice_servers
        from classrooms.media import media_config_payload
        self.assertEqual(_parse_ice_servers(""), [])
        self.assertEqual(_parse_ice_servers("not json"), [])
        self.assertEqual(_parse_ice_servers('{"a":1}'), [])
        good = '[{"urls":["turn:t.example.com:3478"],"username":"u","credential":"c"}]'
        self.assertEqual(_parse_ice_servers(good), _json.loads(good))
        payload = media_config_payload()
        self.assertIn("ice_servers_json", payload)
        self.assertIn("mesh_max_participants", payload)
        self.client.force_login(self.owner)
        resp = self.client.get(reverse("room:room", args=[self.classroom.room_code]))
        self.assertContains(resp, "data-ice-servers=")
        self.assertContains(resp, "data-mesh-max=")


class OfficeConversionTests(TestCase):
    """Office → PDF pipeline (LibreOffice optional; skipped when absent)."""

    def setUp(self):
        from django.core.cache import cache
        cache.clear()
        from .office_convert import conversion_available
        if not conversion_available():
            self.skipTest("LibreOffice not installed")
        self.owner = make_user("c_owner")
        self.classroom = create_classroom(self.owner, title="Convert")

    def tearDown(self):
        from django.core.cache import cache
        cache.clear()

    def _make_pptx_bytes(self) -> bytes:
        import io
        from pptx import Presentation as Pptx
        prs = Pptx()
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        from pptx.util import Inches
        tb = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(2))
        tb.text_frame.text = "Hello from conversion test"
        buf = io.BytesIO(); prs.save(buf)
        return buf.getvalue()

    def _make_docx_bytes(self) -> bytes:
        import io
        import docx
        d = docx.Document()
        d.add_heading("Conversion test", 0)
        d.add_paragraph("سلام — این یک سند تست است.")
        buf = io.BytesIO(); d.save(buf)
        return buf.getvalue()

    def _upload(self, name, content, ctype):
        from django.core.files.uploadedfile import SimpleUploadedFile
        self.client.force_login(self.owner)
        return self.client.post(
            reverse("room:file_upload", args=[self.classroom.room_code]),
            {"file": SimpleUploadedFile(name, content, content_type=ctype)},
        )

    def test_pptx_upload_produces_pdf_version(self):
        resp = self._upload("lesson.pptx", self._make_pptx_bytes(),
                            "application/vnd.openxmlformats-officedocument.presentationml.presentation")
        self.assertEqual(resp.status_code, 200)
        sf = SharedFile.objects.get(id=resp.json()["id"])
        self.assertTrue(sf.pdf_version, "PPTX must gain a PDF copy")
        head = sf.pdf_version.read(5)
        self.assertEqual(head, b"%PDF-")

    def test_docx_upload_produces_pdf_version(self):
        resp = self._upload("notes.docx", self._make_docx_bytes(),
                            "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.assertEqual(resp.status_code, 200)
        sf = SharedFile.objects.get(id=resp.json()["id"])
        self.assertTrue(sf.pdf_version, "DOCX must gain a PDF copy")

    def test_download_pdf_format_serves_conversion(self):
        resp = self._upload("lesson.pptx", self._make_pptx_bytes(), "application/x-pptx")
        sf = SharedFile.objects.get(id=resp.json()["id"])
        r = self.client.get(reverse("room:file_download",
                            args=[self.classroom.room_code, sf.id]) + "?format=pdf")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(b"".join(r.streaming_content)[:5], b"%PDF-")
        # original download still returns the PPTX
        r2 = self.client.get(reverse("room:file_download",
                             args=[self.classroom.room_code, sf.id]))
        self.assertEqual(b"".join(r2.streaming_content)[:2], b"PK")

    def test_pdf_format_404_without_conversion(self):
        resp = self._upload("pic.pdf", b"%PDF-1.4 fake", "application/pdf")
        sf = SharedFile.objects.get(id=resp.json()["id"])
        r = self.client.get(reverse("room:file_download",
                            args=[self.classroom.room_code, sf.id]) + "?format=pdf")
        self.assertEqual(r.status_code, 404)

    def test_upload_survives_without_libreoffice(self):
        from unittest import mock
        with mock.patch("classrooms.office_convert.soffice_path", return_value=None):
            resp = self._upload("deck.pptx", self._make_pptx_bytes(), "application/x-pptx")
        self.assertEqual(resp.status_code, 200)
        sf = SharedFile.objects.get(id=resp.json()["id"])
        self.assertFalse(sf.pdf_version)  # graceful: download-only


class GuestBanByIpTests(TestCase):
    """A kicked guest cannot rejoin from the same IP while banned."""

    def setUp(self):
        from django.core.cache import cache
        cache.clear()
        self.owner = make_user("ban_owner")
        self.classroom = create_classroom(self.owner, title="Ban room")

    def tearDown(self):
        from django.core.cache import cache
        cache.clear()

    def test_banned_guest_ip_blocked(self):
        from django.utils import timezone
        from datetime import timedelta
        from .services import UserBanned, join_classroom_guest
        guest = join_classroom_guest(self.classroom, "Ali", ip="203.0.113.9")
        self.assertEqual(guest.guest_ip, "203.0.113.9")
        # host kicks with a temporary ban
        guest.banned_until = timezone.now() + timedelta(minutes=10)
        guest.is_active = False
        guest.save(update_fields=["banned_until", "is_active"])
        with self.assertRaises(UserBanned):
            join_classroom_guest(self.classroom, "Ali", ip="203.0.113.9")
        # a different IP (or expired ban) is not affected
        other = join_classroom_guest(self.classroom, "Bob", ip="198.51.100.7")
        self.assertTrue(other.is_active)
        guest.banned_until = timezone.now() - timedelta(minutes=1)
        guest.save(update_fields=["banned_until"])
        again = join_classroom_guest(self.classroom, "Ali", ip="203.0.113.9")
        self.assertTrue(again.is_active)
