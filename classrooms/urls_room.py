"""Classroom room URLs (mounted under /class/)."""
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
    path("<str:room_code>/room/", views.room_view, name="room"),
    path("<str:room_code>/leave/", views.leave_view, name="leave"),
]
