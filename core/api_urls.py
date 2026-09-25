"""API URL configuration (mounted under /api/)."""
from django.urls import path

from classrooms.api import (
    AttendanceListAPIView,
    ClassroomDetailAPIView,
    ClassroomListCreateAPIView,
    ClassroomParticipantsAPIView,
    FileListAPIView,
    LoginAPIView,
    MessageListAPIView,
    ParticipantUpdateAPIView,
    RegisterAPIView,
    SessionActionAPIView,
    SessionListCreateAPIView,
)

urlpatterns = [
    # Authentication
    path("auth/register/", RegisterAPIView.as_view(), name="api_register"),
    path("auth/login/", LoginAPIView.as_view(), name="api_login"),
    # Classrooms
    path("classrooms/", ClassroomListCreateAPIView.as_view(), name="api_classroom_list"),
    path("classrooms/<str:room_code>/", ClassroomDetailAPIView.as_view(), name="api_classroom_detail"),
    path(
        "classrooms/<str:room_code>/participants/",
        ClassroomParticipantsAPIView.as_view(),
        name="api_classroom_participants",
    ),
    path(
        "classrooms/<str:room_code>/participants/<int:member_id>/",
        ParticipantUpdateAPIView.as_view(),
        name="api_participant_update",
    ),
    path(
        "classrooms/<str:room_code>/sessions/",
        SessionListCreateAPIView.as_view(),
        name="api_classroom_sessions",
    ),
    path(
        "classrooms/<str:room_code>/sessions/<int:session_id>/<str:action>/",
        SessionActionAPIView.as_view(),
        name="api_session_action",
    ),
    path(
        "classrooms/<str:room_code>/messages/",
        MessageListAPIView.as_view(),
        name="api_classroom_messages",
    ),
    path(
        "classrooms/<str:room_code>/files/",
        FileListAPIView.as_view(),
        name="api_classroom_files",
    ),
    path(
        "classrooms/<str:room_code>/attendance/",
        AttendanceListAPIView.as_view(),
        name="api_classroom_attendance",
    ),
]
