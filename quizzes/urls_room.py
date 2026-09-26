"""In-room quiz action URLs (mounted under /class/)."""
from django.urls import path

from . import views_room as views

urlpatterns = [
    path("<str:room_code>/quizzes/start/", views.quiz_start_view, name="start"),
    path("<str:room_code>/quizzes/answer/", views.quiz_answer_view, name="answer"),
    path("<str:room_code>/quizzes/end/", views.quiz_end_view, name="end"),
]
