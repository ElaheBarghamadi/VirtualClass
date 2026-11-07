"""One command for all periodic housekeeping.

`celery -A config beat` runs these jobs on a server that has a scheduler.  A
container platform (or a plain cron entry) does not always allow a second
long-lived process, so the same jobs are reachable as a single command:

    python manage.py housekeeping

It calls the very same task functions the scheduler uses — there is no second
implementation to drift.  Windows are the configured defaults
(``STALE_SESSION_HOURS``, ``GUEST_RETENTION_DAYS``, ``PRUNE_BOARD_DAYS``,
``PRUNE_CHAT_DAYS``) and can be overridden per run.
"""
from __future__ import annotations

from django.conf import settings
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "End stale sessions, drop old guest rows and prune history."

    def add_arguments(self, parser):
        parser.add_argument(
            "--stale-hours", type=int, default=None,
            help="Close sessions LIVE for longer than this (0 disables). "
                 f"Default: {settings.STALE_SESSION_HOURS}.",
        )
        parser.add_argument(
            "--guest-days", type=int, default=None,
            help="Delete guest memberships that left this many days ago "
                 f"(0 disables). Default: {settings.GUEST_RETENTION_DAYS}.",
        )
        parser.add_argument(
            "--board-days", type=int, default=None,
            help="Fold whiteboards untouched for this many days "
                 f"(0 disables). Default: {settings.PRUNE_BOARD_DAYS}.",
        )
        parser.add_argument(
            "--chat-days", type=int, default=None,
            help="Delete chat messages older than this many days "
                 f"(0 keeps everything). Default: {settings.PRUNE_CHAT_DAYS}.",
        )

    def handle(self, *args, **options):
        from classrooms.tasks import close_stale_sessions, prune_stale_guests
        from core.tasks import prune_history

        sessions = close_stale_sessions(hours=options["stale_hours"])
        self.stdout.write(f"sessions closed: {sessions}")

        guests = prune_stale_guests(days=options["guest_days"])
        self.stdout.write(f"guest memberships deleted: {guests}")

        report = prune_history(
            board_days=options["board_days"],
            chat_days=options["chat_days"],
        )
        self.stdout.write(report or "history: nothing to do")
        self.stdout.write(self.style.SUCCESS("housekeeping done"))
