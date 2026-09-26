"""HTTP views: dashboard, classroom management, lobby, room, host actions.

Business rules live in :mod:`classrooms.services` — these views handle
requests/responses and authorisation redirects only.  Host-control
endpoints are JSON POSTs (CSRF-protected) whose effects are broadcast to
connected clients over the classroom WebSocket.
"""
from __future__ import annotations

import json
import logging

from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.db.models import Count, Q
from django.http import FileResponse, Http404, HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.views.decorators.http import require_http_methods, require_POST

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
from .models import Classroom, ClassroomSession, SharedFile
from .permissions import PRIVILEGED_ROLES, Role, effective_permissions, is_privileged
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
    create_classroom,
    delete_shared_file,
    deny_waiting_room,
    end_session,
    get_active_member,
    get_live_session,
    guest_session_key,
    join_classroom,
    join_classroom_guest,
    leave_classroom,
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
    upcoming = (
        ClassroomSession.objects.filter(
            classroom__owner=request.user, status=ClassroomSession.Status.SCHEDULED
        )
        .select_related("classroom")
        .order_by("scheduled_start")[:10]
    )
    return render(
        request,
        "classrooms/dashboard.html",
        {"owned_classrooms": owned, "joined_count": joined_count, "upcoming_sessions": upcoming},
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
        Classroom.objects.select_related("owner"), room_code=room_code, owner=request.user
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
            settings_form.save()
            from .services import broadcast

            if changed:
                broadcast(classroom.room_code, {"type": "settings_changed", "settings": {
                    f: bool(getattr(classroom, f)) for f in changed
                }})
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
            "sessions": sessions,
            "schedule_form": schedule_form,
            "settings_form": settings_form,
            "customization_form": customization_form,
        },
    )


@login_required
@require_POST
def classroom_delete_view(request, room_code: str):
    classroom = get_object_or_404(Classroom, room_code=room_code, owner=request.user)
    classroom.is_active = False
    classroom.save(update_fields=["is_active", "updated_at"])
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
    return {
        "classroom": classroom,
        "member": member,
        "members": [m for m in active_members(classroom)],
        "permissions": perms,
        "is_privileged": is_privileged(member),
        "live_session": session,
        "files": files,
        "max_upload_mb": settings.MAX_UPLOAD_MB,
        "allowed_extensions": sorted(ALLOWED_EXTENSIONS),
        "media": media_config_payload(),
        "waiting_room_count": classroom.members.filter(is_active=True, in_waiting_room=True).count(),
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
            member.is_active = False
            member.save(update_fields=["is_active"])
            request.session.pop(guest_session_key(classroom), None)
        else:
            leave_classroom(classroom, request.user)
    messages.success(request, "از کلاس خارج شدید.")
    return redirect("dashboard" if request.user.is_authenticated else "home")


# ---------------------------------------------------------------------------
# Media token (LiveKit) — short-lived, scoped to effective permissions
# ---------------------------------------------------------------------------
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


def _json_body(request) -> dict:
    """Parse a JSON request body safely.

    Malformed JSON must be a clean 400 — never an unhandled 500 that an
    attacker can use to probe internals or spam error logs.
    """
    try:
        body = json.loads(request.body or "{}")
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
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
        set_member_permission(
            classroom, request.user, member_id, body.get("permission", ""), bool(body.get("value"))
        )
    except PermissionDenied as exc:
        return _json_error(exc)
    except ValueError as exc:
        return _json_error(exc, status=400)
    return JsonResponse({"ok": True})


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
        if body.get("request_unmute"):
            request_unmute(classroom, request.user, member_id)
        else:
            set_member_muted(classroom, request.user, member_id, bool(body.get("muted", True)))
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
        ban_minutes = int(body.get("ban_minutes") or 0)
        remove_member(classroom, request.user, member_id, ban_minutes=ban_minutes)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ValueError:
        return JsonResponse({"detail": "ban_minutes نامعتبر است."}, status=400)
    return JsonResponse({"ok": True})


@login_required
@require_POST
def waiting_room_action_view(request, room_code: str, member_id: int):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        if body.get("approve"):
            approve_waiting_room(classroom, request.user, member_id)
        else:
            deny_waiting_room(classroom, request.user, member_id)
    except PermissionDenied as exc:
        return _json_error(exc)
    except ValueError as exc:
        return _json_error(exc, status=400)
    return JsonResponse({"ok": True})


@login_required
@require_POST
def lock_view(request, room_code: str):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        set_classroom_locked(classroom, request.user, bool(body.get("locked", True)))
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
        set_presentation(classroom, request.user, body.get("file_id"), int(body.get("page") or 1))
    except PermissionDenied as exc:
        return _json_error(exc)
    except ClassroomAccessError as exc:
        return _json_error(exc, status=404)
    except ValueError:
        return JsonResponse({"detail": "page نامعتبر است."}, status=400)
    return JsonResponse({"ok": True})


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------
@login_required
@require_POST
def session_start_view(request, room_code: str):
    classroom = get_object_or_404(Classroom, room_code=room_code)
    try:
        body = _json_body(request)
        session_id = int(body.get("session_id") or 0)
    except ValueError:
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
    return render(
        request,
        "classrooms/attendance.html",
        {"classroom": classroom, "session": session, "summary": attendance_summary(session)},
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
    except Exception as exc:  # ValidationError from the validator
        return JsonResponse({"detail": getattr(exc, "message", str(exc))}, status=400)

    shared = SharedFile.objects.create(
        classroom=classroom,
        session=get_live_session(classroom),
        uploader=request.user,
        file=upload,
        original_name=safe_name,
        size=upload.size,
        content_type=(upload.content_type or "application/octet-stream")[:128],
    )
    # Office → PDF (when LibreOffice is installed) so PPTX/DOCX/XLSX can be
    # presented in the browser; a no-op otherwise — never fails the upload.
    from .office_convert import convert_to_pdf
    convert_to_pdf(shared)

    from .services import broadcast

    broadcast(classroom.room_code, {
        "type": "file_uploaded",
        "file": {
            "id": shared.id,
            "name": shared.original_name,
            "size": shared.size_display,
            "uploader": request.user.name,
            "uploader_id": request.user.id,
            "icon": shared.type_icon,
            "has_pdf": bool(shared.pdf_version),
            "url": f"/class/{classroom.room_code}/files/{shared.id}/download/",
        },
    })
    return JsonResponse({"ok": True, "id": shared.id, "name": shared.original_name})


@require_http_methods(["GET"])
def file_download_view(request, room_code: str, file_id: int):
    """Download — membership-gated (users + guests); filename comes from
    our safe copy."""
    classroom = get_object_or_404(Classroom, room_code=room_code)
    member = resolve_member(request, classroom)
    if member is None or member.in_waiting_room:
        # not admitted yet — shared material must stay hidden
        raise Http404
    shared = get_object_or_404(SharedFile, id=file_id, classroom=classroom)
    if request.GET.get("format") == "pdf":
        # the server-converted copy used by the presentation renderer
        if not shared.pdf_version:
            raise Http404
        pdf_name = shared.original_name.rsplit(".", 1)[0] + ".pdf"
        return FileResponse(shared.pdf_version.open("rb"), as_attachment=True, filename=pdf_name)
    response = FileResponse(shared.file.open("rb"), as_attachment=True, filename=shared.original_name)
    return response


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
