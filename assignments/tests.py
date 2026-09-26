"""Tests for assignments: authoring, submitting, grading, access control."""
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from classrooms.models import ClassroomMember
from classrooms.permissions import Role
from classrooms.services import create_classroom

from .models import Assignment, Submission

User = get_user_model()


def make_user(username: str):
    return User.objects.create_user(
        username=username, password="Pass-12345",
        first_name=username, email=f"{username}@ex.com",
    )


class AssignmentTests(TestCase):
    def setUp(self):
        self.owner = make_user("a_owner")
        self.student = make_user("a_stu")
        self.classroom = create_classroom(self.owner, title="HW room")
        self.member = ClassroomMember.objects.create(
            classroom=self.classroom, user=self.student, role=Role.STUDENT,
        )
        self.assignment = Assignment.objects.create(
            classroom=self.classroom, title="تمرین ۱",
            description="حل مسائل صفحهٔ ۱۰",
            due_at=timezone.now() + timedelta(days=2),
            max_score=20, created_by=self.owner,
        )

    def _list_url(self):
        return reverse("assignments_manage:list", args=[self.classroom.room_code])

    def _detail_url(self):
        return reverse("assignments_manage:detail",
                       args=[self.classroom.room_code, self.assignment.id])

    def test_outsider_gets_404(self):
        self.client.force_login(make_user("a_out"))
        self.assertEqual(self.client.get(self._list_url()).status_code, 404)
        self.assertEqual(self.client.get(self._detail_url()).status_code, 404)

    def test_member_sees_list_but_no_create_form_effect(self):
        self.client.force_login(self.student)
        resp = self.client.get(self._list_url())
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, "تمرین ۱")
        # student POST must not create
        before = Assignment.objects.count()
        self.client.post(self._list_url(), {
            "title": "هک", "due_at": "2030-01-01T10:00", "max_score": "20",
        })
        self.assertEqual(Assignment.objects.count(), before)

    def test_owner_creates_assignment(self):
        self.client.force_login(self.owner)
        resp = self.client.post(self._list_url(), {
            "title": "تمرین ۲", "description": "", "max_score": "10",
            "due_at": (timezone.now() + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M"),
        })
        self.assertEqual(resp.status_code, 302)
        self.assertTrue(Assignment.objects.filter(title="تمرین ۲", max_score=10).exists())

    def test_owner_create_requires_due(self):
        self.client.force_login(self.owner)
        self.client.post(self._list_url(), {"title": "بدون مهلت", "due_at": "", "max_score": "5"})
        self.assertFalse(Assignment.objects.filter(title="بدون مهلت").exists())

    def test_student_submit_and_edit(self):
        self.client.force_login(self.student)
        resp = self.client.post(self._detail_url(), {"content": "پاسخ من"})
        self.assertEqual(resp.status_code, 302)
        sub = Submission.objects.get(assignment=self.assignment, member=self.member)
        self.assertEqual(sub.content, "پاسخ من")
        # edit before grading
        self.client.post(self._detail_url(), {"content": "پاسخ ویرایش‌شده"})
        sub.refresh_from_db()
        self.assertEqual(sub.content, "پاسخ ویرایش‌شده")
        self.assertEqual(Submission.objects.count(), 1)

    def test_empty_submit_rejected(self):
        self.client.force_login(self.student)
        self.client.post(self._detail_url(), {"content": "   "})
        self.assertEqual(Submission.objects.count(), 0)

    def test_submit_after_due_rejected(self):
        self.assignment.due_at = timezone.now() - timedelta(hours=1)
        self.assignment.save(update_fields=["due_at"])
        self.client.force_login(self.student)
        self.client.post(self._detail_url(), {"content": "دیر رسید"})
        self.assertEqual(Submission.objects.count(), 0)

    def test_grading_flow_and_lock(self):
        Submission.objects.create(assignment=self.assignment, member=self.member,
                                  content="پاسخ")
        self.client.force_login(self.owner)
        # out-of-range score is refused
        self.client.post(self._detail_url(), {
            "grade_submission": str(Submission.objects.get().id),
            "score": "99", "feedback": "",
        })
        self.assertIsNone(Submission.objects.get().score)
        # valid grade
        self.client.post(self._detail_url(), {
            "grade_submission": str(Submission.objects.get().id),
            "score": "17.5", "feedback": "آفرین",
        })
        sub = Submission.objects.get()
        self.assertEqual(float(sub.score), 17.5)
        self.assertEqual(sub.feedback, "آفرین")
        self.assertIsNotNone(sub.graded_at)
        # graded submission is locked for the student
        self.client.force_login(self.student)
        self.client.post(self._detail_url(), {"content": "تلاش دوباره"})
        sub.refresh_from_db()
        self.assertEqual(sub.content, "پاسخ")

    def test_student_cannot_grade(self):
        sub = Submission.objects.create(assignment=self.assignment,
                                        member=self.member, content="x")
        self.client.force_login(self.student)
        self.client.post(self._detail_url(), {
            "grade_submission": str(sub.id), "score": "20", "feedback": "",
        })
        sub.refresh_from_db()
        self.assertIsNone(sub.score)

    def test_owner_deletes_assignment(self):
        self.client.force_login(self.owner)
        self.client.post(self._list_url(), {"delete_assignment": str(self.assignment.id)})
        self.assertFalse(Assignment.objects.filter(id=self.assignment.id).exists())
