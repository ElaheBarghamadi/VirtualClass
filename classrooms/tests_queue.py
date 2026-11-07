"""Background jobs: Office→PDF, stale sessions, abandoned guests.

The upload tests pin down the change that motivated Celery: the request no
longer converts anything — it hands the job off and answers immediately.
"""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from .models import (
    AttendanceRecord,
    ClassroomMember,
    ClassroomSession,
    SharedFile,
)
from .services import create_classroom, join_classroom, join_classroom_guest
from .tasks import close_stale_sessions, convert_office_file, prune_stale_guests

User = get_user_model()


def make_user(username: str, password: str = "testpass-123") -> User:
    return User.objects.create_user(
        username=username, password=password, email=f"{username}@x.com"
    )


class UploadHandsOffConversionTests(TestCase):
    """The upload endpoint queues the conversion instead of running it."""

    def setUp(self):
        from django.core.cache import cache
        cache.clear()
        self.owner = make_user("q_owner")
        self.classroom = create_classroom(self.owner, title="Queue")
        self.client.force_login(self.owner)

    def _upload(self, name="up.pdf", body=b"%PDF-1.4 test"):
        return self.client.post(
            reverse("room:file_upload", args=[self.classroom.room_code]),
            {"file": SimpleUploadedFile(name, body, content_type="application/pdf")},
        )

    def test_upload_dispatches_a_job_and_converts_nothing_itself(self):
        with mock.patch("classrooms.views.dispatch") as dispatch, \
                mock.patch("classrooms.office_convert.convert_to_pdf") as convert:
            response = self._upload()
        self.assertEqual(response.status_code, 200)
        shared = SharedFile.objects.get(id=response.json()["id"])
        # the job was handed off with the file id, exactly once
        dispatch.assert_called_once()
        task, file_id = dispatch.call_args.args
        self.assertEqual(task.name, "classrooms.tasks.convert_office_file")
        self.assertEqual(file_id, shared.id)
        # and the request itself never invoked LibreOffice
        convert.assert_not_called()

    def test_response_reports_presentability_for_the_local_row(self):
        response = self._upload()
        self.assertEqual(response.status_code, 200)
        # a plain PDF is already presentable; the client uses this to render
        # the row without waiting for the broadcast
        self.assertIn("has_pdf", response.json())

    def test_upload_survives_a_broker_outage(self):
        """A broker that is down must not cost the user their upload.

        ``core.queue.dispatch`` falls back to running the job right there, so
        the request still succeeds (it just waits for the conversion).
        """
        task = convert_office_file._get_current_object()
        with mock.patch("core.queue._runs_inline", return_value=False), \
                mock.patch("classrooms.office_convert.convert_to_pdf",
                           return_value=False) as convert, \
                mock.patch.object(task, "apply_async",
                                  side_effect=ConnectionError("redis is down")):
            with self.assertLogs("core.queue", level="WARNING"):
                response = self._upload()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(SharedFile.objects.count(), 1)
        convert.assert_called_once()  # the fallback did the work in-process


class ConvertOfficeFileTaskTests(TestCase):
    """The job itself: idempotent, quiet on failure, tells the room."""

    def setUp(self):
        self.owner = make_user("q_task_owner")
        self.classroom = create_classroom(self.owner, title="Convert")
        self.shared = SharedFile.objects.create(
            classroom=self.classroom,
            uploader=self.owner,
            file=SimpleUploadedFile("deck.pptx", b"PK\x03\x04fake", content_type="application/vnd.ms-powerpoint"),
            original_name="deck.pptx",
            size=9,
            content_type="application/vnd.ms-powerpoint",
        )

    def test_successful_conversion_announces_the_presentable_file(self):
        with mock.patch("classrooms.office_convert.convert_to_pdf", return_value=True), \
                mock.patch("classrooms.services.broadcast") as broadcast:
            result = convert_office_file(self.shared.id)
        self.assertEqual(result, "converted")
        broadcast.assert_called_once()
        room_code, payload = broadcast.call_args.args
        self.assertEqual(room_code, self.classroom.room_code)
        self.assertEqual(payload["type"], "file_presentable")
        self.assertEqual(payload["file_id"], self.shared.id)
        self.assertTrue(payload["has_pdf"])

    def test_unknown_file_is_reported_not_raised(self):
        self.assertEqual(convert_office_file(999_999), "missing")

    def test_already_converted_file_is_not_converted_twice(self):
        SharedFile.objects.filter(pk=self.shared.pk).update(
            pdf_version="classrooms/files/deck.pdf"
        )
        with mock.patch("classrooms.office_convert.convert_to_pdf") as convert:
            self.assertEqual(convert_office_file(self.shared.id), "already-converted")
        convert.assert_not_called()

    def test_missing_libreoffice_is_a_quiet_skip(self):
        with mock.patch("classrooms.office_convert.convert_to_pdf", return_value=False), \
                mock.patch("classrooms.services.broadcast") as broadcast:
            self.assertEqual(convert_office_file(self.shared.id), "skipped")
        broadcast.assert_not_called()

    def test_a_crashing_conversion_never_escapes_the_job(self):
        with mock.patch("classrooms.office_convert.convert_to_pdf",
                        side_effect=RuntimeError("soffice exploded")):
            with self.assertLogs("classrooms.tasks", level="ERROR"):
                self.assertEqual(convert_office_file(self.shared.id), "failed")


class CloseStaleSessionsTaskTests(TestCase):
    """A session nobody ended must not stay LIVE forever."""

    def setUp(self):
        self.owner = make_user("s_owner")
        self.classroom = create_classroom(self.owner, title="Stale")

    def _live_session(self, started_hours_ago: float) -> ClassroomSession:
        return ClassroomSession.objects.create(
            classroom=self.classroom,
            host=self.owner,
            status=ClassroomSession.Status.LIVE,
            started_at=timezone.now() - timedelta(hours=started_hours_ago),
        )

    def test_only_forgotten_sessions_are_closed(self):
        forgotten = self._live_session(20)
        ongoing = self._live_session(1)
        member = ClassroomMember.objects.get(classroom=self.classroom, user=self.owner)
        attendance = AttendanceRecord.objects.create(
            session=forgotten, member=member, user=self.owner,
        )

        with mock.patch("classrooms.services.broadcast") as broadcast:
            closed = close_stale_sessions()

        self.assertEqual(closed, 1)
        forgotten.refresh_from_db()
        ongoing.refresh_from_db()
        self.assertEqual(forgotten.status, ClassroomSession.Status.ENDED)
        self.assertIsNotNone(forgotten.ended_at)
        self.assertEqual(ongoing.status, ClassroomSession.Status.LIVE)
        # attendance is closed with the session, like a manual end
        attendance.refresh_from_db()
        self.assertIsNotNone(attendance.left_at)
        self.assertEqual(broadcast.call_args.args[1]["type"], "session_ended")

    def test_zero_disables_the_job(self):
        self._live_session(500)
        self.assertEqual(close_stale_sessions(hours=0), 0)
        self.assertEqual(
            ClassroomSession.objects.filter(status=ClassroomSession.Status.LIVE).count(), 1
        )


class PruneStaleGuestsTaskTests(TestCase):
    """Throwaway guest rows are cleaned up; real memberships never are."""

    def setUp(self):
        self.owner = make_user("g_owner")
        self.classroom = create_classroom(self.owner, title="Guests")

    def _guest(self, *, active: bool, days_ago: int) -> ClassroomMember:
        member = join_classroom_guest(self.classroom, "مهمان")
        ClassroomMember.objects.filter(pk=member.pk).update(
            is_active=active, joined_at=timezone.now() - timedelta(days=days_ago),
        )
        return member

    def test_only_old_inactive_guests_are_removed(self):
        old_gone = self._guest(active=False, days_ago=30)
        old_connected = self._guest(active=True, days_ago=30)
        recent_gone = self._guest(active=False, days_ago=1)

        deleted = prune_stale_guests()

        self.assertEqual(deleted, 1)
        self.assertFalse(ClassroomMember.objects.filter(pk=old_gone.pk).exists())
        self.assertTrue(ClassroomMember.objects.filter(pk=old_connected.pk).exists())
        self.assertTrue(ClassroomMember.objects.filter(pk=recent_gone.pk).exists())

    def test_registered_members_are_never_pruned(self):
        member = join_classroom(self.classroom, make_user("g_student"))
        ClassroomMember.objects.filter(pk=member.pk).update(
            is_active=False, joined_at=timezone.now() - timedelta(days=365),
        )
        self.assertEqual(prune_stale_guests(), 0)
        self.assertTrue(ClassroomMember.objects.filter(pk=member.pk).exists())

    def test_zero_disables_the_job(self):
        guest = self._guest(active=False, days_ago=30)
        self.assertEqual(prune_stale_guests(days=0), 0)
        self.assertTrue(ClassroomMember.objects.filter(pk=guest.pk).exists())
