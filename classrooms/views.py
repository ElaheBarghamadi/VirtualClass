"""HTTP views for dashboard, classroom management, lobby and room.

Business rules live in :mod:`classrooms.services` — these views only
handle requests/responses and authorisation redirects.
"""
from __future__ import annotations

from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_http_methods, require_POST

from .forms import ClassroomForm, ClassroomJoinForm
from .models import Classroom
from .services import (
    WrongClassroomPassword,
    active_members,
    create_classroom,
    get_active_member,
    join_classroom,
    leave_classroom,
)


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
@login_required
@require_http_methods(["GET"])
def dashboard_view(request):
    """User dashboard: owned classrooms + membership summary."""
    owned = (
        request.user.owned_classrooms.annotate(
            participant_count=Count(
                "members", filter=Q(members__is_active=True), distinct=True
            )
        ).order_by("-created_at")
    )
    joined_count = request.user.classroom_memberships.filter(is_active=True).count()
    return render(
        request,
        "classrooms/dashboard.html",
        {"owned_classrooms": owned, "joined_count": joined_count},
    )


# ---------------------------------------------------------------------------
# Classroom management
# ---------------------------------------------------------------------------
@login_required
@require_http_methods(["GET", "POST"])
def classroom_create_view(request):
    """Create a new classroom (optionally password protected)."""
    form = ClassroomForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        classroom = create_classroom(
            owner=request.user,
            title=form.cleaned_data["title"],
            description=form.cleaned_data.get("description", ""),
            password=form.cleaned_data.get("password"),
            is_password_protected=form.cleaned_data.get("is_password_protected", False),
        )
        messages.success(request, "کلاس با موفقیت ساخته شد.")
        return redirect("room:lobby", room_code=classroom.room_code)
    return render(request, "classrooms/classroom_form.html", {"form": form})


@login_required
@require_http_methods(["GET"])
def classroom_list_view(request):
    """List of classrooms the user owns or participates in."""
    owned = request.user.owned_classrooms.annotate(
        participant_count=Count("members", filter=Q(members__is_active=True), distinct=True)
    ).order_by("-created_at")
    memberships = (
        request.user.classroom_memberships.filter(is_active=True)
        .select_related("classroom")
        .exclude(role="OWNER")
        .order_by("-joined_at")
    )
    return render(
        request,
        "classrooms/classroom_list.html",
        {"owned_classrooms": owned, "memberships": memberships},
    )


@login_required
@require_http_methods(["GET"])
def classroom_detail_view(request, room_code: str):
    """Owner-facing management page for a single classroom."""
    classroom = get_object_or_404(
        Classroom.objects.select_related("owner"), room_code=room_code, owner=request.user
    )
    members = active_members(classroom)
    return render(
        request,
        "classrooms/classroom_detail.html",
        {"classroom": classroom, "members": members},
    )


@login_required
@require_POST
def classroom_delete_view(request, room_code: str):
    """Deactivate a classroom (soft delete keeps chat history intact)."""
    classroom = get_object_or_404(Classroom, room_code=room_code, owner=request.user)
    classroom.is_active = False
    classroom.save(update_fields=["is_active", "updated_at"])
    messages.success(request, "کلاس غیرفعال شد.")
    return redirect("classrooms:list")


# ---------------------------------------------------------------------------
# Lobby & room
# ---------------------------------------------------------------------------
@login_required
@require_http_methods(["GET", "POST"])
def lobby_view(request, room_code: str):
    """Classroom lobby: shows info and (if needed) asks for the password."""
    classroom = get_object_or_404(
        Classroom.objects.select_related("owner"), room_code=room_code, is_active=True
    )
    join_form = ClassroomJoinForm() if classroom.is_password_protected else None

    if request.method == "POST":
        raw_password = ""
        if classroom.is_password_protected:
            join_form = ClassroomJoinForm(request.POST)
            if not join_form.is_valid():
                return render(
                    request,
                    "classrooms/lobby.html",
                    {"classroom": classroom, "join_form": join_form},
                )
            raw_password = join_form.cleaned_data["password"]
        try:
            join_classroom(classroom, request.user, raw_password)
        except WrongClassroomPassword:
            join_form.add_error("password", "رمز کلاس اشتباه است.")
            return render(
                request,
                "classrooms/lobby.html",
                {"classroom": classroom, "join_form": join_form},
            )
        return redirect("room:room", room_code=classroom.room_code)

    # Already an active member → straight to the room.
    if get_active_member(classroom, request.user):
        return redirect("room:room", room_code=classroom.room_code)

    return render(
        request,
        "classrooms/lobby.html",
        {"classroom": classroom, "join_form": join_form},
    )


@login_required
@require_http_methods(["GET"])
def room_view(request, room_code: str):
    """The live classroom interface.

    Access requires an **active membership** (verified server-side);
    the client only receives its own effective permissions.
    """
    classroom = get_object_or_404(Classroom, room_code=room_code, is_active=True)
    member = get_active_member(classroom, request.user)
    if member is None:
        messages.info(request, "برای ورود به کلاس ابتدا باید عضو شوید.")
        return redirect("room:lobby", room_code=room_code)

    return render(
        request,
        "classrooms/room.html",
        {
            "classroom": classroom,
            "member": member,
            "members": active_members(classroom),
            "permissions": member.permissions_dict(),
        },
    )


@login_required
@require_POST
def leave_view(request, room_code: str):
    """Leave a classroom (ownership can't be 'left' — deactivates anyway)."""
    classroom = get_object_or_404(Classroom, room_code=room_code)
    leave_classroom(classroom, request.user)
    messages.success(request, "از کلاس خارج شدید.")
    return redirect("dashboard")
