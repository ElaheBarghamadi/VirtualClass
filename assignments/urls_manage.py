"""Assignment URLs (mounted under /classrooms/)."""
from django.urls import path

from . import views_manage as views

urlpatterns = [
    path("<str:room_code>/assignments/", views.assignment_list_view, name="list"),
    path("<str:room_code>/assignments/<int:assignment_id>/submissions/<int:submission_id>/download/",
         views.submission_download_view, name="submission_download"),
    path("<str:room_code>/assignments/<int:assignment_id>/",
         views.assignment_detail_view, name="detail"),
]
