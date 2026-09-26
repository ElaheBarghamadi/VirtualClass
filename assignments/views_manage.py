"""Assignment pages: owner authors & grades, members submit."""
from __future__ import annotations

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.http import Http404
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.http import require_http_methods

from classrooms.file_validation import validate_upload
from classrooms.models import Classroom
from classrooms.services import get_active_member

from .models import Assignment, Submission

MAX_SUBMISSION_BYTES = 25 * 1024 * 1024  # same cap as classroom files


def _classroom_for(request, room_code: str) -> tuple[Classroom, bool]:
    """(classroom, is_owner) — 404 for everyone who is neither owner nor member."""
    classroom = get_object_or_404(Classroom, room_code=room_code)
    is_owner = classroom.owner_id == request.user.id
    if not is_owner and get_active_member(classroom, request.user) is None:
        raise Http404("کلاس یافت نشد.")
    return classroom, is_owner


@login_required
@require_http_methods(["GET", "POST"])
def assignment_list_view(request, room_code: str):
    classroom, is_owner = _classroom_for(request, room_code)
    if request.method == "POST":
        if not is_owner:
            raise Http404("کلاس یافت نشد.")
        if "delete_assignment" in request.POST:
            Assignment.objects.filter(
                id=request.POST.get("delete_assignment"), classroom=classroom,
            ).delete()
            messages.success(request, "تکلیف حذف شد.")
        else:
            title = (request.POST.get("title") or "").strip()
            description = (request.POST.get("description") or "").strip()
            due_raw = (request.POST.get("due_at") or "").strip()
            try:
                max_score = max(1, min(100, int(request.POST.get("max_score") or 20)))
            except ValueError:
                max_score = 20
            due_at = _parse_due(due_raw)
            if not title:
                messages.error(request, "عنوان تکلیف خالی است.")
            elif due_at is None:
                messages.error(request, "مهلت ارسال را وارد کنید.")
            else:
                Assignment.objects.create(
                    classroom=classroom, title=title, description=description,
                    due_at=due_at, max_score=max_score, created_by=request.user,
                )
                messages.success(request, "تکلیف ساخته شد.")
        return redirect("assignments_manage:list", room_code=room_code)
    assignments = classroom.assignments.all()
    my_member = get_active_member(classroom, request.user)
    my_submissions = {
        s.assignment_id: s
        for s in Submission.objects.filter(member=my_member) if my_member
    } if my_member else {}
    return render(request, "assignments/assignment_list.html", {
        "classroom": classroom, "assignments": assignments,
        "is_owner": is_owner, "my_submissions": my_submissions,
    })


@login_required
@require_http_methods(["GET", "POST"])
def assignment_detail_view(request, room_code: str, assignment_id: int):
    classroom, is_owner = _classroom_for(request, room_code)
    assignment = get_object_or_404(Assignment, id=assignment_id, classroom=classroom)
    member = get_active_member(classroom, request.user)
    submission = Submission.objects.filter(assignment=assignment, member=member).first()

    if request.method == "POST":
        if is_owner and "grade_submission" in request.POST:
            _grade(request, assignment)
        elif not is_owner:
            _submit(request, assignment, member, submission)
        return redirect("assignments_manage:detail",
                        room_code=room_code, assignment_id=assignment.id)

    submissions = (
        assignment.submissions.select_related("member").order_by("submitted_at")
        if is_owner else []
    )
    return render(request, "assignments/assignment_detail.html", {
        "classroom": classroom, "assignment": assignment, "is_owner": is_owner,
        "submission": submission, "submissions": submissions,
    })


def _parse_due(raw: str):
    """Accept ``datetime-local`` input (YYYY-MM-DDTHH:MM)."""
    from django.utils.dateparse import parse_datetime
    if not raw:
        return None
    dt = parse_datetime(raw)
    if dt is None:
        return None
    if timezone.is_naive(dt):
        dt = timezone.make_aware(dt, timezone.get_current_timezone())
    return dt


def _submit(request, assignment: Assignment, member, submission: Submission | None) -> None:
    if assignment.due_at < timezone.now() and not (submission and submission.graded_at):
        messages.error(request, "مهلت ارسال این تکلیف تمام شده است.")
        return
    if submission and submission.graded_at:
        messages.error(request, "پاسخ شما تصحیح شده و قابل ویرایش نیست.")
        return
    content = (request.POST.get("content") or "").strip()
    uploaded = request.FILES.get("file")
    if not content and not uploaded:
        messages.error(request, "متن پاسخ یا فایل را وارد کنید.")
        return
    if uploaded is not None:
        try:
            stored_name = validate_upload(uploaded, MAX_SUBMISSION_BYTES)
        except Exception as exc:  # ValidationError & friends → user-facing
            messages.error(request, str(getattr(exc, "message", exc)))
            return
    else:
        stored_name = None
    if submission is None:
        submission = Submission(assignment=assignment, member=member)
    if content:
        submission.content = content
    if uploaded is not None:
        if submission.file:
            submission.file.delete(save=False)
        uploaded.name = stored_name
        submission.file = uploaded
    submission.save()
    messages.success(request, "پاسخ شما ثبت شد.")


def _grade(request, assignment: Assignment) -> None:
    submission = get_object_or_404(
        Submission, id=request.POST.get("grade_submission"), assignment=assignment)
    try:
        score = float(request.POST.get("score") or "")
    except ValueError:
        messages.error(request, "نمره نامعتبر است.")
        return
    if score < 0 or score > assignment.max_score:
        messages.error(request, f"نمره باید بین ۰ و {assignment.max_score} باشد.")
        return
    submission.score = round(score, 1)
    submission.feedback = (request.POST.get("feedback") or "").strip()
    submission.graded_at = timezone.now()
    submission.save(update_fields=["score", "feedback", "graded_at"])
    messages.success(request, "نمره ثبت شد.")
