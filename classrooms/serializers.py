"""DRF serializers for the classrooms API."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers

from .models import Classroom, ClassroomMember, ClassroomSession, SharedFile

User = get_user_model()


class UserSerializer(serializers.ModelSerializer):
    name = serializers.CharField(read_only=True)

    class Meta:
        model = User
        fields = ("id", "username", "name", "email")
        read_only_fields = ("id", "username", "name")


class RegisterSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, style={"input_type": "password"})

    class Meta:
        model = User
        fields = ("id", "username", "email", "password")

    def validate_password(self, value: str) -> str:
        validate_password(value)
        return value

    def create(self, validated_data: dict) -> User:
        return User.objects.create_user(**validated_data)


class MemberSerializer(serializers.ModelSerializer):
    """Participant data — stored flags + live moderation state."""

    user = UserSerializer(read_only=True)
    role_label = serializers.CharField(source="get_role_display", read_only=True)

    class Meta:
        model = ClassroomMember
        fields = (
            "id",
            "user",
            "role",
            "role_label",
            "joined_at",
            "is_active",
            "can_use_microphone",
            "can_use_camera",
            "can_share_screen",
            "can_use_whiteboard",
            "can_send_messages",
            "can_upload_files",
            "can_raise_hand",
            "can_present",
            "muted",
            "camera_disabled",
            "in_waiting_room",
            "hand_raised_at",
        )
        read_only_fields = ("id", "user", "role", "joined_at")


class MemberUpdateSerializer(serializers.Serializer):
    """PATCH payload for a participant: role and/or capability flags."""

    role = serializers.ChoiceField(choices=["MODERATOR", "PRESENTER", "STUDENT"], required=False)
    permissions = serializers.DictField(child=serializers.BooleanField(), required=False)


class ClassroomSerializer(serializers.ModelSerializer):
    owner = UserSerializer(read_only=True)
    participant_count = serializers.SerializerMethodField()
    join_url = serializers.SerializerMethodField()

    class Meta:
        model = Classroom
        fields = (
            "id",
            "owner",
            "title",
            "description",
            "room_code",
            "is_password_protected",
            "is_active",
            "is_locked",
            "enable_waiting_room",
            "created_at",
            "updated_at",
            "participant_count",
            "join_url",
        )
        read_only_fields = fields  # creation handled explicitly in the view

    def get_participant_count(self, obj: Classroom) -> int:
        return obj.members.filter(is_active=True).count()

    def get_join_url(self, obj: Classroom) -> str:
        return f"/class/{obj.room_code}/"


class ClassroomCreateSerializer(serializers.Serializer):
    """Explicit creation payload — password is write-only, never returned."""

    title = serializers.CharField(max_length=200)
    description = serializers.CharField(required=False, allow_blank=True, default="")
    is_password_protected = serializers.BooleanField(default=False)
    password = serializers.CharField(required=False, allow_blank=True, default="")

    def validate(self, attrs: dict) -> dict:
        if attrs["is_password_protected"] and len(attrs.get("password") or "") < 4:
            raise serializers.ValidationError({"password": "رمز کلاس باید حداقل ۴ نویسه باشد."})
        return attrs


class SessionSerializer(serializers.ModelSerializer):
    host_name = serializers.CharField(source="host.name", read_only=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    duration_seconds = serializers.IntegerField(read_only=True)

    class Meta:
        model = ClassroomSession
        fields = (
            "id",
            "title",
            "status",
            "status_label",
            "host_name",
            "scheduled_start",
            "scheduled_end",
            "started_at",
            "ended_at",
            "duration_seconds",
        )
        read_only_fields = ("id", "status", "started_at", "ended_at")


class SessionCreateSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=200, required=False, allow_blank=True, default="")
    scheduled_start = serializers.DateTimeField(required=False, allow_null=True)
    scheduled_end = serializers.DateTimeField(required=False, allow_null=True)

    def validate(self, attrs: dict) -> dict:
        start, end = attrs.get("scheduled_start"), attrs.get("scheduled_end")
        if start and end and end <= start:
            raise serializers.ValidationError({"scheduled_end": "پایان باید بعد از شروع باشد."})
        return attrs


class FileSerializer(serializers.ModelSerializer):
    uploader_name = serializers.CharField(source="uploader.name", read_only=True)
    size_display = serializers.CharField(read_only=True)
    download_url = serializers.SerializerMethodField()

    class Meta:
        model = SharedFile
        fields = ("id", "original_name", "size", "size_display", "content_type", "uploader_name", "uploaded_at", "download_url")

    def get_download_url(self, obj: SharedFile) -> str:
        return f"/class/{obj.classroom.room_code}/files/{obj.id}/download/"


class ChatMessageSerializer(serializers.Serializer):
    """Read-only chat history (writes go through the WebSocket)."""

    id = serializers.IntegerField()
    sender_id = serializers.IntegerField()
    sender_name = serializers.CharField()
    message = serializers.CharField()
    is_deleted = serializers.BooleanField()
    created_at = serializers.DateTimeField()
