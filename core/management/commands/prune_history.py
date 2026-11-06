"""Operational data retention.

Two tables grow without limit while a class is in use:

* ``whiteboard.WhiteboardEvent`` — one row per stroke, forever;
* ``chat.ChatMessage`` — every message ever sent.

Neither used to have any housekeeping, so a school running the same classrooms
for a year ends up with a database whose size has nothing to do with how much
content is actually shown.  This command is the housekeeping:

* old boards are *folded*, not deleted: their operations are compacted into the
  snapshot (the picture stays exactly as it was) and the event rows are removed;
* old chat messages can be dropped after a configurable age.

Both are off-by-default for recent data and support ``--dry-run``, so it can be
put on a cron/`systemd timer` without surprises::

    python manage.py prune_history --dry-run
    python manage.py prune_history --board-days 90 --chat-days 180
"""
from __future__ import annotations

from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db.models import Count
from django.utils import timezone

from chat.models import ChatMessage
from whiteboard.models import Whiteboard, WhiteboardEvent
from whiteboard.snapshot import compact_board


class Command(BaseCommand):
    help = "Fold idle whiteboards into snapshots and optionally drop old chat messages."

    def add_arguments(self, parser):
        parser.add_argument(
            "--board-days", type=int, default=90,
            help="Fold boards not touched for this many days (0 disables). Default: 90.",
        )
        parser.add_argument(
            "--chat-days", type=int, default=0,
            help="Delete chat messages older than this many days (0 keeps everything). Default: 0.",
        )
        parser.add_argument(
            "--dry-run", action="store_true",
            help="Report what would change without writing anything.",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        board_days = options["board_days"]
        chat_days = options["chat_days"]

        folded_events = 0
        folded_boards = 0
        if board_days > 0:
            cutoff = timezone.now() - timedelta(days=board_days)
            boards = (
                Whiteboard.objects.filter(updated_at__lt=cutoff)
                .annotate(event_count=Count("events"))
                .filter(event_count__gt=0)
            )
            for board in boards.iterator():
                if dry_run:
                    self.stdout.write(
                        f"[dry-run] board {board.id} ({board.classroom.room_code}): "
                        f"{board.event_count} events would be folded"
                    )
                    folded_events += board.event_count
                    folded_boards += 1
                    continue
                _snapshot, count = compact_board(board.id, force=True)
                if count:
                    folded_boards += 1
                    folded_events += count
            self.stdout.write(
                f"boards folded: {folded_boards}, events removed: {folded_events}"
                + (" (dry-run)" if dry_run else "")
            )
        else:
            self.stdout.write("boards: skipped (--board-days 0)")

        if chat_days > 0:
            chat_cutoff = timezone.now() - timedelta(days=chat_days)
            stale = ChatMessage.objects.filter(created_at__lt=chat_cutoff)
            count = stale.count()
            if dry_run:
                self.stdout.write(f"[dry-run] chat messages to delete: {count}")
            else:
                deleted, _ = stale.delete()
                self.stdout.write(f"chat messages deleted: {deleted}")
        else:
            self.stdout.write("chat: skipped (--chat-days 0)")

        if not dry_run and WhiteboardEvent.objects.count() == 0:
            self.stdout.write(self.style.SUCCESS("no board events left to prune"))
