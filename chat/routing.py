"""WebSocket routes for the chat app."""
from django.urls import re_path

from . import consumers

websocket_urlpatterns = [
    re_path(r"ws/classroom/(?P<room_code>[\w-]+)/chat/$", consumers.ChatConsumer.as_asgi()),
]
