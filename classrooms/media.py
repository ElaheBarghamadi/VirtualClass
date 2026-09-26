"""Media server integration (LiveKit SFU).

Why LiveKit
-----------
* Official Python SDK (``livekit-api``) → token generation happens natively
  inside Django, no sidecar service, fully unit-testable offline.
* mediasoup is a Node.js library (would force a second backend runtime);
  Janus is C with a plugin/REST architecture — both integrate far less
  cleanly with a Django-centric stack.
* Apache-2.0, single self-hostable Docker image, actively maintained.

Django never touches media bytes.  It only issues **short-lived, scoped
JWTs** whose grants mirror the user's server-computed effective
permissions.  The browser then connects to the SFU directly.
"""
from __future__ import annotations

import json
from datetime import timedelta

from django.conf import settings

from .models import Classroom
from .permissions import Role

try:  # livekit-api is a hard dependency; guard only improves error messages.
    from livekit import api as livekit_api
except ImportError:  # pragma: no cover
    livekit_api = None


def media_enabled() -> bool:
    """True when the deployment has a LiveKit server configured."""
    return bool(
        settings.LIVEKIT_URL
        and settings.LIVEKIT_API_KEY
        and settings.LIVEKIT_API_SECRET
    )


def room_name(classroom: Classroom) -> str:
    """Deterministic SFU room name derived from the (unguessable) room code."""
    return f"classroom_{classroom.room_code}"


def generate_media_token(member, classroom: Classroom, perms: dict[str, bool]) -> str:
    """Create a short-lived LiveKit JWT scoped to this participant + room.

    Publish rights are derived from ``perms`` (the server-side effective
    permission map) — a modified client cannot widen them, because the
    SFU enforces the token.  Identity is ``u:<id>`` for registered users
    and ``g:<uid>`` for guests — matching the roster identities.
    """
    if livekit_api is None:  # pragma: no cover
        raise RuntimeError("livekit-api is not installed")

    publish_sources: list[str] = []
    if perms.get("can_use_microphone"):
        publish_sources.append("microphone")
    if perms.get("can_use_camera"):
        publish_sources.append("camera")
    if perms.get("can_share_screen"):
        publish_sources.append("screen_share")

    grants = livekit_api.VideoGrants(
        room_join=True,
        room=room_name(classroom),
        can_publish=bool(publish_sources),
        can_publish_sources=publish_sources or None,
        can_subscribe=True,
        can_publish_data=True,  # data-channel signaling (hand metadata etc.)
    )

    token = (
        livekit_api.AccessToken(settings.LIVEKIT_API_KEY, settings.LIVEKIT_API_SECRET)
        .with_identity(member.identity)
        .with_name(member.participant_name[:60])
        .with_metadata(json.dumps({"role": member.role}, separators=(",", ":")))
        .with_ttl(timedelta(minutes=settings.LIVEKIT_TOKEN_TTL_MINUTES))
        .with_grants(grants)
    )
    return token.to_jwt()


def media_config_payload() -> dict:
    """Non-secret config the browser needs (URL only — never the keys).

    ``ice_servers`` powers the P2P mesh fallback: deployments behind
    strict NATs run coturn and list it in WEBRTC_ICE_SERVERS.  TURN
    credentials here are per standard practice — they grant relay only,
    never app data, and should be scope-limited on the coturn side.
    """
    return {
        "enabled": media_enabled(),
        "url": settings.LIVEKIT_URL if media_enabled() else "",
        "ice_servers_json": json.dumps(settings.WEBRTC_ICE_SERVERS),
        "mesh_max_participants": settings.MESH_MAX_PARTICIPANTS,
    }
