"""Quiz authoring URLs (mounted under /classrooms/)."""
from django.urls import path

from . import views_manage as views

urlpatterns = [
    path("<str:room_code>/quizzes/", views.quiz_list_view, name="list"),
    path("<str:room_code>/quizzes/<int:quiz_id>/", views.quiz_detail_view, name="detail"),
]
