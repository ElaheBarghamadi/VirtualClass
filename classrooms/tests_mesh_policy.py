from unittest.mock import AsyncMock

from asgiref.sync import async_to_sync
from django.test import SimpleTestCase, override_settings

from classrooms.consumers import ClassroomConsumer
from classrooms.media import media_config_payload


class MeshPolicyTests(SimpleTestCase):
    @override_settings(MESH_ENABLED=False)
    def test_disabled_mesh_blocks_rtc_relay(self):
        consumer = ClassroomConsumer()
        consumer._member_active_now = AsyncMock(return_value=True)
        consumer._relay_rtc_signal = AsyncMock()
        consumer.send_json = AsyncMock()
        async_to_sync(consumer.receive_json)({'action': 'rtc_signal', 'to_member_id': 1, 'data': {}})
        consumer._relay_rtc_signal.assert_not_awaited()
        consumer.send_json.assert_awaited_once()
        self.assertFalse(media_config_payload()['mesh_enabled'])

    @override_settings(MESH_ENABLED=True)
    def test_enabled_mesh_relays_valid_signal(self):
        consumer = ClassroomConsumer()
        consumer._member_active_now = AsyncMock(return_value=True)
        consumer._relay_rtc_signal = AsyncMock()
        async_to_sync(consumer.receive_json)({'action': 'rtc_signal', 'to_member_id': 1, 'data': {'sdp': 'test'}})
        consumer._relay_rtc_signal.assert_awaited_once_with(1, {'sdp': 'test'})
