"""Quiz business logic — server-side enforcement, WS payloads, scoring.

All entry points validate that the acting member belongs to the classroom
and holds the required role; nothing here trusts client-sent identities.
"""
from __future__ import annotations

import logging

from django.db import transaction
from django.utils import timezone

from classrooms.models import Classroom, ClassroomMember
from classrooms.permissions import PRIVILEGED_ROLES, is_privileged
from classrooms.services import broadcast

from .models import Quiz, QuizAnswer, QuizOption, QuizQuestion, QuizRun

logger = logging.getLogger(__name__)


class QuizError(Exception):
    """Business-rule violation; message is safe to show to the user."""


# ---------------------------------------------------------------- payloads
def questions_payload(quiz: Quiz) -> list[dict]:
    """Questions + options for clients — correct flags are NEVER sent."""
    return [
        {
            "id": q.id,
            "text": q.text,
            "points": q.points,
            "options": [
                {"id": o.id, "text": o.text}
                for o in q.options.all()
            ],
        }
        for q in quiz.questions.prefetch_related("options").all()
    ]


def run_payload(run: QuizRun) -> dict:
    return {
        "run_id": run.id,
        "quiz_id": run.quiz_id,
        "title": run.quiz.title,
        "questions": questions_payload(run.quiz),
    }


def results_payload(run: QuizRun) -> list[dict]:
    """Per-member scores for one finished run (identity matches roster)."""
    rows: list[dict] = []
    answers = (
        QuizAnswer.objects.filter(run=run)
        .select_related("member", "option", "question")
    )
    per_member: dict[int, dict] = {}
    for ans in answers:
        row = per_member.setdefault(ans.member_id, {
            "identity": ans.member.identity,
            "name": ans.member.display_name or (
                ans.member.user.get_full_name() if ans.member.user else "?"
            ),
            "score": 0,
            "answered": 0,
        })
        row["answered"] += 1
        if ans.option.is_correct:
            row["score"] += ans.question.points
    total = run.quiz.total_points
    for row in per_member.values():
        row["max"] = total
        rows.append(row)
    rows.sort(key=lambda r: -r["score"])
    return rows


def active_run(classroom: Classroom) -> QuizRun | None:
    return (
        QuizRun.objects.filter(quiz__classroom=classroom, ended_at__isnull=True)
        .select_related("quiz")
        .first()
    )


# ---------------------------------------------------------------- actions
def start_quiz(classroom: Classroom, member: ClassroomMember, quiz: Quiz) -> QuizRun:
    if not is_privileged(member):
        raise QuizError("فقط میزبان می‌تواند آزمون را شروع کند.")
    if quiz.classroom_id != classroom.id:
        raise QuizError("این آزمون به این کلاس تعلق ندارد.")
    if quiz.question_count == 0:
        raise QuizError("این آزمون هنوز پرسشی ندارد.")
    with transaction.atomic():
        # one live quiz per classroom — close any dangling run
        QuizRun.objects.filter(
            quiz__classroom=classroom, ended_at__isnull=True
        ).update(ended_at=timezone.now())
        run = QuizRun.objects.create(quiz=quiz, started_by=member)
    payload = {"type": "quiz_started", **run_payload(run),
               "actor_name": _member_name(member)}
    broadcast(classroom.room_code, payload)
    logger.info("quiz_started", extra={"run": run.id, "room": classroom.room_code})
    return run


def answer_question(
    classroom: Classroom,
    member: ClassroomMember,
    run_id: int,
    question_id: int,
    option_id: int,
) -> None:
    run = QuizRun.objects.filter(id=run_id).select_related("quiz").first()
    if run is None or run.quiz.classroom_id != classroom.id:
        raise QuizError("آزمون یافت نشد.")
    if not run.is_active:
        raise QuizError("این آزمون به پایان رسیده است.")
    if member.classroom_id != classroom.id or not member.is_active or member.in_waiting_room:
        raise QuizError("شما عضو فعال این کلاس نیستید.")
    question = QuizQuestion.objects.filter(id=question_id, quiz_id=run.quiz_id).first()
    if question is None:
        raise QuizError("پرسش نامعتبر است.")
    option = QuizOption.objects.filter(id=option_id, question_id=question.id).first()
    if option is None:
        raise QuizError("گزینهٔ نامعتبر است.")
    QuizAnswer.objects.update_or_create(
        run=run, member=member, question=question,
        defaults={"option": option},
    )
    answered = QuizAnswer.objects.filter(run=run).values("member_id").distinct().count()
    total = ClassroomMember.objects.filter(
        classroom=classroom, is_active=True, in_waiting_room=False,
    ).exclude(role__in=PRIVILEGED_ROLES).count() or 1
    broadcast(classroom.room_code, {
        "type": "quiz_answered", "run_id": run.id,
        "answered_count": answered, "total_members": max(total, answered),
    })


def end_quiz(classroom: Classroom, member: ClassroomMember, run_id: int) -> list[dict]:
    if not is_privileged(member):
        raise QuizError("فقط میزبان می‌تواند آزمون را پایان دهد.")
    run = QuizRun.objects.filter(id=run_id).select_related("quiz").first()
    if run is None or run.quiz.classroom_id != classroom.id:
        raise QuizError("آزمون یافت نشد.")
    if not run.is_active:
        raise QuizError("این آزمون قبلاً پایان یافته است.")
    run.ended_at = timezone.now()
    run.save(update_fields=["ended_at"])
    results = results_payload(run)
    broadcast(classroom.room_code, {
        "type": "quiz_ended", "run_id": run.id, "title": run.quiz.title,
        "results": results,
    })
    logger.info("quiz_ended", extra={"run": run.id, "room": classroom.room_code})
    return results


def _member_name(member: ClassroomMember) -> str:
    if member.display_name:
        return member.display_name
    return member.user.get_full_name() if member.user else "?"
