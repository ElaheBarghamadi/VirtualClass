"""Handing work to the queue — the one place that decides *when* it runs.

Background jobs are Celery tasks, but a task is not always queued: with no
broker configured (``REDIS_URL`` unset) Celery runs it inline, and a broker
that is configured but down must not break — or slow down — the request that
triggered the job.  ``dispatch()`` hides all of that:

    from .tasks import convert_office_file
    dispatch(convert_office_file, shared.id)

* broker configured  → the worker picks it up (returns ``True``);
* no broker / eager  → runs right here, in-process (returns ``False``);
* broker unreachable → logs a warning and runs right here (returns ``False``),
  and remembers it for ``BROKER_COOLDOWN`` seconds so the next requests do not
  pay the connection timeout again.

The job therefore always happens; only its timing changes.
"""
from __future__ import annotations

import logging
import time

logger = logging.getLogger("core.queue")

#: Seconds to stop trying the broker after one failed publish.  Long enough to
#: spare every following request a doomed connection attempt, short enough that
#: a Redis restart is picked up without a deploy.
BROKER_COOLDOWN = 30.0

#: monotonic timestamp until which the broker is treated as unavailable.
_broker_down_until: float = 0.0


def _runs_inline(task) -> bool:
    """True when this task's app executes jobs immediately instead of queuing."""
    try:
        return bool(task.app.conf.task_always_eager)
    except Exception:  # pragma: no cover - defensive, config always readable
        return True


def _run_inline(task, args, kwargs) -> None:
    task.apply(args=args, kwargs=kwargs)


def broker_is_cooling_down() -> bool:
    """True while a recently-failed broker is being skipped."""
    return time.monotonic() < _broker_down_until


def reset_broker_health() -> None:
    """Forget a previous failure (tests, and ops after fixing Redis)."""
    global _broker_down_until
    _broker_down_until = 0.0


def dispatch(task, *args, **kwargs) -> bool:
    """Enqueue ``task``; fall back to running it inline if the queue is down."""
    global _broker_down_until

    if _runs_inline(task) or broker_is_cooling_down():
        _run_inline(task, args, kwargs)
        return False
    try:
        task.apply_async(args=args, kwargs=kwargs, retry=False)
        return True
    except Exception:  # Broker unreachable (Redis restart, bad URL, ...)
        _broker_down_until = time.monotonic() + BROKER_COOLDOWN
        logger.warning(
            "queue_unavailable_running_inline: broker unreachable, running jobs "
            "in-process for the next %.0fs", BROKER_COOLDOWN, exc_info=True,
        )
        _run_inline(task, args, kwargs)
        return False
