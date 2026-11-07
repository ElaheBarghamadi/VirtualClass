"""Classroom background jobs.

Run by ``celery -A config worker -l info``; queued through
:func:`core.queue.dispatch`, which also runs them inline when no broker is
configured — so the same code path works in development, in CI and in
production.

Three kinds of work live here, all of which used to block a request or had
no owner at all:

* Office → PDF conversion (``convert_office_file``) — the LibreOffice run
  takes seconds and used to happen inside the upload request;
* stale sessions (``close_stale_sessions``) — a session the host never ended
  keeps its classroom "in class" forever;
* abandoned guest rows (``prune_stale_guests``) — throwaway memberships that
  nothing else cleans up.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.db import close_old_connections
from django.db.models import Q
from django.utils import timezone

logger = logging.getLogger("classrooms.tasks")


@shared_task(name="classrooms.tasks.convert_office_file")
def convert_office_file(file_id: int) -> str:
    """Convert an uploaded Office file to PDF, then announce it in the room.

    Returns a short status string (also handy in worker logs / tests):
    ``converted``, ``already-converted``, ``skipped`` (no LibreOffice or not an
    Office file), ``missing`` or ``failed``.

    Never raises: a job that blows up must not crash the worker, and the file
    simply stays download-only — exactly the behaviour before conversion
    existed.
    """
    from .models import SharedFile
    from .office_convert import convert_to_pdf
    from .services import broadcast

    close_old_connections()
    try:
        shared = (
            SharedFile.objects.select_related("classroom").filter(id=file_id).first()
        )
        if shared is None:
            logger.info("office_convert_missing_file", extra={"file_id": file_id})
            return "missing"
        if shared.pdf_version:
            return "already-converted"
        if not convert_to_pdf(shared):
            return "skipped"
        # The upload broadcast told the room "no presentation yet"; this tells
        # everyone the presentable copy just appeared, without a refresh.
        broadcast(shared.classroom.room_code, {
            "type": "file_presentable",
            "file_id": shared.id,
            "name": shared.original_name,
            "has_pdf": True,
            "url": f"/class/{shared.classroom.room_code}/files/{shared.id}/download/",
        })
        logger.info("office_converted_in_task", extra={"file_id": shared.id})
        return "converted"
    except Exception:  # noqa: BLE001 — background jobs never propagate
        logger.exception("office_convert_task_failed", extra={"file_id": file_id})
        return "failed"
    finally:
        close_old_connections()


@shared_task(name="classrooms.tasks.close_stale_sessions")
def close_stale_sessions(hours: int | None = None) -> int:
    """End sessions that have been "live" for longer than ``hours``.

    A class ends when the host presses the button; if the host closes the
    laptop instead, the session row stays ``LIVE`` and the room keeps showing
    a lesson in progress.  Returns how many sessions were closed.
    """
    from .models import ClassroomSession
    from .services import close_session

    limit = settings.STALE_SESSION_HOURS if hours is None else hours
    if limit <= 0:
        return 0
    cutoff = timezone.now() - timedelta(hours=limit)

    close_old_connections()
    try:
        stale = (
            ClassroomSession.objects.select_related("classroom")
            .filter(status=ClassroomSession.Status.LIVE)
            .filter(
                Q(started_at__lt=cutoff)
                | Q(started_at__isnull=True, scheduled_start__lt=cutoff)
            )
        )
        closed = 0
        for session in stale:
            close_session(session)
            closed += 1
        if closed:
            logger.info("stale_sessions_closed", extra={"count": closed, "hours": limit})
        return closed
    finally:
        close_old_connections()


@shared_task(name="classrooms.tasks.prune_stale_guests")
def prune_stale_guests(days: int | None = None) -> int:
    """Delete guest memberships that left more than ``days`` days ago.

    Only inactive guests are touched: a guest who is still connected, or a
    registered user's membership (roles, permissions, attendance), is never
    removed.  Returns the number of deleted rows.
    """
    from .models import ClassroomMember

    limit = settings.GUEST_RETENTION_DAYS if days is None else days
    if limit <= 0:
        return 0
    cutoff = timezone.now() - timedelta(days=limit)

    close_old_connections()
    try:
        stale = ClassroomMember.objects.filter(
            is_guest=True, is_active=False, joined_at__lt=cutoff
        )
        deleted, _ = stale.delete()
        if deleted:
            logger.info("stale_guests_pruned", extra={"count": deleted, "days": limit})
        return deleted
    finally:
        close_old_connections()
