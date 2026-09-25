"""
ASGI entrypoint.

Routes HTTP traffic to Django and WebSocket traffic to Django Channels
consumers.  Redis (or the in-memory layer in development) is used as the
channel layer for cross-process messaging.
"""
import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

# get_asgi_application() must be called before importing anything that
# touches models, so keep this import below it.
django_asgi_app = get_asgi_application()

from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402

from chat.routing import websocket_urlpatterns as chat_ws  # noqa: E402
from classrooms.routing import websocket_urlpatterns as classroom_ws  # noqa: E402

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": AuthMiddlewareStack(
            URLRouter([*classroom_ws, *chat_ws])
        ),
    }
)
