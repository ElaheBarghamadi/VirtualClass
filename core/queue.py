"""Handing work to the queue — the one place that decides *when* it runs.

Background jobs are Celery tasks, but a task is not always queued: with no
broker configured (``REDIS_URL`` unset) Celery runs it inline, and a broker
that is configured but down must not break the request that triggered the
job.  ``dispatch()`` hides both cases:

    from .tasks import convert_office_file
    dispatch(convert_office_file, shared.id)

* broker configured  → the worker picks it up (returns ``True``);
* no broker / eager  → runs right here, in-process (returns ``False``);
* broker unreachable → logs a warning and runs right here (returns ``False``).

The job therefore always happens; only its timing changes.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("core.queue")


def _runs_inline(task) -> bool:
    """True when this task's app executes jobs immediately instead of queuing."""
    try:
        return bool(task.app.conf.task_always_eager)
    except Exception:  # pragma: no cover - defensive, config always readable
        return True


def dispatch(task, *args, **kwargs) -> bool:
    """Enqueue ``task``; fall back to running it inline if the queue is down."""
    if _runs_inline(task):
        task.apply(args=args, kwargs=kwargs)
        return False
    try:
        task.apply_async(args=args, kwargs=kwargs, retry=False)
        return True
    except Exception:  # Broker unreachable (Redis restart, bad URL, ...)
        logger.warning("queue_unavailable_running_inline", exc_info=True)
        task.apply(args=args, kwargs=kwargs)
        return False
