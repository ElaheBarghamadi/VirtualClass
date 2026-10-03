"""Regression tests for the fixes in this change set.

Each test targets a concrete defect that the suite did not cover:

* deleting a shared file also removed the LibreOffice-converted PDF
  (otherwise every converted Office upload leaked a copy onto the disk);
* ``attendance_summary`` issued two extra queries per participant;
* host-action endpoints could answer 500 on a malformed numeric field;
* quiz/assignment scoreboards showed blank names for accounts that only
  have a username (``get_full_name()`` is empty for them).
"""
import os
import tempfile

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from classrooms.models import ClassroomMember, SharedFile
from classrooms.services import (
    attendance_join,
    attendance_leave,
    attendance_summary,
    create_classroom,
    delete_shared_file,
    end_session,
    join_classroom,
    start_session,
)


User = get_user_model()

MEDIA_ROOT = tempfile.mkdtemp(prefix="classroom-tests-")


def make_user(username: str, **extra) -> User:
    return User.objects.create_user(
        username=username, password="testpass-123", email=f"{username}@x.com", **extra
    )


@override_settings(MEDIA_ROOT=MEDIA_ROOT)
class SharedFileCleanupTests(TestCase):
    """Storage hygiene: no file may outlive its database row."""

    def setUp(self):
        self.owner = make_user("clean_owner")
        self.classroom = create_classroom(self.owner, title="Cleanup")
        self.member = ClassroomMember.objects.get(classroom=self.classroom, user=self.owner)

    def _make_file(self, name: str, with_pdf: bool):
        shared = SharedFile.objects.create(
            classroom=self.classroom,
            uploader=self.owner,
            original_name=name,
            size=12,
            content_type="application/pdf",
        )
        shared.file.save(name, ContentFile(b"%PDF-1.4 body"), save=True)
        if with_pdf:
            shared.pdf_version.save(
                name.replace(".pptx", ".pdf"), ContentFile(b"%PDF-1.4 converted"), save=True
            )
        return shared

    def test_delete_removes_converted_pdf_too(self):
        shared = self._make_file("slides.pptx", with_pdf=True)
        original_path = shared.file.path
        pdf_path = shared.pdf_version.path
        self.assertTrue(os.path.exists(original_path))
        self.assertTrue(os.path.exists(pdf_path))

        delete_shared_file(self.classroom, self.member, shared.id)

        self.assertFalse(SharedFile.objects.filter(id=shared.id).exists())
        self.assertFalse(os.path.exists(original_path), "upload must be removed")
        self.assertFalse(os.path.exists(pdf_path), "converted PDF must not be orphaned")

    def test_delete_without_pdf_still_works(self):
        shared = self._make_file("notes.pdf", with_pdf=False)
        path = shared.file.path
        delete_shared_file(self.classroom, self.member, shared.id)
        self.assertFalse(os.path.exists(path))


class AttendanceSummaryTests(TestCase):
    def setUp(self):
        self.owner = make_user("att_owner")
        self.student = make_user("att_stu")
        self.classroom = create_classroom(self.owner, title="Attendance")
        self.student_member = join_classroom(self.classroom, self.student)
        self.owner_member = ClassroomMember.objects.get(classroom=self.classroom, user=self.owner)

    def test_multiple_intervals_are_summed(self):
        """A reconnect produces a second interval; both must be counted."""
        session = start_session(self.classroom, self.owner)
        intervals = []
        for seconds in (60, 30):
            record = attendance_join(self.classroom, self.student_member)
            attendance_leave(self.classroom, self.student_member)
            record.refresh_from_db()
            record.left_at = record.joined_at + timezone.timedelta(seconds=seconds)
            record.save(update_fields=["left_at"])
            intervals.append(record)

        summary = attendance_summary(session)
        row = next(r for r in summary if r["member_id"] == self.student_member.id)
        self.assertEqual(row["joins"], 2)
        self.assertEqual(row["total_seconds"], 90)
        self.assertEqual(row["username"], self.student_member.participant_name)

    def test_summary_uses_a_constant_number_of_queries(self):
        session = start_session(self.classroom, self.owner)
        attendance_join(self.classroom, self.student_member)
        attendance_join(self.classroom, self.owner_member)
        end_session(session, self.owner)

        with self.assertNumQueries(1):
            summary = attendance_summary(session)
        self.assertEqual(len(summary), 2)
        self.assertGreaterEqual(summary[0]["total_seconds"], 0)


class HostActionInputTests(TestCase):
    """Malformed JSON bodies must be clean 4xx — never an unhandled 500."""

    def setUp(self):
        self.owner = make_user("host_owner")
        self.student = make_user("host_stu")
        self.classroom = create_classroom(self.owner, title="Host")
        self.student_member = join_classroom(self.classroom, self.student)

    def _post(self, url, payload):
        self.client.force_login(self.owner)
        return self.client.post(url, data=payload, content_type="application/json")

    def test_remove_with_non_numeric_ban_is_400(self):
        url = reverse("room:member_remove", args=[self.classroom.room_code, self.student_member.id])
        resp = self._post(url, '{"ban_minutes": {"a": 1}}')
        self.assertEqual(resp.status_code, 400)

    def test_presentation_with_non_numeric_page_is_400(self):
        url = reverse("room:presentation", args=[self.classroom.room_code])
        resp = self._post(url, '{"file_id": null, "page": {"x": 1}}')
        self.assertEqual(resp.status_code, 400)

    def test_session_start_with_non_numeric_id_is_400(self):
        url = reverse("room:session_start", args=[self.classroom.room_code])
        resp = self._post(url, '{"session_id": {"x": 1}}')
        self.assertEqual(resp.status_code, 400)

    def test_broken_json_is_400(self):
        url = reverse("room:member_remove", args=[self.classroom.room_code, self.student_member.id])
        resp = self._post(url, "{not json")
        self.assertEqual(resp.status_code, 400)


class ParticipantNamingTests(TestCase):
    """Names come from ClassroomMember.participant_name, not get_full_name()."""

    def test_username_only_account_still_has_a_name(self):
        user = make_user("bare_user")  # no first_name / last_name
        self.assertEqual(user.get_full_name(), "")
        classroom = create_classroom(make_user("n_owner"), title="Names")
        member = join_classroom(classroom, user)
        self.assertEqual(member.participant_name, "bare_user")
