"""Whiteboard app configuration + the deployment checks that keep the
real-time parts honest.

The single most confusing failure this app can have is a *silent* one: with the
in-memory channel layer every socket lives inside one worker process, so a class
spread over two workers sees one another's strokes late or not at all — while
the board itself looks perfectly healthy.  ``manage.py check`` now says so.
"""
from django.apps import AppConfig
from django.core.checks import Warning as DjangoWarning, register


@register()
def realtime_layer_check(app_configs, **kwargs):
    """Warn when real-time traffic runs on a layer that cannot cross processes."""
    from channels.layers import get_channel_layer

    issues = []
    layer = get_channel_layer()
    if layer is None:
        return issues
    backend = f"{type(layer).__module__}.{type(layer).__name__}"
    if "InMemory" in backend:
        issues.append(DjangoWarning(
            "The default channel layer is in-memory: WebSocket broadcasts "
            "(whiteboard, chat, presence, WebRTC signalling) only reach sockets "
            "inside this single process.",
            hint=(
                "Set REDIS_URL and restart the server (channels_redis). With "
                "more than one worker process — or behind a load balancer — "
                "participants otherwise see each other's strokes and camera "
                "negotiation late, or not at all."
            ),
            id="whiteboard.W001",
            obj=None,
        ))
    return issues


class WhiteboardConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "whiteboard"
    verbose_name = "تخته سفید"
