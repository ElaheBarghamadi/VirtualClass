"""WebSocket routes for the whiteboard app."""
from django.urls import re_path

from . import consumers

websocket_urlpatterns = [
    re_path(r"ws/classroom/(?P<room_code>[\w-]+)/whiteboard/$", consumers.WhiteboardConsumer.as_asgi()),
]
