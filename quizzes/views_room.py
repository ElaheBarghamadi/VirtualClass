"""In-room quiz actions (JSON API, ns ``quizzes``).

start/end are host-only; answering is open to every active participant
(registered users *and* guests) — identity always resolved server-side
from the session, never from the request body.
"""
from __future__ import annotations

from django.http import JsonResponse
from django.views.decorators.http import require_POST

from classrooms.models import Classroom
from classrooms.services import resolve_member
from classrooms.views import _json_body, _json_error

from .models import Quiz
from .services import QuizError, answer_question, end_quiz, start_quiz


def _member_or_none(request, classroom: Classroom):
    member = resolve_member(request, classroom)
    if member is None or not member.is_active or member.in_waiting_room:
        return None
    return member


@require_POST
def quiz_start_view(request, room_code: str):
    classroom = Classroom.objects.filter(room_code=room_code).first()
    if classroom is None:
        return JsonResponse({"detail": "کلاس یافت نشد."}, status=404)
    member = _member_or_none(request, classroom)
    if member is None:
        return _json_error(PermissionError("دسترسی غیرمجاز."), status=403)
    try:
        body = _json_body(request)
        quiz = Quiz.objects.filter(id=int(body.get("quiz_id") or 0)).first()
        if quiz is None:
            return JsonResponse({"detail": "آزمون یافت نشد."}, status=404)
        run = start_quiz(classroom, member, quiz)
    except (QuizError, PermissionError) as exc:
        return _json_error(exc, status=403)
    except (ValueError, TypeError):
        return JsonResponse({"detail": "quiz_id نامعتبر است."}, status=400)
    return JsonResponse({"ok": True, "run_id": run.id})


@require_POST
def quiz_answer_view(request, room_code: str):
    classroom = Classroom.objects.filter(room_code=room_code).first()
    if classroom is None:
        return JsonResponse({"detail": "کلاس یافت نشد."}, status=404)
    member = _member_or_none(request, classroom)
    if member is None:
        return _json_error(PermissionError("دسترسی غیرمجاز."), status=403)
    try:
        body = _json_body(request)
        answer_question(
            classroom, member,
            int(body.get("run_id") or 0),
            int(body.get("question_id") or 0),
            int(body.get("option_id") or 0),
        )
    except QuizError as exc:
        return _json_error(exc, status=400)
    except (ValueError, TypeError):
        return JsonResponse({"detail": "پارامترها نامعتبرند."}, status=400)
    return JsonResponse({"ok": True})


@require_POST
def quiz_end_view(request, room_code: str):
    classroom = Classroom.objects.filter(room_code=room_code).first()
    if classroom is None:
        return JsonResponse({"detail": "کلاس یافت نشد."}, status=404)
    member = _member_or_none(request, classroom)
    if member is None:
        return _json_error(PermissionError("دسترسی غیرمجاز."), status=403)
    try:
        body = _json_body(request)
        results = end_quiz(classroom, member, int(body.get("run_id") or 0))
    except QuizError as exc:
        return _json_error(exc, status=400)
    except (ValueError, TypeError):
        return JsonResponse({"detail": "run_id نامعتبر است."}, status=400)
    return JsonResponse({"ok": True, "results": results})
