"""Moderation + delivery tests for the exit-menu / kebab-menu round.

Security invariants covered here:

* only the OWNER can end the class for everyone — a moderator gets 403 and
  nothing changes;
* ending the class actually revokes access: every membership is deactivated,
  live stage state is cleared, and a member who reloads the room is sent back
  to the lobby (i.e. it is not a client-side illusion);
* "حذف" (remove) lets the member re-join, "اخراج" (ban) blocks re-entry until
  ``banned_until`` passes — enforced in the service layer, not the dialog;
* shared files are only *downloaded* when explicitly asked for: the
  presentation renderer fetches them inline, and non-previewable types can
  never be served inline.
"""
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.base import ContentFile
from django.test import Client, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from .models import ClassroomMember, SharedFile
from .permissions import Role
from .services import (
    ClassroomAccessError,
    PermissionDenied,
    UserBanned,
    create_classroom,
    end_classroom_for_all,
    join_classroom,
    remove_member,
    set_member_role,
    start_session,
)

User = get_user_model()
PASSWORD = "testpass-123"


def make_user(username: str) -> User:
    return User.objects.create_user(username=username, password=PASSWORD, email=f"{username}@x.com")


@override_settings(ALLOWED_HOSTS=["testserver"])
class EndClassForEveryoneTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("ec_owner")
        self.student = make_user("ec_student")
        self.classroom = create_classroom(self.owner, title="Ending")
        self.owner_member = join_classroom(self.classroom, self.owner)
        self.student_member = join_classroom(self.classroom, self.student)
        self.client = Client()
        self.client.force_login(self.owner)

    def _url(self):
        return reverse("room:end_class", kwargs={"room_code": self.classroom.room_code})

    def test_owner_ends_and_everyone_is_removed(self):
        session = start_session(self.classroom, self.owner)
        self.classroom.current_file = None
        self.classroom.whiteboard_open = True
        self.classroom.save(update_fields=["whiteboard_open"])

        response = self.client.post(self._url())

        self.assertEqual(response.status_code, 200)
        self.classroom.refresh_from_db()
        self.assertFalse(self.classroom.whiteboard_open)
        self.assertIsNone(self.classroom.current_file)
        self.assertFalse(
            ClassroomMember.objects.filter(classroom=self.classroom, is_active=True).exists()
        )
        session.refresh_from_db()
        self.assertEqual(session.status, session.Status.ENDED)
        self.assertIsNotNone(session.ended_at)

    def test_ended_room_redirects_member_to_lobby(self):
        end_classroom_for_all(self.classroom, self.owner)
        member_client = Client()
        member_client.force_login(self.student)
        response = member_client.get(
            reverse("room:room", kwargs={"room_code": self.classroom.room_code})
        )
        self.assertEqual(response.status_code, 302)
        self.assertEqual(
            response.url, reverse("room:lobby", kwargs={"room_code": self.classroom.room_code})
        )

    def test_moderator_cannot_end_the_class(self):
        moderator = make_user("ec_mod")
        join_classroom(self.classroom, moderator)
        set_member_role(
            self.classroom, self.owner, ClassroomMember.objects.get(classroom=self.classroom, user=moderator).id,
            Role.MODERATOR,
        )
        mod_client = Client()
        mod_client.force_login(moderator)

        response = mod_client.post(self._url())

        self.assertEqual(response.status_code, 403)
        self.assertTrue(
            ClassroomMember.objects.filter(classroom=self.classroom, is_active=True).exists()
        )

    def test_anonymous_cannot_end_the_class(self):
        response = Client().post(self._url())
        self.assertIn(response.status_code, (302, 403))
        self.assertTrue(
            ClassroomMember.objects.filter(classroom=self.classroom, is_active=True).exists()
        )

    def test_owner_can_reopen_the_class_later(self):
        end_classroom_for_all(self.classroom, self.owner)
        # the classroom itself is untouched — only this meeting ended
        self.classroom.refresh_from_db()
        self.assertTrue(self.classroom.is_active)
        member = join_classroom(self.classroom, self.student)
        self.assertTrue(member.is_active)


@override_settings(ALLOWED_HOSTS=["testserver"])
class KickVersusBanTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("kb_owner")
        self.student = make_user("kb_student")
        self.classroom = create_classroom(self.owner, title="Moderation")
        join_classroom(self.classroom, self.owner)
        self.member = join_classroom(self.classroom, self.student)

    def test_kick_allows_rejoin(self):
        remove_member(self.classroom, self.owner, self.member.id, ban_minutes=0)
        rejoined = join_classroom(self.classroom, self.student)
        self.assertTrue(rejoined.is_active)

    def test_ban_blocks_rejoin_until_it_expires(self):
        remove_member(self.classroom, self.owner, self.member.id, ban_minutes=60)
        with self.assertRaises(UserBanned):
            join_classroom(self.classroom, self.student)

        ClassroomMember.objects.filter(id=self.member.id).update(
            banned_until=timezone.now() - timedelta(minutes=1)
        )
        rejoined = join_classroom(self.classroom, self.student)
        self.assertTrue(rejoined.is_active)
        self.assertIsNone(rejoined.banned_until)

    def test_ban_duration_is_validated(self):
        with self.assertRaises(ValueError):
            remove_member(self.classroom, self.owner, self.member.id, ban_minutes=10**6)

    def test_student_cannot_ban_another_member(self):
        other = make_user("kb_other")
        other_member = join_classroom(self.classroom, other)
        with self.assertRaises(PermissionDenied):
            remove_member(self.classroom, self.student, other_member.id, ban_minutes=60)

    def test_remove_of_unknown_member_is_rejected(self):
        with self.assertRaises(ClassroomAccessError):
            remove_member(self.classroom, self.owner, 999999, ban_minutes=0)


@override_settings(ALLOWED_HOSTS=["testserver"])
class FileDeliveryTests(TestCase):
    def setUp(self):
        cache.clear()
        self.owner = make_user("fd_owner")
        self.classroom = create_classroom(self.owner, title="Files")
        join_classroom(self.classroom, self.owner)
        self.shared = SharedFile.objects.create(
            classroom=self.classroom,
            uploader=self.owner,
            original_name="slides.pdf",
            size=4,
            file=ContentFile(b"%PDF", name="slides.pdf"),
        )
        self.client = Client()
        self.client.force_login(self.owner)

    def _url(self, **params):
        url = reverse(
            "room:file_download",
            kwargs={"room_code": self.classroom.room_code, "file_id": self.shared.id},
        )
        if params:
            url += "?" + "&".join(f"{k}={v}" for k, v in params.items())
        return url

    def test_download_is_an_attachment(self):
        response = self.client.get(self._url())
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response.headers["Content-Disposition"])

    def test_inline_preview_is_not_a_download(self):
        response = self.client.get(self._url(inline=1))
        self.assertEqual(response.status_code, 200)
        self.assertIn("inline", response.headers["Content-Disposition"])
        self.assertEqual(response.headers["Content-Type"], "application/pdf")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")

    def test_non_previewable_type_is_never_inline(self):
        self.shared.original_name = "notes.html"
        self.shared.file = ContentFile(b"<script>alert(1)</script>", name="notes.html")
        self.shared.save(update_fields=["original_name", "file"])
        response = self.client.get(self._url(inline=1))
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response.headers["Content-Disposition"])

    def test_non_member_cannot_fetch_the_file(self):
        outsider = make_user("fd_outsider")
        client = Client()
        client.force_login(outsider)
        response = client.get(self._url(inline=1))
        self.assertIn(response.status_code, (403, 404))
