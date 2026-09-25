"""API URL configuration (mounted under /api/)."""
from django.urls import path

from classrooms.api import (
    ClassroomDetailAPIView,
    ClassroomListCreateAPIView,
    ClassroomParticipantsAPIView,
    LoginAPIView,
    RegisterAPIView,
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
]
