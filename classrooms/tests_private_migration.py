import io
import json
import tempfile
from pathlib import Path
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.core.management import call_command, CommandError
from django.test import TestCase, override_settings
from django.utils import timezone

from assignments.models import Assignment, Submission
from classrooms.models import ClassroomMember, SharedFile
from classrooms.services import create_classroom, join_classroom


class PrivateMigrationTests(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.public, self.private = root / 'public', root / 'private'
        settings = override_settings(MEDIA_ROOT=self.public, PRIVATE_MEDIA_ROOT=self.private)
        settings.enable(); self.addCleanup(settings.disable)
        owner = get_user_model().objects.create_user(username='migration_owner')
        student = get_user_model().objects.create_user(username='migration_student')
        room = create_classroom(owner, 'Migration')
        member = join_classroom(room, student)
        self.name = 'classrooms/legacy/slide.pdf'
        SharedFile.objects.create(classroom=room, uploader=owner, file=self.name,
                                  original_name='slide.pdf', size=8, content_type='application/pdf')
        assignment = Assignment.objects.create(classroom=room, title='hw', due_at=timezone.now()+timedelta(days=1))
        Submission.objects.create(assignment=assignment, member=member, file='classrooms/legacy/answer.pdf')
        self.source = self.public / self.name
        self.source.parent.mkdir(parents=True)
        self.source.write_bytes(b'old data')
        (self.public / 'classrooms/legacy/answer.pdf').write_bytes(b'answer')

    def command(self, *args):
        out = io.StringIO()
        call_command('migrate_private_files', *args, stdout=out, stderr=io.StringIO())
        return json.loads(out.getvalue())

    def test_dry_run_then_copy_then_repeat(self):
        self.assertEqual(self.command()['would_copy'], 2)
        self.assertFalse(self.private.exists())
        self.assertEqual(self.command('--apply')['copied'], 2)
        self.assertEqual((self.private / self.name).read_bytes(), b'old data')
        self.assertEqual(self.source.read_bytes(), b'old data')
        self.assertEqual(self.command('--apply')['already_verified'], 2)
        self.assertEqual(SharedFile.objects.get().file.name, self.name)

    def test_conflict_never_overwritten(self):
        target = self.private / self.name
        target.parent.mkdir(parents=True)
        target.write_bytes(b'changed')
        with self.assertRaises(CommandError): self.command('--apply')
        self.assertEqual(target.read_bytes(), b'changed')
        self.assertTrue(self.source.exists())

    def test_missing_and_unsafe_path_fail(self):
        self.source.unlink()
        with self.assertRaises(CommandError): self.command()
        SharedFile.objects.update(file='../unsafe')
        with self.assertRaises(CommandError): self.command('--apply')

    def test_symlink_rejected(self):
        self.source.unlink()
        self.source.symlink_to(self.public / 'classrooms/legacy/answer.pdf')
        with self.assertRaises(CommandError): self.command('--apply')
        self.assertFalse((self.private / self.name).exists())
