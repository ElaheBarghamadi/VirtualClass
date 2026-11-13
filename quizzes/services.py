"""Quiz business logic — server-side enforcement, WS payloads, scoring.

All entry points validate that the acting member belongs to the classroom
and holds the required role; nothing here trusts client-sent identities.
"""
from __future__ import annotations

import logging

from django.db import transaction
from django.utils import timezone

from classrooms.models import Classroom, ClassroomMember
from classrooms.permissions import AUTHORITY_ROLES, PRIVILEGED_ROLES, is_authority
from classrooms.services import broadcast, notify_member
from core.templatetags.core_extras import to_fa_digits

from .models import Quiz, QuizAnswer, QuizOption, QuizQuestion, QuizRun

logger = logging.getLogger(__name__)


class QuizError(Exception):
    """Business-rule violation; message is safe to show to the user."""


#: A live question takes between two and ten options.
MIN_OPTIONS = 2
MAX_OPTIONS = 10
MAX_OPTION_LENGTH = 300
MAX_QUESTION_LENGTH = 500

#: Below this many people in the room, a privileged member sees *who* chose
#: each option.  Larger classes only get the totals (privacy by scale).
WHO_LIST_MAX_CLASS = 50


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
    classroom = run.quiz.classroom
    size = class_participant_count(classroom)
    return {
        "run_id": run.id,
        "quiz_id": run.quiz_id,
        "title": run.quiz.title,
        "questions": questions_payload(run.quiz),
        # The browser needs to know whether the scoreboard may name names —
        # the server decides that, and also never sends the detail to a
        # student in the first place (see ``_broadcast_stats``).
        "class_size": size,
        "show_who": size < WHO_LIST_MAX_CLASS,
        "asked_by": _asked_by_name(run),
        # Totals only: somebody joining mid-question sees the same bars as
        # everybody else instead of an empty panel (no names here — the
        # host-only detail travels separately).
        "stats": question_stats(run),
    }


def class_participant_count(classroom: Classroom) -> int:
    """Everybody currently admitted (hosts included) — the «زیر ۵۰ نفر» rule."""
    return ClassroomMember.objects.filter(
        classroom=classroom, is_active=True, in_waiting_room=False,
    ).count()


def _asked_by_name(run: QuizRun) -> str:
    question = run.quiz.questions.select_related("created_by").first()
    author = getattr(question, "created_by", None) if question else None
    return author.participant_name if author is not None else ""


def question_stats(
    run: QuizRun,
    *,
    include_names: bool = False,
    reveal_correct: bool = False,
) -> list[dict]:
    """Per-option counts/percentages for one run.

    ``include_names`` adds the roster names that picked each option; it is only
    ever true for a privileged viewer in a class below
    :data:`WHO_LIST_MAX_CLASS`.  ``reveal_correct`` marks the right option and
    is only true once the run has ended — the live payload must not leak it.
    """
    per_option: dict[int, list] = {}
    per_question: dict[int, int] = {}
    answers = QuizAnswer.objects.filter(run=run).select_related("member")
    for answer in answers:
        per_option.setdefault(answer.option_id, []).append(answer)
        per_question[answer.question_id] = per_question.get(answer.question_id, 0) + 1

    rows: list[dict] = []
    for question in run.quiz.questions.prefetch_related("options"):
        total = per_question.get(question.id, 0)
        options = []
        for option in question.options.all():
            picked = per_option.get(option.id, [])
            count = len(picked)
            row = {
                "id": option.id,
                "text": option.text,
                "count": count,
                "percent": round(count * 100 / total) if total else 0,
            }
            if reveal_correct:
                row["is_correct"] = option.is_correct
            if include_names:
                row["who"] = sorted(a.member.participant_name for a in picked)
            options.append(row)
        rows.append({
            "id": question.id,
            "text": question.text,
            "total": total,
            "options": options,
        })
    return rows


def _broadcast_stats(classroom: Classroom, run: QuizRun, *, ended: bool = False) -> None:
    """Live totals for everybody; the name-by-name detail only for the hosts."""
    broadcast(classroom.room_code, {
        "type": "quiz_stats",
        "run_id": run.id,
        "stats": question_stats(run, reveal_correct=ended),
        "ended": ended,
    })
    size = class_participant_count(classroom)
    if size >= WHO_LIST_MAX_CLASS and not ended:
        return
    detail = question_stats(
        run, include_names=size < WHO_LIST_MAX_CLASS, reveal_correct=ended,
    )
    for member in ClassroomMember.objects.filter(
        classroom=classroom, is_active=True, in_waiting_room=False,
        role__in=AUTHORITY_ROLES,
    ):
        notify_member(classroom.room_code, member, {
            "type": "quiz_stats_detail",
            "run_id": run.id,
            "stats": detail,
            "show_who": size < WHO_LIST_MAX_CLASS,
            "class_size": size,
        })


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
            # participant_name = guest name → account name → "مهمان".
            # get_full_name() returned "" for users who only set a username,
            # which left the scoreboard full of blank names.
            "name": ans.member.participant_name,
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
    if not is_authority(member):
        raise QuizError("فقط مالک، مدیر جلسه یا ارائه‌دهنده می‌تواند سوال را شروع کند.")
    if quiz.classroom_id != classroom.id:
        raise QuizError("این سوال به این کلاس تعلق ندارد.")
    if quiz.question_count == 0:
        raise QuizError("این سوال هنوز پرسشی ندارد.")
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
        raise QuizError("سوال یافت نشد.")
    if not run.is_active:
        raise QuizError("این سوال به پایان رسیده است.")
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
    _broadcast_stats(classroom, run)


def end_quiz(classroom: Classroom, member: ClassroomMember, run_id: int) -> list[dict]:
    if not is_authority(member):
        raise QuizError("فقط مالک، مدیر جلسه یا ارائه‌دهنده می‌تواند سوال را پایان دهد.")
    run = QuizRun.objects.filter(id=run_id).select_related("quiz").first()
    if run is None or run.quiz.classroom_id != classroom.id:
        raise QuizError("سوال یافت نشد.")
    if not run.is_active:
        raise QuizError("این سوال قبلاً پایان یافته است.")
    run.ended_at = timezone.now()
    run.save(update_fields=["ended_at"])
    results = results_payload(run)
    size = class_participant_count(classroom)
    broadcast(classroom.room_code, {
        "type": "quiz_ended", "run_id": run.id, "title": run.quiz.title,
        "results": results,
        "stats": question_stats(run, reveal_correct=True),
        "class_size": size,
        "show_who": size < WHO_LIST_MAX_CLASS,
    })
    _broadcast_stats(classroom, run, ended=True)
    logger.info("quiz_ended", extra={"run": run.id, "room": classroom.room_code})
    return results


def _member_name(member: ClassroomMember) -> str:
    """Same identity rules as the roster (see ClassroomMember.participant_name)."""
    return member.participant_name


def ask_question(
    classroom: Classroom,
    member: ClassroomMember,
    text: str,
    options: list[str],
    correct_index: int | None = None,
    points: int = 1,
) -> QuizRun:
    """Ask one question right now — the live «طرح سوال» flow.

    Any authority role (owner / moderator / presenter) may ask; the question
    becomes a single-question quiz so the archive stays a readable list of
    what was actually asked.  Options are 2..10, trimmed, duplicates dropped.
    """
    if not is_authority(member):
        raise QuizError("فقط مالک، مدیر جلسه یا ارائه‌دهنده می‌تواند سوال طرح کند.")
    text = (text or "").strip()
    if not text:
        raise QuizError("متن سوال را بنویسید.")
    if len(text) > MAX_QUESTION_LENGTH:
        raise QuizError(f"متن سوال حداکثر {to_fa_digits(MAX_QUESTION_LENGTH)} نویسه است.")

    cleaned: list[str] = []
    for raw in options or []:
        value = (raw or "").strip()
        if not value:
            continue
        if len(value) > MAX_OPTION_LENGTH:
            raise QuizError(f"هر گزینه حداکثر {to_fa_digits(MAX_OPTION_LENGTH)} نویسه است.")
        cleaned.append(value)
    if len(cleaned) < MIN_OPTIONS:
        raise QuizError("دست‌کم دو گزینه لازم است.")
    if len(cleaned) > MAX_OPTIONS:
        raise QuizError(f"حداکثر {to_fa_digits(MAX_OPTIONS)} گزینه مجاز است.")

    if correct_index is not None:
        if isinstance(correct_index, bool) or not isinstance(correct_index, int):
            raise QuizError("گزینهٔ صحیح نامعتبر است.")
        if not 0 <= correct_index < len(cleaned):
            raise QuizError("گزینهٔ صحیح نامعتبر است.")

    try:
        points = int(points)
    except (TypeError, ValueError):
        points = 1
    points = max(1, min(100, points))

    with transaction.atomic():
        quiz = Quiz.objects.create(
            classroom=classroom, title=text[:200],
            created_by=member.user if member.user_id else None,
        )
        question = QuizQuestion.objects.create(
            quiz=quiz, text=text, order=1, points=points, created_by=member,
        )
        for index, option_text in enumerate(cleaned):
            QuizOption.objects.create(
                question=question, text=option_text, order=index + 1,
                is_correct=(correct_index == index),
            )
    return start_quiz(classroom, member, quiz)
