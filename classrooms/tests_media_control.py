"""SFU-side revocation: removing, muting and closing the room for real.

Django could revoke a permission in the database while the browser kept its
already-attached LiveKit tracks, so a removed or muted student stayed audible
until the token expired.  These tests drive the control calls that close that
gap, with a fake livekit SDK (no network, no server needed).
"""
from types import SimpleNamespace
from unittest import mock

from asgiref.sync import async_to_sync
from django.test import TestCase, override_settings

from accounts.models import User
from classrooms import media
from classrooms.permissions import Role
from classrooms.services import (
    create_classroom,
    deactivate_classroom,
    join_classroom,
    mute_all,
    remove_member,
    set_member_muted,
    set_member_permission,
)

LIVEKIT_SETTINGS = dict(
    LIVEKIT_URL="https://livekit.example.com",
    LIVEKIT_API_KEY="APItestkey123",
    LIVEKIT_API_SECRET="secret_at_least_32_chars_long_value!!",
)


class FakeRoomService:
    def __init__(self):
        self.calls = []
        self.participants = [
            SimpleNamespace(
                identity="u:1",
                tracks=[SimpleNamespace(sid="TR_audio", type=0), SimpleNamespace(sid="TR_video", type=1)],
            ),
            SimpleNamespace(identity="u:2", tracks=[SimpleNamespace(sid="TR_audio2", type=0)]),
        ]

    async def delete_room(self, request):
        self.calls.append(("delete_room", request))

    async def remove_participant(self, request):
        self.calls.append(("remove_participant", request))

    async def list_participants(self, request):
        self.calls.append(("list_participants", request))
        return SimpleNamespace(participants=self.participants)

    async def mute_published_track(self, request):
        self.calls.append(("mute_published_track", request))


class FakeAPI:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.room = FakeRoomService()
        self.closed = False

    async def aclose(self):
        self.closed = True


def fake_livekit(api: FakeAPI):
    return SimpleNamespace(
        LiveKitAPI=lambda **kwargs: api,
        DeleteRoomRequest=lambda **kw: SimpleNamespace(**kw),
        RoomParticipantIdentity=lambda **kw: SimpleNamespace(**kw),
        ListParticipantsRequest=lambda **kw: SimpleNamespace(**kw),
        MuteRoomTrackRequest=lambda **kw: SimpleNamespace(**kw),
    )


@override_settings(**LIVEKIT_SETTINGS)
class MediaControlTests(TestCase):
    def _run(self, action, room="classroom_abc", identity="u:1"):
        api = FakeAPI()
        with mock.patch.object(media, "livekit_api", fake_livekit(api)):
            async_to_sync(media.apply_media_control)(action, room, identity)
        return api

    def test_remove_participant(self):
        api = self._run("remove", room="classroom_abc", identity="u:7")
        kind, request = api.room.calls[-1]
        self.assertEqual(kind, "remove_participant")
        self.assertEqual((request.room, request.identity), ("classroom_abc", "u:7"))
        self.assertTrue(api.closed, "the SDK client must be closed")

    def test_mute_audio_only_touches_microphones(self):
        api = self._run("mute_audio", identity="u:1")
        muted = [c for c in api.room.calls if c[0] == "mute_published_track"]
        self.assertEqual([c[1].track_sid for c in muted], ["TR_audio"])
        self.assertTrue(all(c[1].muted for c in muted))

    def test_mute_video_only_touches_cameras(self):
        api = self._run("mute_video", identity="u:1")
        muted = [c for c in api.room.calls if c[0] == "mute_published_track"]
        self.assertEqual([c[1].track_sid for c in muted], ["TR_video"])

    def test_mute_all_covers_every_participant(self):
        api = self._run("mute_all")
        muted = {c[1].track_sid for c in api.room.calls if c[0] == "mute_published_track"}
        self.assertEqual(muted, {"TR_audio", "TR_audio2"})

    def test_end_room(self):
        api = self._run("end_room", room="classroom_abc")
        kind, request = api.room.calls[-1]
        self.assertEqual((kind, request.room), ("delete_room", "classroom_abc"))


@override_settings(**LIVEKIT_SETTINGS)
class DispatchTests(TestCase):
    def test_dispatch_is_a_noop_without_a_media_server(self):
        with override_settings(LIVEKIT_URL="", LIVEKIT_API_KEY="", LIVEKIT_API_SECRET=""):
            with mock.patch.object(media, "apply_media_control") as control:
                media._dispatch("remove", "classroom_abc", "u:1")
                control.assert_not_called()

    def test_dispatch_runs_in_the_background(self):
        api = FakeAPI()
        with mock.patch.object(media, "livekit_api", fake_livekit(api)):
            with mock.patch.object(media, "apply_media_control") as control:
                control.return_value = None
                media._dispatch("remove", "classroom_abc", "u:1")
                for thread in __import__("threading").enumerate():
                    if thread.name.startswith("livekit-"):
                        thread.join(timeout=2)
                control.assert_called_once()


@override_settings(**LIVEKIT_SETTINGS)
class ServiceRevocationTests(TestCase):
    """The host actions must reach the SFU, not only the database."""

    def setUp(self):
        self.owner = User.objects.create_user(username="mc_owner", password="x")
        self.student = User.objects.create_user(username="mc_student", password="x")
        self.classroom = create_classroom(self.owner, title="Media control")
        self.member = join_classroom(self.classroom, self.student)

    def test_removal_drops_the_participant_from_the_sfu(self):
        with mock.patch.object(media, "revoke_participant") as revoke:
            remove_member(self.classroom, self.owner, self.member.id)
        revoke.assert_called_once()
        args = revoke.call_args.args
        self.assertEqual(args[0], self.classroom)
        self.assertEqual(args[1].identity, self.member.identity)

    def test_mute_reaches_the_sfu_but_unmute_does_not(self):
        with mock.patch.object(media, "mute_participant") as mute:
            set_member_muted(self.classroom, self.owner, self.member.id, True)
        # An ungranted student publishes nothing, so the re-sync silences both
        # sources; the mute itself is the audio one.
        sources = [call.kwargs.get("source") for call in mute.call_args_list]
        self.assertIn("audio", sources)
        with mock.patch.object(media, "mute_participant") as mute:
            set_member_muted(self.classroom, self.owner, self.member.id, False)
        mute.assert_not_called()

    def test_revoking_the_microphone_mutes_the_microphone(self):
        set_member_permission(self.classroom, self.owner, self.member.id, "can_use_microphone", True)
        with mock.patch.object(media, "mute_participant") as mute:
            set_member_permission(
                self.classroom, self.owner, self.member.id, "can_use_microphone", False
            )
        sources = [call.kwargs.get("source") for call in mute.call_args_list]
        self.assertIn("audio", sources)

    def test_revoking_the_camera_mutes_the_camera(self):
        set_member_permission(self.classroom, self.owner, self.member.id, "can_use_camera", True)
        with mock.patch.object(media, "mute_participant") as mute:
            set_member_permission(
                self.classroom, self.owner, self.member.id, "can_use_camera", False
            )
        sources = [call.kwargs.get("source") for call in mute.call_args_list]
        self.assertIn("video", sources)

    def test_mute_all_reaches_the_sfu(self):
        with mock.patch.object(media, "mute_all_participants") as mute_all_sfu:
            mute_all(self.classroom, self.owner)
        mute_all_sfu.assert_called_once_with(self.classroom)

    def test_deactivation_closes_the_room(self):
        with mock.patch.object(media, "end_room") as end:
            deactivate_classroom(self.classroom, self.owner)
        end.assert_called_once()
