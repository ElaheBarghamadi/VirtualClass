"""Owner-facing quiz authoring pages (mounted under /classrooms/<code>/)."""
from __future__ import annotations

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_http_methods

from classrooms.models import Classroom

from .models import Quiz, QuizOption, QuizQuestion, QuizRun
from .services import results_payload


def _owned_classroom(request, room_code: str) -> Classroom:
    return get_object_or_404(Classroom, room_code=room_code, owner=request.user)


@login_required
@require_http_methods(["GET", "POST"])
def quiz_list_view(request, room_code: str):
    classroom = _owned_classroom(request, room_code)
    if request.method == "POST":
        title = (request.POST.get("title") or "").strip()
        if not title:
            messages.error(request, "عنوان آزمون نمی‌تواند خالی باشد.")
        elif len(title) > 200:
            messages.error(request, "عنوان آزمون خیلی طولانی است.")
        else:
            quiz = Quiz.objects.create(
                classroom=classroom, title=title, created_by=request.user,
            )
            return redirect("quizzes_manage:detail",
                            room_code=room_code, quiz_id=quiz.id)
    quizzes = classroom.quizzes.prefetch_related("questions")
    return render(request, "quizzes/quiz_list.html",
                  {"classroom": classroom, "quizzes": quizzes})


@login_required
@require_http_methods(["GET", "POST"])
def quiz_detail_view(request, room_code: str, quiz_id: int):
    classroom = _owned_classroom(request, room_code)
    quiz = get_object_or_404(Quiz, id=quiz_id, classroom=classroom)
    if request.method == "POST":
        if "add_question" in request.POST:
            _add_question(request, quiz)
        elif "delete_question" in request.POST:
            QuizQuestion.objects.filter(
                id=request.POST.get("delete_question"), quiz=quiz).delete()
            messages.success(request, "پرسش حذف شد.")
        elif "delete_quiz" in request.POST:
            quiz.delete()
            messages.success(request, "آزمون حذف شد.")
            return redirect("quizzes_manage:list", room_code=room_code)
        return redirect("quizzes_manage:detail",
                        room_code=room_code, quiz_id=quiz.id)
    questions = quiz.questions.prefetch_related("options")
    runs = list(QuizRun.objects.filter(quiz=quiz).select_related("started_by"))
    for run in runs:
        run.results = results_payload(run) if run.ended_at else None
    return render(request, "quizzes/quiz_detail.html", {
        "classroom": classroom, "quiz": quiz,
        "questions": questions, "runs": runs,
        "next_order": questions.count() + 1,
    })


def _add_question(request, quiz: Quiz) -> None:
    text = (request.POST.get("text") or "").strip()
    options = [
        (request.POST.get(f"option_{i}") or "").strip() for i in range(1, 5)
    ]
    correct = request.POST.get("correct")  # "1".."4"
    try:
        points = max(1, min(100, int(request.POST.get("points") or 1)))
    except ValueError:
        points = 1
    filled = [o for o in options if o]
    if not text:
        messages.error(request, "متن پرسش خالی است.")
        return
    if len(filled) < 2:
        messages.error(request, "دست‌کم دو گزینه وارد کنید.")
        return
    if correct not in {"1", "2", "3", "4"} or not options[int(correct) - 1]:
        messages.error(request, "گزینهٔ صحیح را مشخص کنید.")
        return
    question = QuizQuestion.objects.create(
        quiz=quiz, text=text, points=points,
        order=quiz.questions.count() + 1,
    )
    for i, opt_text in enumerate(options, start=1):
        if opt_text:
            QuizOption.objects.create(
                question=question, text=opt_text, order=i,
                is_correct=(str(i) == correct),
            )
    messages.success(request, "پرسش اضافه شد.")
