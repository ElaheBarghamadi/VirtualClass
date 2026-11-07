"""Periodic housekeeping.

The heavy lifting already lives in ``manage.py prune_history`` (folding idle
whiteboards into snapshots, dropping old chat).  Rather than reimplement it,
the Celery task calls the same command — one implementation, runnable by hand,
by cron, or (default) by ``celery -A config beat``.
"""
from __future__ import annotations

import logging

from celery import shared_task
from django.conf import settings
from django.core.management import call_command
from django.db import close_old_connections

logger = logging.getLogger("core.tasks")


@shared_task(name="core.tasks.prune_history")
def prune_history(board_days: int | None = None, chat_days: int | None = None) -> str:
    """Run ``manage.py prune_history`` with the configured retention windows.

    Returns the command's output so the worker log shows what happened (the
    command prints counts only — no message content).
    """
    from io import StringIO

    board_days = settings.PRUNE_BOARD_DAYS if board_days is None else board_days
    chat_days = settings.PRUNE_CHAT_DAYS if chat_days is None else chat_days
    if board_days <= 0 and chat_days <= 0:
        return "nothing to do (retention disabled)"

    out = StringIO()
    close_old_connections()
    try:
        call_command(
            "prune_history",
            board_days=board_days,
            chat_days=chat_days,
            stdout=out,
        )
        report = out.getvalue().strip()
        logger.info("history_pruned", extra={"report": report})
        return report
    finally:
        close_old_connections()
