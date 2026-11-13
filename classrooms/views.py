"""HTTP views: dashboard, classroom management, lobby, room, host actions.

Business rules live in :mod:`classrooms.services` — these views handle
requests/responses and authorisation redirects only.  Host-control
endpoints are JSON POSTs (CSRF-protected) whose effects are broadcast to
connected clients over the classroom WebSocket.
"""
from __future__ import annotations

import csv
import json
import logging

from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.core.exceptions import ValidationError
from django.db.models import Count, Q
from django.http import Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_http_methods, require_POST
from django.views.decorators.cache import never_cache

from core.queue import dispatch

from .file_validation import ALLOWED_EXTENSIONS, validate_upload
from .forms import (
    ClassroomCustomizationForm,
    ClassroomForm,
    ClassroomJoinForm,
    ClassroomSettingsForm,
    GuestJoinForm,
    SessionScheduleForm,
)
from .media import generate_media_token, media_config_payload, media_enabled
from .storage import private_file_response
from .tasks import convert_office_file
from .models import Classroom, ClassroomSession, SharedFile
from .permissions import Role, effective_permissions, is_authority, is_privileged
from .services import (
    MAX_FILES_PER_CLASSROOM,
    ClassroomAccessError,
    ClassroomLocked,
    PermissionDenied,
    TooManyAttempts,
    UserBanned,
    WrongClassroomPassword,
    active_members,
    approve_waiting_room,
    attendance_summary,
    banned_members,
    broadcast,
    create_classroom,
    deactivate_classroom,
    end_classroom_for_all,
    delete_shared_file,
    deactivate_member,
    deny_waiting_room,
    end_session,
    get_active_member,
    get_live_session,
    guest_session_key,
    join_classroom,
    join_classroom_guest,
    leave_classroom,
    lift_ban,
    mute_all,
    password_attempts_blocked_ip,
    register_failed_password_ip,
    remove_member,
    request_unmute,
    resolve_member,
    set_classroom_locked,
    set_member_muted,
    set_member_permission,
    set_member_role,
    set_annotation_open,
    set_presentation,
    start_session,
    update_settings,
)

logger = logging.getLogger("classrooms.views")


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------
@login_required
@require_http_methods(["GET"])
def dashboard_view(request):
    """User dashboard: owned classrooms, membership summary, upcoming sessions."""
    owned = (
        request.user.owned_classrooms.annotate(
            participant_count=Count("members", filter=Q(members__is_active=True), distinct=True)
        ).order_by("-created_at")
    )
    joined_count = request.user.classroom_memberships.filter(is_active=True).count()
    joined = (
        request.user.classroom_memberships
        .filter(is_active=True)
        .exclude(classroom__owner=request.user)
        .select_related("classroom")
        .order_by("-joined_at")[:20]
    )
    upcoming = (
        ClassroomSession.objects.filter(
            Q(classroom__owner=request.user)
            | Q(classroom__members__user=request.user, classroom__members__is_active=True),
            status=ClassroomSession.Status.SCHEDULED,
        )
        .select_related("classroom")
        .distinct()
        .order_by("scheduled_start")[:10]
    )
    return render(
        request,
        "classrooms/dashboard.html",
        {
            "owned_classrooms": owned, "joined_count": joined_count,
            "upcoming_sessions": upcoming, "joined_memberships": joined,
        },
    )


# ---------------------------------------------------------------------------
# Classroom management
# ---------------------------------------------------------------------------
@login_required
@require_http_methods(["GET", "POST"])
def classroom_create_view(request):
    form = ClassroomForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        classroom = create_classroom(
            owner=request.user,
            title=form.cleaned_data["title"],
            description=form.cleaned_data.get("description", ""),
            password=form.cleaned_data.get("password"),
            is_password_protected=form.cleaned_data.get("is_password_protected", False),
            settings=form.settings_dict(),
        )
        messages.success(request, "کلاس با موفقیت ساخته شد.")
        return redirect("room:lobby", room_code=classroom.room_code)
    return render(request, "classrooms/classroom_form.html", {"form": form})


@login_required
@require_http_methods(["GET"])
def classroom_list_view(request):
    owned = request.user.owned_classrooms.annotate(
        participant_count=Count("members", filter=Q(members__is_active=True), distinct=True)
    ).order_by("-created_at")
    memberships = (
        request.user.classroom_memberships.filter(is_active=True)
        .select_related("classroom")
        .exclude(role=Role.OWNER)
        .order_by("-joined_at")
    )
    return render(
        request,
        "classrooms/classroom_list.html",
        {"owned_classrooms": owned, "memberships": memberships},
    )


@login_required
@require_http_methods(["GET", "POST"])
def classroom_detail_view(request, room_code: str):
    """Owner-facing management page (settings, scheduling, sessions)."""
    classroom = get_object_or_404(
        Classroom.objects.select_related("owner"), room_code=room_code, owner=request.user, is_active=True
    )
    schedule_form = SessionScheduleForm(request.POST or None, prefix="sched")
    settings_form = ClassroomSettingsForm(instance=classroom)
    customization_form = ClassroomCustomizationForm(instance=classroom)
    if request.method == "POST" and "save_customization" in request.POST:
        customization_form = ClassroomCustomizationForm(request.POST, request.FILES, instance=classroom)
        if customization_form.is_valid():
            customization_form.save()
            from .services import broadcast

            broadcast(classroom.room_code, {
                "type": "classroom_updated",
                "title": classroom.title,
                "accent_color": classroom.accent_color,
                "welcome_message": classroom.welcome_message,
            })
            messages.success(request, "شخصی‌سازی کلاس ذخیره شد.")
            return redirect("classrooms:detail", room_code=room_code)
    if request.method == "POST" and "schedule_session" in request.POST:
        if schedule_form.is_valid():
            session = schedule_form.save(commit=False)
            session.classroom = classroom
            session.host = request.user
            session.timezone_name = settings.TIME_ZONE
            session.save()
            messages.success(request, "جلسه زمان‌بندی شد.")
            return redirect("classrooms:detail", room_code=room_code)
    if request.method == "POST" and "save_settings" in request.POST:
        settings_form = ClassroomSettingsForm(request.POST, instance=classroom)
        if settings_form.is_valid():
            changed = list(settings_form.changed_data)
            if changed:
                update_settings(
                    classroom,
                    request.user,
                    {field: settings_form.cleaned_data[field] for field in changed},
                )
            messages.success(request, "تنظیمات کلاس ذخیره شد.")
            return redirect("classrooms:detail", room_code=room_code)

    members = active_members(classroom)
    sessions = classroom.sessions.all()[:20]
    return render(
        request,
        "classrooms/classroom_detail.html",
        {
            "classroom": classroom,
            "members": members,
            "banned": banned_members(classroom),
            "sessions": sessions,
            "schedule_form": schedule_form,
            "settings_form": settings_form,
            "customization_form": customization_form,
        },
    )


@login_required
@require_POST
def classroom_delete_view(request, room_code: str):
    classroom = get_object_or_404(Classroom, room_code=room_code, owner=request.user, is_active=True)
    try:
        deactivate_classroom(classroom, request.user)
    except PermissionDenied as exc:
        return _json_error(exc)
    messages.success(request, "کلاس غیرفعال شد.")
    return redirect("classrooms:list")


# ---------------------------------------------------------------------------
# Lobby & room
# ---------------------------------------------------------------------------
@require_http_methods(["GET", "POST"])
def lobby_view(request, room_code: str):
    """Classroom lobby — works for registered users AND guests.

    Registered members are routed straight through; guests get the
    display-name form (+ password gate when the classroom requires one).
    The password is only ever POSTed — never in a URL.
    """
    classroom = get_object_or_404(Classroom.objects.select_related("owner"), room_code=room_code)
    if not classroom.is_active:
        return render(request, "classrooms/ended.html", {"classroom": classroom}, status=410)
    authenticated = request.user.is_authenticated

    # existing participant (user or session-bound guest) goes straight in
    existing = resolve_member(request, classroom)
    if existing and not existing.in_waiting_room:
        return redirect("room:room", room_code=classroom.room_code)
    if existing and existing.in_waiting_room:
        return redirect("room:waiting", room_code=classroom.room_code)

    if authenticated:
        join_form = ClassroomJoinForm() if classroom.is_password_protected else None
    else:
        if not classroom.allow_guests:
            return render(request, "classrooms/guests_disabled.html", {"classroom": classroom}, status=403)
        join_form = GuestJoinForm(requires_password=classroom.is_password_protected)

    def _lobby_ctx(**extra):
        ctx = {"classroom": classroom, "join_form": join_form, "authenticated": authenticated}
        ctx.update(extra)
        return ctx

    if request.method == "POST":
        client_ip = request.META.get("REMOTE_ADDR", "")
        if classroom.is_password_protected and password_attempts_blocked_ip(classroom, client_ip):
            messages.error(request, "تلاش‌های ناموفق بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.")
            return render(request, "classrooms/lobby.html", _lobby_ctx())
        if authenticated:
            raw_password = ""
            if classroom.is_password_protected:
                join_form = ClassroomJoinForm(request.POST)
                if not join_form.is_valid():
                    return render(request, "classrooms/lobby.html", _lobby_ctx())
                raw_password = join_form.cleaned_data["password"]
            try:
                member = join_classroom(classroom, request.user, raw_password)
            except WrongClassroomPassword as exc:
                register_failed_password_ip(classroom, client_ip)
                if join_form is not None:
                    join_form.add_error("password", str(exc))
                else:
                    messages.error(request, str(exc))
                return render(request, "classrooms/lobby.html", _lobby_ctx())
            except (ClassroomLocked, UserBanned, TooManyAttempts, ClassroomAccessError) as exc:
                messages.error(request, str(exc))
                return render(request, "classrooms/lobby.html", _lobby_ctx())
        else:
            join_form = GuestJoinForm(
                request.POST, requires_password=classroom.is_password_protected
            )
            if not join_form.is_valid():
                return render(request, "classrooms/lobby.html", _lobby_ctx())
            try:
                member = join_classroom_guest(
                    classroom,
                    join_form.cleaned_data["display_name"],
                    join_form.cleaned_data.get("password", ""),
                    ip=client_ip or None,
                )
            except WrongClassroomPassword as exc:
                register_failed_password_ip(classroom, client_ip)
                if "password" in join_form.fields:
                    join_form.add_error("password", str(exc))
                else:
                    messages.error(request, str(exc))
                return render(request, "classrooms/lobby.html", _lobby_ctx())
            except (ClassroomLocked, TooManyAttempts, ClassroomAccessError) as exc:
                messages.error(request, str(exc))
                return render(request, "classrooms/lobby.html", _lobby_ctx())
            # bind the guest membership to THIS browser session
            request.session[guest_session_key(classroom)] = member.guest_uid

        if member.in_waiting_room:
            return redirect("room:waiting", room_code=classroom.room_code)
        return redirect("room:room", room_code=classroom.room_code)

    return render(request, "classrooms/lobby.html", _lobby_ctx(
        default_name=request.user.name if authenticated else "",
    ))


@require_http_methods(["GET"])
def waiting_view(request, room_code: str):
    """Waiting room — held here until the host approves entry (users + guests)."""
    classroom = get_object_or_404(Classroom, room_code=room_code, is_active=True)
    member = resolve_member(request, classroom)
    if member is None:
        return redirect("room:lobby", room_code=room_code)
    if not member.in_waiting_room:
        return redirect("room:room", room_code=room_code)
    return render(request, "classrooms/waiting_room.html", {"classroom": classroom, "member": member})


def _room_context(request, classroom: Classroom, member) -> dict:
    perms = effective_permissions(member, classroom)
    session = get_live_session(classroom)
    files = list(classroom.files.select_related("uploader")[:50])
    from quizzes.models import Quiz  # local import keeps app loading order simple

    return {
        "classroom": classroom,
        "member": member,
        "members": [m for m in active_members(classroom)],
        "permissions": perms,
        "is_privileged": is_privileged(member),
        # Owner/moderator/presenter own the shared surface (board open/close,
        # pages, slide deck).  Everything the room renders about «who may
        # control» comes from this one flag.
        "can_control_board": is_authority(member),
        # Nothing at all is switched on for this member yet (student/guest
        # before the owner grants anything): the room says so instead of
        # showing a wall of dead buttons.
        "read_only": not any(perms.values()),
        "is_owner": member.role == Role.OWNER,
        "live_session": session,
        "files": files,
        "quizzes": list(Quiz.objects.filter(classroom=classroom)[:20]),
        "max_upload_mb": settings.MAX_UPLOAD_MB,
        "allowed_extensions": sorted(ALLOWED_EXTENSIONS),
        "media": media_config_payload(),
        "waiting_room_count": classroom.members.filter(is_active=True, in_waiting_room=True).count(),
        "annotation_open": classroom.annotation_open,
        # the room takes over the whole viewport — no header/footer/margins
        "full_page": True,
    }


@require_http_methods(["GET"])
def room_view(request, room_code: str):
    """The live classroom interface.  Requires an active membership
    (registered user or session-bound guest)."""
    classroom = get_object_or_404(Classroom, room_code=room_code, is_active=True)
    member = resolve_member(request, classroom)
    if member is None:
        messages.info(request, "برای ورود به کلاس ابتدا باید عضو شوید.")
        return redirect("room:lobby", room_code=room_code)
    if member.in_waiting_room:
        return redirect("room:waiting", room_code=room_code)
    return render(request, "classrooms/room.html", _room_context(request, classroom, member))


@require_POST
def leave_view(request, room_code: str):
    """Leave the classroom — guests are unbound from their session too."""
    classroom = get_object_or_404(Classroom, room_code=room_code)
    member = resolve_member(request, classroom)
    if member is not None:
        if member.is_guest:
            deactivate_member(classroom, member, event="left")
            request.session.pop(guest_session_key(classroom), None)
        else:
            leave_classroom(classroom, request.user)
    messages.success(request, "از کلاس خارج شدید.")
    return redirect("dashboard" if request.user.is_authenticated else "home")


@login_required
@require_POST
def end_class_view(request, room_code: str):
    """Owner-only: end the meeting for everyone (server-enforced)."""
    classroom = get_object_or_404(Classroom, room_code=room_code, is_active=True)
    try:
        removed = end_classroom_for_all(classroom, request.user)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ClassroomAccessError as exc:
        return _json_error(exc, status=400)
    return JsonResponse({"ok": True, "members": removed})


# ---------------------------------------------------------------------------
# Media token (LiveKit) — short-lived, scoped to effective permissions
# ---------------------------------------------------------------------------
@never_cache
@require_http_methods(["GET"])
def media_token_view(request, room_code: str):
    """Short-lived LiveKit JWT for the current participant (user or guest).

    Publish rights come from server-side effective permissions — the
    client cannot widen them.
    """
    if not media_enabled():
        return JsonResponse({"detail": "سرور رسانه پیکربندی نشده است."}, status=503)
    classroom = get_object_or_404(Classroom, room_code=room_code, is_active=True)
    member = resolve_member(request, classroom)
    if member is None or member.in_waiting_room:
        return JsonResponse({"detail": "دسترسی غیرمجاز."}, status=403)
    perms = effective_permissions(member, classroom)
    token = generate_media_token(member, classroom, perms)
    return JsonResponse({"token": token, "url": settings.LIVEKIT_URL})


# ---------------------------------------------------------------------------
# Host actions (JSON, CSRF-protected, broadcast over WebSocket)
# ---------------------------------------------------------------------------
def _json_error(exc: Exception, status: int = 403) -> JsonResponse:
    return JsonResponse({"detail": str(exc)}, status=status)


def _validation_message(exc: Exception) -> str:
    """First user-facing message of a validator error.

    ``ValidationError.message`` is deprecated (and gone in newer Django);
    ``str(exc)`` on its own renders the whole list ("['…']") to the user.
    """
    messages = getattr(exc, "messages", None)
    if messages:
        return messages[0]
    return str(exc)


def _json_body(request) -> dict:
    """Parse a JSON request body safely.

    Malformed JSON must be a clean 400 — never an unhandled 500 that an
    attacker can use to probe internals or spam error logs.
    """
    def reject_non_finite(value):
        raise ValueError(f"Non-finite JSON number: {value}")

    try:
        body = json.loads(request.body or "{}", parse_constant=reject_non_finite)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise ValueError("بدنهٔ درخواست JSON معتبر نیست.") from exc
    if not isinstance(body, dict):
        raise ValueError("بدنهٔ درخواست باید یک شیء JSON باشد.")
    return body


@login_required
@require_POST
def member_permission_view(request, room_code: str, member_id: int):
    """Toggle one capability flag of a participant."""
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        permissions = set_member_permission(
            classroom, request.user, member_id, body.get("permission", ""), body.get("value")
        )
    except PermissionDenied as exc:
        return _json_error(exc)
    except ValueError as exc:
        return _json_error(exc, status=400)
    return JsonResponse({"ok": True, "permissions": permissions})


@login_required
@require_POST
def member_role_view(request, room_code: str, member_id: int):
    """Assign MODERATOR/PRESENTER/STUDENT (OWNER-only)."""
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        set_member_role(classroom, request.user, member_id, body.get("role", ""))
    except PermissionDenied as exc:
        return _json_error(exc)
    except ValueError as exc:
        return _json_error(exc, status=400)
    return JsonResponse({"ok": True})


@login_required
@require_POST
def member_mute_view(request, room_code: str, member_id: int):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        request_unmute_value = body.get("request_unmute", False)
        if type(request_unmute_value) is not bool:
            return JsonResponse({"detail": "request_unmute باید بولی باشد."}, status=400)
        if request_unmute_value:
            request_unmute(classroom, request.user, member_id)
        else:
            muted = body.get("muted", True)
            if type(muted) is not bool:
                return JsonResponse({"detail": "muted باید بولی باشد."}, status=400)
            set_member_muted(classroom, request.user, member_id, muted)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ValueError as exc:
        return _json_error(exc, status=400)
    return JsonResponse({"ok": True})


@login_required
@require_POST
def mute_all_view(request, room_code: str):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        count = mute_all(classroom, request.user)
    except PermissionDenied as exc:
        return _json_error(exc)
    return JsonResponse({"ok": True, "muted": count})


@login_required
@require_POST
def member_remove_view(request, room_code: str, member_id: int):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        ban_minutes = body.get("ban_minutes", 0)
        if isinstance(ban_minutes, bool) or not isinstance(ban_minutes, int):
            raise ValueError("ban_minutes نامعتبر است.")
    except (TypeError, ValueError):
        return JsonResponse({"detail": "ban_minutes نامعتبر است."}, status=400)
    try:
        remove_member(classroom, request.user, member_id, ban_minutes=ban_minutes)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ValueError as exc:
        return _json_error(exc, status=400)
    return JsonResponse({"ok": True})


@login_required
@require_POST
def member_unban_view(request, room_code: str, member_id: int):
    """Privileged: lift a re-entry ban (the counterpart of «اخراج»)."""
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        lift_ban(classroom, request.user, member_id)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ClassroomAccessError as exc:
        return _json_error(exc, status=404)
    except ValueError as exc:
        return _json_error(exc, status=400)
    return JsonResponse({"ok": True})


@login_required
@require_POST
def waiting_room_action_view(request, room_code: str, member_id: int):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        approve = body.get("approve")
        if type(approve) is not bool:
            return JsonResponse({"detail": "approve باید بولی باشد."}, status=400)
        if approve:
            approve_waiting_room(classroom, request.user, member_id)
        else:
            deny_waiting_room(classroom, request.user, member_id)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ValueError as exc:
        return _json_error(exc, status=400)
    except ClassroomAccessError as exc:
        return _json_error(exc, status=404)
    return JsonResponse({"ok": True})


@login_required
@require_POST
def lock_view(request, room_code: str):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        set_classroom_locked(classroom, request.user, body.get("locked", True))
    except PermissionDenied as exc:
        return _json_error(exc)
    except ValueError as exc:
        return _json_error(exc, status=400)
    return JsonResponse({"ok": True})


@login_required
@require_POST
def settings_view(request, room_code: str):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        values = body.get("settings") if isinstance(body.get("settings"), dict) else body
        update_settings(classroom, request.user, values)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ValueError as exc:
        return _json_error(exc, status=400)
    return JsonResponse({"ok": True})


@login_required
@require_POST
def presentation_view(request, room_code: str):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        page = body.get("page", 1)
        if isinstance(page, bool) or not isinstance(page, int):
            raise ValueError("page must be an integer")
    except (TypeError, ValueError):
        return JsonResponse({"detail": "page نامعتبر است."}, status=400)
    try:
        set_presentation(classroom, request.user, body.get("file_id"), page)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ClassroomAccessError as exc:
        return _json_error(exc, status=404)
    except ValueError:
        return JsonResponse({"detail": "page نامعتبر است."}, status=400)
    return JsonResponse({"ok": True})


@login_required
@require_POST
def presentation_annotation_view(request, room_code: str):
    """Open/lock annotation on the presented file (presenters only)."""
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
    except (TypeError, ValueError):
        return JsonResponse({"detail": "درخواست نامعتبر است."}, status=400)
    opened = body.get("open", True)
    if not isinstance(opened, bool):
        return JsonResponse({"detail": "مقدار open باید بولی باشد."}, status=400)
    try:
        set_annotation_open(classroom, request.user, opened)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ClassroomAccessError as exc:
        return _json_error(exc, status=404)
    return JsonResponse({"ok": True, "open": opened})


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------
@login_required
@require_POST
def session_start_view(request, room_code: str):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        session_id = body.get("session_id", 0)
        if isinstance(session_id, bool) or not isinstance(session_id, int):
            raise ValueError("session_id must be an integer")
    except (TypeError, ValueError):
        return JsonResponse({"detail": "session_id نامعتبر است."}, status=400)
    session = None
    if session_id:
        session = get_object_or_404(ClassroomSession, id=session_id, classroom=classroom)
    try:
        live = start_session(classroom, request.user, session)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ClassroomAccessError as exc:
        return _json_error(exc, status=404)
    return JsonResponse({"ok": True, "session_id": live.id})


@login_required
@require_POST
def session_end_view(request, room_code: str, session_id: int):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    session = get_object_or_404(ClassroomSession, id=session_id, classroom=classroom)
    try:
        end_session(session, request.user)
    except PermissionDenied as exc:
        return _json_error(exc)
    return JsonResponse({"ok": True})


@login_required
@require_http_methods(["GET"])
def attendance_view(request, room_code: str, session_id: int):
    """Post-session attendance report (owner/moderator only)."""
    classroom = get_object_or_404(Classroom, room_code=room_code)
    member = get_active_member(classroom, request.user)
    if not is_privileged(member):
        raise Http404
    session = get_object_or_404(ClassroomSession, id=session_id, classroom=classroom)
    summary = attendance_summary(session)

    if request.GET.get("format") == "csv":
        # Excel-friendly: UTF-8 BOM so Persian headers open correctly.
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        filename = f"attendance-{classroom.room_code}-{session.id}.csv"
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        response.write("\ufeff")
        writer = csv.writer(response)
        writer.writerow(["کلاس", classroom.title])
        writer.writerow(["جلسه", session.id])
        writer.writerow(["کاربر", "تعداد ورود", "مجموع حضور (ثانیه)", "مجموع حضور (دقیقه)"])
        for row in summary:
            writer.writerow([
                row["username"], row["joins"], row["total_seconds"],
                round(row["total_seconds"] / 60, 1),
            ])
        return response

    return render(
        request,
        "classrooms/attendance.html",
        {"classroom": classroom, "session": session, "summary": summary},
    )


# ---------------------------------------------------------------------------
# File sharing
# ---------------------------------------------------------------------------
@login_required
@require_POST
def file_upload_view(request, room_code: str):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    member = get_active_member(classroom, request.user)
    perms = effective_permissions(member, classroom) if member else {}
    if not perms.get("can_upload_files"):
        return JsonResponse({"detail": "شما اجازهٔ بارگذاری فایل ندارید."}, status=403)

    upload = request.FILES.get("file")
    if upload is None:
        return JsonResponse({"detail": "فایلی ارسال نشد."}, status=400)
    # per-user throttle — protects the disk from rapid-fire uploads
    from core.ratelimit import hit as rate_hit
    if not rate_hit(f"upload:{request.user.id}",
                    settings.UPLOAD_RATE_LIMIT, settings.UPLOAD_RATE_WINDOW):
        return JsonResponse(
            {"detail": "بارگذاری‌های پشت‌سرهم زیاد است؛ چند لحظه صبر کنید."},
            status=429,
        )
    if classroom.files.count() >= MAX_FILES_PER_CLASSROOM:
        return JsonResponse(
            {"detail": f"حداکثر تعداد فایل‌های این کلاس ({MAX_FILES_PER_CLASSROOM}) پر شده است."},
            status=400,
        )
    try:
        safe_name = validate_upload(upload, settings.MAX_UPLOAD_MB * 1024 * 1024)
    except ValidationError as exc:
        return JsonResponse({"detail": _validation_message(exc)}, status=400)

    shared = SharedFile.objects.create(
        classroom=classroom,
        session=get_live_session(classroom),
        uploader=request.user,
        file=upload,
        original_name=safe_name,
        size=upload.size,
        content_type=(upload.content_type or "application/octet-stream")[:128],
    )
    broadcast(classroom.room_code, {
        "type": "file_uploaded",
        "file": {
            "id": shared.id,
            "name": shared.original_name,
            "size": shared.size_display,
            "uploader": request.user.name,
            "uploader_id": request.user.id,
            "kind": shared.type_kind,
            "has_pdf": bool(shared.pdf_version),
            "url": f"/class/{classroom.room_code}/files/{shared.id}/download/",
        },
    })
    # Office → PDF runs as a background job, so the upload returns at once:
    # the room is told separately (`file_presentable`) when the presentable
    # copy is ready.  Without a broker the job runs inline in this request —
    # same result, and never a failed upload.
    dispatch(convert_office_file, shared.id)
    return JsonResponse({"ok": True, "id": shared.id, "name": shared.original_name,
                         "has_pdf": bool(shared.pdf_version)})


@require_http_methods(["GET"])
def file_download_view(request, room_code: str, file_id: int):
    """Download — membership-gated (users + guests); filename comes from
    our safe copy."""
    classroom = get_object_or_404(Classroom, room_code=room_code, is_active=True)
    member = resolve_member(request, classroom)
    if member is None or member.in_waiting_room:
        # not admitted yet — shared material must stay hidden
        raise Http404
    shared = get_object_or_404(SharedFile, id=file_id, classroom=classroom)
    # ?inline=1 → the presentation renderer draws these bytes in the page.
    # Only allow-listed (pdf/image) types are ever served inline.
    inline = request.GET.get("inline") in {"1", "true", "yes"}
    if request.GET.get("format") == "pdf":
        # the server-converted copy used by the presentation renderer
        if not shared.pdf_version:
            raise Http404
        pdf_name = shared.original_name.rsplit(".", 1)[0] + ".pdf"
        return private_file_response(shared.pdf_version, pdf_name, inline=inline)
    return private_file_response(shared.file, shared.original_name, inline=inline)


@require_http_methods(["POST"])
def file_delete_view(request, room_code: str, file_id: int):
    """Delete a shared file — privileged members or the uploader.

    Business rules (and the physical cleanup) live in
    ``services.delete_shared_file``; this is only the HTTP boundary.
    """
    classroom = get_object_or_404(Classroom, room_code=room_code)
    member = resolve_member(request, classroom)
    try:
        delete_shared_file(classroom, member, file_id)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ClassroomAccessError as exc:
        return _json_error(exc, status=404)
    return JsonResponse({"ok": True})
