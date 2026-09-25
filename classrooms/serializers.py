"""DRF serializers for the classrooms API."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from rest_framework import serializers

from .models import Classroom, ClassroomMember

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
        )
        read_only_fields = ("id", "user", "role", "joined_at")


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
            raise serializers.ValidationError(
                {"password": "رمز کلاس باید حداقل ۴ نویسه باشد."}
            )
        return attrs
