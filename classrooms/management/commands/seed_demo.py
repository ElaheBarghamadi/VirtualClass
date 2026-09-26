"""Seed a demo classroom for local testing / CI.

Usage:  python manage.py seed_demo
Creates owner1/stu1 (password ``Pass-12345``) and one classroom, resets
the room to a pristine state (members, files, chat, whiteboard, sessions),
then prints the room code.  Safe to re-run — every call leaves the room
in the same starting condition, which makes it ideal before an E2E run.
"""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from chat.models import ChatMessage
from classrooms.models import (
    AttendanceRecord,
    Classroom,
    ClassroomMember,
    ClassroomSession,
    SharedFile,
)
from classrooms.permissions import Role
from classrooms.services import create_classroom
from whiteboard.models import Whiteboard


class Command(BaseCommand):
    help = "Create demo users (owner1/stu1) and a pristine demo classroom."

    def handle(self, *args, **options):
        User = get_user_model()
        owner, _ = User.objects.get_or_create(
            username="owner1",
            defaults={"first_name": "علی", "last_name": "معلمی"},
        )
        owner.set_password("Pass-12345")
        owner.save()
        student, _ = User.objects.get_or_create(
            username="stu1",
            defaults={"first_name": "سارا", "last_name": "دانش‌آموز"},
        )
        student.set_password("Pass-12345")
        student.save()

        classroom = Classroom.objects.filter(owner=owner).first()
        if classroom is None:
            classroom = create_classroom(owner, title="کلاس نمونه")
        self._reset(classroom)
        self.stdout.write(self.style.SUCCESS(
            f"seeded — room code: {classroom.room_code} "
            f"(owner1 / stu1, password: Pass-12345)"
        ))

    @staticmethod
    def _reset(classroom: Classroom) -> None:
        """Return the room to the exact state a brand-new room has."""
        # files (also removes them from storage)
        for sf in SharedFile.objects.filter(classroom=classroom):
            if sf.file:
                sf.file.delete(save=False)
            if sf.pdf_version:
                sf.pdf_version.delete(save=False)
            sf.delete()
        ChatMessage.objects.filter(classroom=classroom).delete()
        for wb in Whiteboard.objects.filter(classroom=classroom):
            wb.events.all().delete()
            wb.delete()
        AttendanceRecord.objects.filter(session__classroom=classroom).delete()
        ClassroomSession.objects.filter(classroom=classroom).delete()
        # members back to defaults (owner membership recreated below)
        ClassroomMember.objects.filter(classroom=classroom).exclude(
            user=classroom.owner).delete()
        ClassroomMember.objects.filter(
            classroom=classroom, user=classroom.owner,
        ).update(muted=False, camera_disabled=False, in_waiting_room=False,
                 hand_raised_at=None, banned_until=None)
        ClassroomMember.objects.get_or_create(
            classroom=classroom, user=classroom.owner,
            defaults={"role": Role.OWNER},
        )
        # room-wide flags
        Classroom.objects.filter(pk=classroom.pk).update(
            current_file=None, current_page=1,
            is_locked=False, enable_waiting_room=False, chat_disabled=False,
            is_active=True, whiteboard_open=False,
        )
