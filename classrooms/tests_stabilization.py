"""Security regression tests for private files and admission boundaries."""
import json
import tempfile
from pathlib import Path
from datetime import timedelta

from asgiref.sync import async_to_sync, sync_to_async
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from assignments.models import Assignment, Submission
from classrooms.models import ClassroomMember, ClassroomSession, SharedFile
from classrooms.permissions import Role
from classrooms.routing import websocket_urlpatterns
from classrooms.services import create_classroom, join_classroom, start_session, end_session, remove_member

User = get_user_model()


class PrivateAndWaitingTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings_override = override_settings(PRIVATE_MEDIA_ROOT=Path(self.temp.name) / 'private')
        self.settings_override.enable()
        self.owner = User.objects.create_user(username='owner')
        self.student = User.objects.create_user(username='student')
        self.other = User.objects.create_user(username='other')
        self.room = create_classroom(self.owner, 'Room')
        self.member = join_classroom(self.room, self.student)
        self.other_member = join_classroom(self.room, self.other)
        self.assignment = Assignment.objects.create(classroom=self.room, title='HW', due_at=timezone.now()+timedelta(days=1))
        self.submission = Submission.objects.create(assignment=self.assignment, member=self.member,
                                                    file=ContentFile(b'private', name='answer.pdf'))
        self.shared = SharedFile.objects.create(classroom=self.room, uploader=self.owner,
                                                file=ContentFile(b'%PDF-1.4 test', name='lecture.pdf'),
                                                original_name='lecture.pdf', size=13, content_type='application/pdf')

    def tearDown(self):
        self.settings_override.disable()
        self.temp.cleanup()

    def submission_url(self, room=None, assignment=None, submission=None):
        return reverse('assignments_manage:submission_download', args=[room or self.room.room_code,
            assignment or self.assignment.id, submission or self.submission.id])

    def shared_url(self, room=None, file_id=None):
        return reverse('room:file_download', args=[room or self.room.room_code, file_id or self.shared.id])

    def test_submission_download_owner_and_author_only(self):
        self.assertEqual(self.client.get(self.submission_url()).status_code, 302)
        for user in (self.owner, self.student):
            self.client.force_login(user)
            response = self.client.get(self.submission_url())
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response['Cache-Control'], 'private, no-store')
            self.assertEqual(response['X-Content-Type-Options'], 'nosniff')
            self.assertEqual(b''.join(response.streaming_content), b'private')
        self.client.force_login(self.other)
        self.assertEqual(self.client.get(self.submission_url()).status_code, 404)
        self.assertEqual(self.client.get(self.submission_url(submission=self.submission.id + 100)).status_code, 404)
        self.client.force_login(self.student)
        self.submission.file.delete(save=False)
        self.assertEqual(self.client.get(self.submission_url()).status_code, 404)
        self.submission.file = None; self.submission.save()
        self.assertEqual(self.client.get(self.submission_url()).status_code, 404)

    def test_shared_download_and_cross_room_idor(self):
        self.assertEqual(self.client.get(self.shared_url()).status_code, 404)
        self.client.force_login(self.student)
        response = self.client.get(self.shared_url())
        self.assertEqual(response.status_code, 200)
        response.close()
        other_room = create_classroom(self.other, 'Other')
        join_classroom(other_room, self.student)
        self.assertEqual(self.client.get(self.shared_url(room=other_room.room_code)).status_code, 404)
        self.assertEqual(self.client.get(self.shared_url(file_id=self.shared.id + 100)).status_code, 404)
        self.shared.file.delete(save=False)
        self.assertEqual(self.client.get(self.shared_url()).status_code, 404)
        deleted_url = self.shared_url()
        self.shared.delete()
        self.assertEqual(self.client.get(deleted_url).status_code, 404)

    def test_private_files_have_no_public_url(self):
        with self.assertRaises(ValueError):
            self.submission.file.url
        with self.assertRaises(ValueError):
            self.shared.file.url
        self.assertEqual(self.client.get('/media/' + self.submission.file.name).status_code, 404)
        self.assertEqual(self.client.get('/media/' + self.shared.file.name).status_code, 404)

    def test_public_logo_remains_accessible_in_debug(self):
        self.room.logo.save('public-logo.png', ContentFile(b'public-logo'))
        try:
            from django.test import RequestFactory
            from django.conf import settings
            from django.views.static import serve
            response = serve(RequestFactory().get(self.room.logo.url),
                             self.room.logo.name.removeprefix("classroom_logos/"),
                             document_root=settings.MEDIA_ROOT / "classroom_logos")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(b''.join(response.streaming_content), b'public-logo')
        finally:
            self.room.logo.delete(save=False)

    def test_waiting_cannot_access_assignments_upload_or_detail_api(self):
        self.member.in_waiting_room = True
        self.member.can_upload_files = True
        self.member.save()
        self.client.force_login(self.student)
        self.assertEqual(self.client.get(self.submission_url()).status_code, 404)
        self.assertEqual(self.client.get(reverse('assignments_manage:list', args=[self.room.room_code])).status_code, 404)
        self.assertEqual(self.client.get(reverse('assignments_manage:detail', args=[self.room.room_code,self.assignment.id])).status_code, 404)
        self.assertEqual(self.client.post(reverse('room:file_upload', args=[self.room.room_code])).status_code, 403)
        api = APIClient(); api.force_authenticate(self.student)
        self.assertEqual(api.get(f'/api/classrooms/{self.room.room_code}/').status_code, 404)
        self.assertEqual(api.get(f'/api/classrooms/{self.room.room_code}/files/').status_code, 403)

    def test_approval_rejection_and_revoked_moderator(self):
        self.member.in_waiting_room = True; self.member.save()
        url = reverse('room:waiting_action', args=[self.room.room_code, self.member.id])
        for user in (self.student, self.other):
            self.client.force_login(user)
            for value in (True, False):
                self.assertEqual(self.client.post(url, json.dumps({'approve': value}), content_type='application/json').status_code, 403)
        self.other_member.role = Role.MODERATOR; self.other_member.save()
        self.client.force_login(self.other)
        self.assertEqual(self.client.post(url, json.dumps({'approve': True}), content_type='application/json').status_code, 200)
        self.assertEqual(self.client.post(url, json.dumps({'approve': True}), content_type='application/json').status_code, 400)
        self.member.refresh_from_db(); self.assertFalse(self.member.in_waiting_room)
        self.member.in_waiting_room = True; self.member.save()
        self.other_member.is_active = False; self.other_member.save()
        self.assertEqual(self.client.post(url, json.dumps({'approve': False}), content_type='application/json').status_code, 403)

    @override_settings(LIVEKIT_URL="https://livekit.example.test", LIVEKIT_API_KEY="test-key",
                       LIVEKIT_API_SECRET="only-a-test-secret-which-is-at-least-32-bytes")
    def test_removed_or_waiting_member_cannot_obtain_new_media_token(self):
        url = reverse('room:media_token', args=[self.room.room_code])
        self.assertEqual(self.client.get(url).status_code, 403)
        self.client.force_login(self.student)
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertIn('no-store', response['Cache-Control'])
        self.member.in_waiting_room = True; self.member.save()
        self.assertEqual(self.client.get(url).status_code, 403)
        self.member.in_waiting_room = False; self.member.save()
        remove_member(self.room, self.owner, self.member.id)
        self.assertEqual(self.client.get(url).status_code, 403)

    def test_restarting_ended_session_rejected(self):
        session = start_session(self.room, self.owner)
        end_session(session, self.owner)
        self.client.force_login(self.owner)
        result = self.client.post(reverse('room:session_start', args=[self.room.room_code]),
                                  json.dumps({'session_id': session.id}), content_type='application/json')
        self.assertEqual(result.status_code, 404)
        session.refresh_from_db(); self.assertEqual(session.status, ClassroomSession.Status.ENDED)


class WaitingEventTests(TransactionTestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username='ws_owner')
        self.student = User.objects.create_user(username='ws_student')
        self.late = User.objects.create_user(username='ws_late')
        self.room = create_classroom(self.owner, 'WS')
        join_classroom(self.room, self.student)
        self.room.enable_waiting_room = True; self.room.save()

    def ws(self, user):
        app = URLRouter(websocket_urlpatterns)
        async def wrapped(scope, receive, send):
            scope = dict(scope, user=user, session={})
            await app(scope, receive, send)
        return WebsocketCommunicator(wrapped, f'/ws/classroom/{self.room.room_code}/')

    def test_waiting_entry_sent_to_host_but_not_student(self):
        async def scenario():
            owner = self.ws(self.owner); student = self.ws(self.student)
            assert (await owner.connect())[0]
            await owner.receive_json_from(); await owner.receive_json_from()
            assert (await student.connect())[0]
            await student.receive_json_from(); await student.receive_json_from()
            await owner.receive_json_from()
            await sync_to_async(join_classroom)(self.room, self.late)
            event = await owner.receive_json_from(timeout=3)
            assert event['type'] == 'waiting_room_entry'
            assert await student.receive_nothing(timeout=0.3)
            waiting = self.ws(self.late)
            assert (await waiting.connect())[0]
            await waiting.send_json_to({'action': 'approve', 'member_id': event['participant']['member_id']})
            await waiting.send_json_to({'action': 'ping'})
            assert (await waiting.receive_json_from())['type'] == 'pong'
            still_waiting = await sync_to_async(ClassroomMember.objects.get)(classroom=self.room, user=self.late)
            assert still_waiting.in_waiting_room
            await waiting.disconnect()
            await student.disconnect(); await owner.disconnect()
        async_to_sync(scenario)()
