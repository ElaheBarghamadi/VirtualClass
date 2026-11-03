"""Authorization sweep over the REST API.

The HTML views are the product; `/api/` is the seam for programmatic clients.
Because it is a second front door to the same services, it gets its own, wide
authorization test: every classroom-scoped route must reject an anonymous
caller (401) and a signed-in outsider who is not a member of that class (403),
no matter which verbs it exposes.
"""
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from .models import ClassroomSession
from .services import create_classroom, join_classroom

User = get_user_model()
PASSWORD = "testpass-123"


class ApiAuthorizationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user("api-owner", password=PASSWORD)
        cls.student = User.objects.create_user("api-student", password=PASSWORD)
        cls.outsider = User.objects.create_user("api-outsider", password=PASSWORD)
        cls.classroom = create_classroom(owner=cls.owner, title="کلاس API")
        join_classroom(cls.classroom, cls.student)
        cls.session = ClassroomSession.objects.create(
            classroom=cls.classroom, host=cls.owner, title="جلسه"
        )

    def _urls(self):
        code = self.classroom.room_code
        return {
            "detail": (reverse("api_classroom_detail", args=[code]), "get"),
            "participants": (reverse("api_classroom_participants", args=[code]), "get"),
            "participant_update": (
                reverse("api_participant_update", args=[code, 1]),
                "patch",
            ),
            "sessions": (reverse("api_classroom_sessions", args=[code]), "get"),
            "session_start": (
                reverse("api_session_action", args=[code, self.session.id, "start"]),
                "post",
            ),
            "messages": (reverse("api_classroom_messages", args=[code]), "get"),
            "files": (reverse("api_classroom_files", args=[code]), "get"),
            "attendance": (reverse("api_classroom_attendance", args=[code]), "get"),
        }

    def test_anonymous_is_rejected_everywhere(self):
        for name, (url, verb) in self._urls().items():
            with self.subTest(route=name):
                response = getattr(self.client, verb)(url, {}, content_type="application/json")
                self.assertIn(
                    response.status_code,
                    (401, 403),
                    f"{name} let an anonymous caller in ({response.status_code})",
                )

    def test_outsider_gets_403_on_every_classroom_route(self):
        self.client.force_login(self.outsider)
        for name, (url, verb) in self._urls().items():
            with self.subTest(route=name):
                response = getattr(self.client, verb)(url, {}, content_type="application/json")
                self.assertIn(
                    response.status_code,
                    (403, 404),
                    f"{name} leaked to a non-member ({response.status_code})",
                )

    def test_outsider_never_sees_another_users_classroom(self):
        self.client.force_login(self.outsider)
        response = self.client.get(reverse("api_classroom_detail", args=[self.classroom.room_code]))
        self.assertEqual(response.status_code, 404)

    def test_student_can_read_but_not_moderate(self):
        self.client.force_login(self.student)
        code = self.classroom.room_code
        self.assertEqual(self.client.get(reverse("api_classroom_participants", args=[code])).status_code, 200)
        self.assertEqual(self.client.get(reverse("api_classroom_messages", args=[code])).status_code, 200)
        # attendance and participant edits are privileged-only
        self.assertEqual(self.client.get(reverse("api_classroom_attendance", args=[code])).status_code, 403)
        self.assertEqual(
            self.client.patch(
                reverse("api_participant_update", args=[code, 1]),
                {"role": "moderator"},
                content_type="application/json",
            ).status_code,
            403,
        )

    def test_student_cannot_schedule_or_start_a_session(self):
        self.client.force_login(self.student)
        code = self.classroom.room_code
        self.assertEqual(
            self.client.post(reverse("api_classroom_sessions", args=[code]), {}, content_type="application/json").status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                reverse("api_session_action", args=[code, self.session.id, "start"]),
                {},
                content_type="application/json",
            ).status_code,
            403,
        )

    def test_unknown_member_patch_is_404_not_500(self):
        self.client.force_login(self.owner)
        response = self.client.patch(
            reverse("api_participant_update", args=[self.classroom.room_code, 999999]),
            {"role": "moderator"},
            content_type="application/json",
        )
        self.assertIn(response.status_code, (400, 404))

    def test_waiting_room_member_is_not_admitted(self):
        wait_classroom = create_classroom(
            owner=self.owner, title="کلاس انتظار", settings={"enable_waiting_room": True}
        )
        join_classroom(wait_classroom, self.student)
        self.client.force_login(self.student)
        response = self.client.get(reverse("api_classroom_messages", args=[wait_classroom.room_code]))
        self.assertEqual(response.status_code, 403)
