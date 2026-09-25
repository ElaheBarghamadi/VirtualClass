"""REST API views.

The Django Templates frontend remains primary in this phase; this API
exists as a stable, versioned seam for future clients (mobile, etc.).
"""
from __future__ import annotations

from django.shortcuts import get_object_or_404
from rest_framework import generics, permissions, status
from rest_framework.authtoken.models import Token
from rest_framework.authtoken.views import ObtainAuthToken
from rest_framework.response import Response

from .models import Classroom
from .serializers import (
    ClassroomCreateSerializer,
    ClassroomSerializer,
    MemberSerializer,
    RegisterSerializer,
)
from .services import create_classroom


class RegisterAPIView(generics.CreateAPIView):
    """POST /api/auth/register/"""

    serializer_class = RegisterSerializer
    permission_classes = [permissions.AllowAny]


class LoginAPIView(ObtainAuthToken):
    """POST /api/auth/login/ → returns an auth token."""

    permission_classes = [permissions.AllowAny]


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


class ClassroomParticipantsAPIView(generics.ListAPIView):
    """GET /api/classrooms/<room_code>/participants/ — active members."""

    serializer_class = MemberSerializer

    def get_queryset(self):
        classroom = get_object_or_404(Classroom, room_code=self.kwargs["room_code"])
        user = self.request.user
        is_allowed = classroom.owner_id == user.id or classroom.members.filter(
            user=user, is_active=True
        ).exists()
        if not is_allowed:
            return classroom.members.none()
        return (
            classroom.members.filter(is_active=True)
            .select_related("user")
            .order_by("role", "joined_at")
        )
