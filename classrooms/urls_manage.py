"""Classroom management URLs (mounted under /classrooms/)."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.classroom_list_view, name="list"),
    path("create/", views.classroom_create_view, name="create"),
    path("<str:room_code>/", views.classroom_detail_view, name="detail"),
    path("<str:room_code>/delete/", views.classroom_delete_view, name="delete"),
]
