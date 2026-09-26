"""Classroom room + host-action URLs (mounted under /class/)."""
from django.urls import path
from django.views.generic import RedirectView

from . import views

urlpatterns = [
    # /class/<room_code>/ is the public shareable link → lobby.
    path(
        "<str:room_code>/",
        RedirectView.as_view(pattern_name="room:lobby", permanent=False),
        name="redirect_to_lobby",
    ),
    path("<str:room_code>/lobby/", views.lobby_view, name="lobby"),
    path("<str:room_code>/waiting/", views.waiting_view, name="waiting"),
    path("<str:room_code>/room/", views.room_view, name="room"),
    path("<str:room_code>/leave/", views.leave_view, name="leave"),
    # Media (LiveKit) token — short-lived, permission-scoped.
    path("<str:room_code>/media-token/", views.media_token_view, name="media_token"),
    # Host actions (JSON POST, CSRF-protected).
    path("<str:room_code>/lock/", views.lock_view, name="lock"),
    path("<str:room_code>/settings/", views.settings_view, name="settings"),
    path("<str:room_code>/mute-all/", views.mute_all_view, name="mute_all"),
    path("<str:room_code>/presentation/", views.presentation_view, name="presentation"),
    path("<str:room_code>/sessions/start/", views.session_start_view, name="session_start"),
    path("<str:room_code>/sessions/<int:session_id>/end/", views.session_end_view, name="session_end"),
    path("<str:room_code>/sessions/<int:session_id>/attendance/", views.attendance_view, name="attendance"),
    path("<str:room_code>/members/<int:member_id>/permission/", views.member_permission_view, name="member_permission"),
    path("<str:room_code>/members/<int:member_id>/role/", views.member_role_view, name="member_role"),
    path("<str:room_code>/members/<int:member_id>/mute/", views.member_mute_view, name="member_mute"),
    path("<str:room_code>/members/<int:member_id>/remove/", views.member_remove_view, name="member_remove"),
    path("<str:room_code>/members/<int:member_id>/waiting/", views.waiting_room_action_view, name="waiting_action"),
    # File sharing.
    path("<str:room_code>/files/upload/", views.file_upload_view, name="file_upload"),
    path("<str:room_code>/files/<int:file_id>/download/", views.file_download_view, name="file_download"),
    path("<str:room_code>/files/<int:file_id>/delete/", views.file_delete_view, name="file_delete"),
]
