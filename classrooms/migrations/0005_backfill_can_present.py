"""Backfill can_present for members created before the field existed.

``can_present`` was added in 0002 with ``default=False``; every membership
row that already existed at that point (including OWNERs of old
classrooms) received False, so their file rows could never present.
Role defaults say OWNER/MODERATOR/PRESENTER present — align stored flags.
"""
from django.db import migrations

PRESENT_ROLES = ("OWNER", "MODERATOR", "PRESENTER")


def backfill_can_present(apps, schema_editor):
    ClassroomMember = apps.get_model("classrooms", "ClassroomMember")
    ClassroomMember.objects.filter(role__in=PRESENT_ROLES).update(can_present=True)


class Migration(migrations.Migration):

    dependencies = [
        ("classrooms", "0004_classroom_whiteboard_open"),
    ]

    operations = [
        migrations.RunPython(backfill_can_present, migrations.RunPython.noop),
    ]
