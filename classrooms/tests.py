"""Tests for classrooms: HTTP flows, models, permissions and API."""
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from rest_framework.test import APIClient

from .models import Classroom, ClassroomMember
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
