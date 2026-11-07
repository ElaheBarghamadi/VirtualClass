"""Tests for the ``prune_history`` retention command."""
from datetime import timedelta
from io import StringIO

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase
from django.utils import timezone

from chat.models import ChatMessage
from classrooms.services import create_classroom
from whiteboard.models import Whiteboard, WhiteboardEvent, WhiteboardSnapshot

User = get_user_model()


def _draw(index):
    return {
        "type": "draw", "tool": "pen", "norm": 1, "id": f"p-{index}", "page": 1,
        "color": "#2563eb", "width": 3, "points": [[0.1, 0.2], [0.3, 0.4]],
    }


class PruneHistoryCommandTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="prune_owner", password="x")
        self.classroom = create_classroom(self.owner, title="Prune")
        self.board = Whiteboard.objects.create(classroom=self.classroom)
        WhiteboardEvent.objects.bulk_create([
            WhiteboardEvent(
                whiteboard=self.board, actor=self.owner, actor_identity="u:1",
                page=1, operation=_draw(i),
            )
            for i in range(5)
        ])

    def _age_board(self, days):
        Whiteboard.objects.filter(id=self.board.id).update(
            updated_at=timezone.now() - timedelta(days=days)
        )

    def test_idle_board_is_folded_not_emptied(self):
        self._age_board(120)
        out = StringIO()
        call_command("prune_history", "--board-days", "90", stdout=out)

        self.assertEqual(WhiteboardEvent.objects.filter(whiteboard=self.board).count(), 0)
        snapshot = WhiteboardSnapshot.objects.get(whiteboard=self.board)
        self.assertEqual([op["id"] for op in snapshot.state["ops"]],
                         [f"p-{i}" for i in range(5)])
        self.assertIn("boards folded: 1", out.getvalue())

    def test_recent_board_is_untouched(self):
        call_command("prune_history", "--board-days", "90", stdout=StringIO())
        self.assertEqual(WhiteboardEvent.objects.filter(whiteboard=self.board).count(), 5)
        self.assertFalse(WhiteboardSnapshot.objects.exists())

    def test_dry_run_writes_nothing(self):
        self._age_board(120)
        out = StringIO()
        call_command("prune_history", "--board-days", "90", "--dry-run", stdout=out)
        self.assertEqual(WhiteboardEvent.objects.filter(whiteboard=self.board).count(), 5)
        self.assertFalse(WhiteboardSnapshot.objects.exists())
        self.assertIn("would be folded", out.getvalue())

    def test_boards_can_be_skipped(self):
        self._age_board(120)
        call_command("prune_history", "--board-days", "0", stdout=StringIO())
        self.assertEqual(WhiteboardEvent.objects.filter(whiteboard=self.board).count(), 5)

    def test_chat_retention_only_drops_old_messages(self):
        old = ChatMessage.objects.create(
            classroom=self.classroom, sender=self.owner, sender_name="o", message="old"
        )
        new = ChatMessage.objects.create(
            classroom=self.classroom, sender=self.owner, sender_name="o", message="new"
        )
        ChatMessage.objects.filter(id=old.id).update(created_at=timezone.now() - timedelta(days=200))

        call_command("prune_history", "--board-days", "0", "--chat-days", "180", stdout=StringIO())

        self.assertFalse(ChatMessage.objects.filter(id=old.id).exists())
        self.assertTrue(ChatMessage.objects.filter(id=new.id).exists())

    def test_chat_is_kept_by_default(self):
        ChatMessage.objects.create(
            classroom=self.classroom, sender=self.owner, sender_name="o", message="old"
        )
        ChatMessage.objects.update(created_at=timezone.now() - timedelta(days=4000))
        call_command("prune_history", "--board-days", "0", stdout=StringIO())
        self.assertEqual(ChatMessage.objects.count(), 1)


class PruneHistoryTaskTests(TestCase):
    """The Celery beat job runs the same command — no second implementation."""

    def setUp(self):
        self.owner = User.objects.create_user(username="task_owner", password="x")
        self.classroom = create_classroom(self.owner, title="Task")

    def _message(self, days_ago: int) -> ChatMessage:
        message = ChatMessage.objects.create(
            classroom=self.classroom, sender=self.owner, sender_name="o", message="m",
        )
        ChatMessage.objects.filter(id=message.id).update(
            created_at=timezone.now() - timedelta(days=days_ago)
        )
        return message

    def test_task_deletes_only_messages_past_the_window(self):
        from core.tasks import prune_history

        old = self._message(400)
        recent = self._message(10)

        report = prune_history(board_days=0, chat_days=180)

        self.assertFalse(ChatMessage.objects.filter(id=old.id).exists())
        self.assertTrue(ChatMessage.objects.filter(id=recent.id).exists())
        self.assertIn("chat messages deleted: 1", report)

    def test_task_reads_its_windows_from_settings(self):
        from django.test import override_settings

        from core.tasks import prune_history

        old = self._message(400)
        with override_settings(PRUNE_BOARD_DAYS=0, PRUNE_CHAT_DAYS=180):
            prune_history()
        self.assertFalse(ChatMessage.objects.filter(id=old.id).exists())

    def test_disabled_windows_do_nothing(self):
        from core.tasks import prune_history

        old = self._message(400)
        report = prune_history(board_days=0, chat_days=0)
        self.assertTrue(ChatMessage.objects.filter(id=old.id).exists())
        self.assertIn("nothing to do", report)


class HousekeepingCommandTests(TestCase):
    """`manage.py housekeeping` = the three periodic jobs, for cron/platforms
    that have no Celery beat."""

    def setUp(self):
        self.owner = User.objects.create_user(username="hk_owner", password="x")
        self.classroom = create_classroom(self.owner, title="Housekeeping")

    def test_it_runs_every_job(self):
        from classrooms.models import ClassroomMember, ClassroomSession
        from classrooms.services import join_classroom_guest

        session = ClassroomSession.objects.create(
            classroom=self.classroom, host=self.owner,
            status=ClassroomSession.Status.LIVE,
            started_at=timezone.now() - timedelta(hours=20),
        )
        guest = join_classroom_guest(self.classroom, "مهمان قدیمی")
        ClassroomMember.objects.filter(pk=guest.pk).update(
            is_active=False, joined_at=timezone.now() - timedelta(days=30),
        )
        old_message = ChatMessage.objects.create(
            classroom=self.classroom, sender=self.owner, sender_name="o", message="m",
        )
        ChatMessage.objects.filter(id=old_message.id).update(
            created_at=timezone.now() - timedelta(days=400)
        )
        out = StringIO()
        call_command("housekeeping", "--chat-days", "180", stdout=out)
        text = out.getvalue()

        session.refresh_from_db()
        self.assertEqual(session.status, ClassroomSession.Status.ENDED)
        self.assertFalse(ClassroomMember.objects.filter(pk=guest.pk).exists())
        self.assertFalse(ChatMessage.objects.filter(id=old_message.id).exists())
        self.assertIn("sessions closed: 1", text)
        self.assertIn("guest memberships deleted: 1", text)
        self.assertIn("housekeeping done", text)

    def test_disabled_windows_change_nothing(self):
        from classrooms.models import ClassroomSession

        session = ClassroomSession.objects.create(
            classroom=self.classroom, host=self.owner,
            status=ClassroomSession.Status.LIVE,
            started_at=timezone.now() - timedelta(hours=99),
        )
        out = StringIO()
        call_command(
            "housekeeping", "--stale-hours", "0", "--guest-days", "0",
            "--board-days", "0", "--chat-days", "0", stdout=out,
        )
        session.refresh_from_db()
        self.assertEqual(session.status, ClassroomSession.Status.LIVE)
        self.assertIn("nothing to do", out.getvalue())
