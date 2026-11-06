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

import asyncio
import json
import logging
import threading
from datetime import timedelta

from django.conf import settings

from .models import Classroom

logger = logging.getLogger(__name__)

# How long the SFU gets to answer a control call (remove/mute/end room) before
# it is abandoned.  These run in a background thread: a slow or unreachable
# media server must never delay a moderation click.
MEDIA_CONTROL_TIMEOUT = 6

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


# ---------------------------------------------------------------------------
# Live revocation
# ---------------------------------------------------------------------------
# A token is a snapshot of permissions: removing someone from the class, muting
# them or ending the session changes the database and the Django sockets, but
# the browser is already attached to the SFU and would keep publishing until the
# token expired (hours later).  These helpers close that hole: the SFU is told
# to drop the participant / mute their tracks / close the room.

def _ttl_seconds() -> int:
    return int(settings.LIVEKIT_TOKEN_TTL_MINUTES) * 60


async def _end_room(room_svc, room: str) -> None:
    await room_svc.delete_room(livekit_api.DeleteRoomRequest(room=room))


async def _remove_participant(room_svc, room: str, identity: str) -> None:
    await room_svc.remove_participant(
        livekit_api.RoomParticipantIdentity(room=room, identity=identity)
    )


async def _mute_everyone(room_svc, room: str, source: str = "audio") -> None:
    """Mute one source for every participant currently in the SFU room."""
    wanted = 0 if source == "audio" else 1
    try:
        listing = await room_svc.list_participants(livekit_api.ListParticipantsRequest(room=room))
    except Exception:  # pragma: no cover - empty room
        return
    for participant in getattr(listing, "participants", []):
        for track in participant.tracks:
            if getattr(track, "type", None) != wanted:
                continue
            await room_svc.mute_published_track(
                livekit_api.MuteRoomTrackRequest(
                    room=room, identity=participant.identity, track_sid=track.sid, muted=True
                )
            )


async def _mute_participant(room_svc, room: str, identity: str, *, source: str = "audio") -> None:
    """Mute every microphone (or camera) track this participant publishes."""
    try:
        listing = await room_svc.list_participants(livekit_api.ListParticipantsRequest(room=room))
    except Exception:  # pragma: no cover - nobody in the room is not an error
        return
    for participant in getattr(listing, "participants", []):
        if participant.identity != identity:
            continue
        for track in participant.tracks:
            kind = getattr(track, "type", None)
            # TrackType: AUDIO=0, VIDEO=1
            wanted = 0 if source == "audio" else 1
            if kind != wanted:
                continue
            await room_svc.mute_published_track(
                livekit_api.MuteRoomTrackRequest(
                    room=room, identity=identity, track_sid=track.sid, muted=True
                )
            )


_CONTROL = {
    "remove": _remove_participant,
    "mute_audio": lambda room_svc, room, identity: _mute_participant(room_svc, room, identity, source="audio"),
    "mute_video": lambda room_svc, room, identity: _mute_participant(room_svc, room, identity, source="video"),
    "end_room": lambda room_svc, room, _identity: _end_room(room_svc, room),
    "mute_all": lambda room_svc, room, _identity: _mute_everyone(room_svc, room, source="audio"),
}


async def apply_media_control(action: str, room: str, identity: str = "") -> None:
    """Perform one SFU control call (the testable core of the helpers below)."""
    if livekit_api is None:  # pragma: no cover - dependency is declared
        raise RuntimeError("livekit-api is not installed")
    handler = _CONTROL[action]
    client = livekit_api.LiveKitAPI(
        url=settings.LIVEKIT_URL,
        api_key=settings.LIVEKIT_API_KEY,
        api_secret=settings.LIVEKIT_API_SECRET,
    )
    try:
        await asyncio.wait_for(handler(client.room, room, identity), timeout=MEDIA_CONTROL_TIMEOUT)
    finally:
        await client.aclose()


def _dispatch(action: str, room: str, identity: str = "") -> None:
    """Fire an SFU control call without blocking (and without ever raising)."""
    if not media_enabled() or livekit_api is None:
        return

    def job() -> None:
        try:
            asyncio.run(apply_media_control(action, room, identity))
        except Exception:  # pragma: no cover - server down, token expired, ...
            logger.warning("livekit_media_control_failed action=%s room=%s", action, room, exc_info=True)

    threading.Thread(target=job, name=f"livekit-{action}", daemon=True).start()


def revoke_participant(classroom: Classroom, member) -> None:
    """Drop this member from the live SFU room (removal, ban, account delete)."""
    _dispatch("remove", room_name(classroom), getattr(member, "identity", ""))


def mute_participant(classroom: Classroom, member, *, source: str = "audio") -> None:
    """Mute the member's microphone/camera on the SFU, not just in our sockets."""
    action = "mute_video" if source == "video" else "mute_audio"
    _dispatch(action, room_name(classroom), getattr(member, "identity", ""))


def mute_all_participants(classroom: Classroom) -> None:
    """Host pressed "mute everyone": do it on the SFU too, not just the roster."""
    _dispatch("mute_all", room_name(classroom))


def end_room(classroom: Classroom) -> None:
    """Close the SFU room when the classroom is deactivated or deleted."""
    _dispatch("end_room", room_name(classroom))


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
        "mesh_enabled": settings.MESH_ENABLED,
    }
