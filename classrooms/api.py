"""REST API views.

The Django Templates frontend remains primary; this API is the stable
seam for programmatic clients.  Authorization mirrors the HTML views —
everything is re-checked server-side through the same services layer.
"""
from __future__ import annotations

from django.shortcuts import get_object_or_404
from rest_framework import generics, permissions, status
from rest_framework.authtoken.views import ObtainAuthToken
from rest_framework.response import Response
from rest_framework.views import APIView

from chat.models import ChatMessage

from .models import Classroom, ClassroomMember, ClassroomSession, SharedFile
from .permissions import Role, is_privileged
from .serializers import (
    ChatMessageSerializer,
    ClassroomCreateSerializer,
    ClassroomSerializer,
    FileSerializer,
    MemberSerializer,
    MemberUpdateSerializer,
    RegisterSerializer,
    SessionCreateSerializer,
    SessionSerializer,
)
from .services import (
    PermissionDenied,
    active_members,
    attendance_summary,
    create_classroom,
    end_session,
    get_active_member,
    set_member_permission,
    set_member_role,
    start_session,
)


class RegisterAPIView(generics.CreateAPIView):
    """POST /api/auth/register/"""

    serializer_class = RegisterSerializer
    permission_classes = [permissions.AllowAny]


class LoginAPIView(ObtainAuthToken):
    """POST /api/auth/login/ → returns an auth token."""

    permission_classes = [permissions.AllowAny]


class _ClassroomScopedMixin:
    """Resolve the classroom and (optionally) require an active membership."""

    require_privileged = False

    def get_classroom(self) -> Classroom:
        return get_object_or_404(Classroom, room_code=self.kwargs["room_code"])

    def get_member(self) -> ClassroomMember | None:
        if not hasattr(self, "_member"):
            self._member = get_active_member(self.get_classroom(), self.request.user)
        return self._member

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        member = self.get_member()
        if member is None or (self.require_privileged and not is_privileged(member)):
            from rest_framework.exceptions import PermissionDenied as DRFPermissionDenied

            raise DRFPermissionDenied("دسترسی غیرمجاز به این کلاس.")


class ClassroomListCreateAPIView(generics.ListAPIView):
    """GET lists the caller's owned classrooms; POST creates one."""

    serializer_class = ClassroomSerializer

    def get_queryset(self):
        return Classroom.objects.filter(owner=self.request.user)

    def post(self, request, *args, **kwargs):
        serializer = ClassroomCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        classroom = create_classroom(
            owner=request.user,
            title=data["title"],
            description=data.get("description", ""),
            password=data.get("password") or None,
            is_password_protected=data.get("is_password_protected", False),
        )
        return Response(
            ClassroomSerializer(classroom, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )


class ClassroomDetailAPIView(generics.RetrieveAPIView):
    """GET /api/classrooms/<room_code>/ — owner or active member only."""

    serializer_class = ClassroomSerializer
    lookup_field = "room_code"

    def get_queryset(self):
        user = self.request.user
        return Classroom.objects.filter(owner=user) | Classroom.objects.filter(
            members__user=user, members__is_active=True
        )


class ClassroomParticipantsAPIView(_ClassroomScopedMixin, generics.ListAPIView):
    """GET /api/classrooms/<room_code>/participants/?role=&q="""

    serializer_class = MemberSerializer
    pagination_class = None

    def get_queryset(self):
        qs = (
            ClassroomMember.objects.filter(classroom=self.get_classroom(), is_active=True)
            .select_related("user")
            .order_by("role", "joined_at")
        )
        role = self.request.query_params.get("role")
        if role in Role.values:
            qs = qs.filter(role=role)
        q = self.request.query_params.get("q")
        if q:
            from django.db.models import Q

            qs = qs.filter(Q(user__username__icontains=q) | Q(user__first_name__icontains=q) | Q(user__last_name__icontains=q) | Q(user__display_name__icontains=q))
        return qs


class ParticipantUpdateAPIView(_ClassroomScopedMixin, APIView):
    """PATCH /api/classrooms/<code>/participants/<id>/ — role & permissions."""

    require_privileged = True

    def patch(self, request, room_code, member_id):
        serializer = MemberUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        classroom = self.get_classroom()
        try:
            if "role" in data:
                set_member_role(classroom, request.user, member_id, data["role"])
            for name, value in (data.get("permissions") or {}).items():
                set_member_permission(classroom, request.user, member_id, name, value)
        except PermissionDenied as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_403_FORBIDDEN)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        member = ClassroomMember.objects.select_related("user").get(id=member_id, classroom=classroom)
        return Response(MemberSerializer(member).data)


class SessionListCreateAPIView(_ClassroomScopedMixin, generics.ListAPIView):
    """GET list sessions; POST schedule a new one (privileged)."""

    serializer_class = SessionSerializer

    def get_queryset(self):
        return ClassroomSession.objects.filter(classroom=self.get_classroom()).select_related("host")

    def post(self, request, *args, **kwargs):
        if not is_privileged(self.get_member()):
            return Response({"detail": "فقط میزبان می‌تواند جلسه زمان‌بندی کند."}, status=status.HTTP_403_FORBIDDEN)
        serializer = SessionCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        session = ClassroomSession.objects.create(
            classroom=self.get_classroom(),
            host=request.user,
            title=data.get("title") or "جلسه",
            scheduled_start=data.get("scheduled_start"),
            scheduled_end=data.get("scheduled_end"),
        )
        return Response(SessionSerializer(session).data, status=status.HTTP_201_CREATED)


class SessionActionAPIView(_ClassroomScopedMixin, APIView):
    """POST /api/classrooms/<code>/sessions/<id>/start|end/"""

    require_privileged = True

    def post(self, request, room_code, session_id, action):
        classroom = self.get_classroom()
        session = get_object_or_404(ClassroomSession, id=session_id, classroom=classroom)
        if action == "start":
            start_session(classroom, request.user, session)
        else:
            end_session(session, request.user)
        session.refresh_from_db()
        return Response(SessionSerializer(session).data)


class MessageListAPIView(_ClassroomScopedMixin, generics.ListAPIView):
    """GET /api/classrooms/<code>/messages/ — chat history."""

    serializer_class = ChatMessageSerializer
    pagination_class = None

    def get_queryset(self):
        return (
            ChatMessage.objects.filter(classroom=self.get_classroom())
            .select_related("sender")
            .order_by("-created_at")[:200]
        )

    def list(self, request, *args, **kwargs):
        rows = [m.to_dict() for m in reversed(list(self.get_queryset()))]
        return Response(rows)


class FileListAPIView(_ClassroomScopedMixin, generics.ListAPIView):
    """GET /api/classrooms/<code>/files/"""

    serializer_class = FileSerializer
    pagination_class = None

    def get_queryset(self):
        return SharedFile.objects.filter(classroom=self.get_classroom()).select_related("uploader")


class AttendanceListAPIView(_ClassroomScopedMixin, generics.ListAPIView):
    """GET /api/classrooms/<code>/attendance/ — per-session summaries."""

    require_privileged = True
    serializer_class = SessionSerializer
    pagination_class = None

    def list(self, request, *args, **kwargs):
        sessions = ClassroomSession.objects.filter(classroom=self.get_classroom()).exclude(
            status=ClassroomSession.Status.SCHEDULED
        )
        return Response([
            {
                "session": SessionSerializer(s).data,
                "attendance": attendance_summary(s),
            }
            for s in sessions
        ])
