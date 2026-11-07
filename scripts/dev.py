#!/usr/bin/env python
"""Start the whole development stack with one command.

    python scripts/dev.py              # web server (+ worker when Redis is up)
    python scripts/dev.py --beat       # ... plus the periodic-job scheduler
    python scripts/dev.py --port 8000  # pick another port
    python scripts/dev.py --no-redis   # never start redis-server yourself
    python scripts/dev.py --web-only   # just `runserver`

What runs, and why:

* **web** — ``manage.py runserver`` (Daphne: HTTP + WebSockets);
* **worker** — ``celery -A config worker``: only started when a broker is
  configured (``REDIS_URL``).  Without one, Celery runs every job inline in the
  web process, so there is nothing to start;
* **beat** — ``celery -A config beat``: the scheduler for the maintenance jobs;
  opt-in, since it is only interesting once jobs are really queued;
* **redis** — started automatically when ``REDIS_URL`` points at
  ``127.0.0.1``/``localhost`` and nothing is listening there yet.  Skipped (with
  a note) when ``redis-server`` is not installed: the app falls back to its
  in-process layer, it just cannot serve several processes at once.

Every log line is prefixed with the process it came from.  Ctrl-C stops all of
them.  This is a development convenience only — production runs the same three
commands under systemd (see ``deploy/systemd/``).
"""
from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable


def _env_value(name: str, default: str = "") -> str:
    """Read from the environment, then .env (same order as Django)."""
    if os.environ.get(name):
        return os.environ[name]
    env_file = ROOT / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            if key.strip() == name:
                return value.strip().strip('"').strip("'")
    return default


def _port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((host, port)) == 0


def _redis_commands(redis_url: str) -> list[list[str]]:
    """Commands needed to have a local Redis at ``redis_url`` (possibly none)."""
    if not redis_url:
        return []
    parsed = urlparse(redis_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 6379
    if host not in {"127.0.0.1", "localhost"}:
        return []  # remote Redis: not our business
    if _port_open(host, port):
        return []
    binary = shutil.which("redis-server")
    if not binary:
        print("! Redis is not reachable and redis-server is not installed — "
              "continuing in single-process mode.\n"
              "  Install it (apt install redis-server / brew install redis) to "
              "run a worker.\n", flush=True)
        return []
    return [[binary, "--port", str(port), "--save", "", "--appendonly", "no"]]


def _spawn(label: str, command: list[str]) -> subprocess.Popen:
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,  # kill the whole tree (runserver reloads!) later
    )

    def pump() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            print(f"[{label}] {line.rstrip()}", flush=True)

    threading.Thread(target=pump, daemon=True).start()
    return process


def _stop_all(processes: list[tuple[str, subprocess.Popen]]) -> None:
    for label, process in processes:
        if process.poll() is not None:
            continue
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except (OSError, AttributeError):  # Windows / already gone
            process.terminate()
        print(f"[{label}] stopping…", flush=True)
    for _label, process in processes:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except (OSError, AttributeError):
                process.kill()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the VirtualClass dev stack.")
    parser.add_argument("--port", default=_env_value("DEV_PORT", "8000"))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--beat", action="store_true", help="also run celery beat")
    parser.add_argument("--web-only", action="store_true", help="only runserver")
    parser.add_argument("--no-redis", action="store_true",
                        help="never start redis-server automatically")
    parser.add_argument("--no-migrate", action="store_true", help="skip migrate")
    args = parser.parse_args()

    if not args.no_migrate:
        print("› applying migrations…", flush=True)
        subprocess.run([PY, "manage.py", "migrate", "--noinput"], cwd=ROOT, check=True)

    redis_url = _env_value("REDIS_URL")
    queued = bool(redis_url) and _env_value(
        "CELERY_TASK_ALWAYS_EAGER", "false"
    ).lower() not in {"1", "true", "yes", "on"}

    planned: list[tuple[str, list[str]]] = []
    if not args.no_redis:
        planned += [("redis", command) for command in _redis_commands(redis_url)]
        if planned and not _port_open(
            urlparse(redis_url).hostname or "127.0.0.1", urlparse(redis_url).port or 6379
        ):
            time.sleep(0.6)  # give a warm Redis a moment before the worker dials in

    planned.append(("web", [PY, "manage.py", "runserver",
                            f"{args.host}:{args.port}"]))
    if queued and not args.web_only:
        pool = ["--pool", "solo"] if os.name == "nt" else []
        planned.append(("worker", [PY, "-m", "celery", "-A", "config", "worker",
                                   "-l", "info", *pool]))
        if args.beat:
            planned.append(("beat", [PY, "-m", "celery", "-A", "config", "beat",
                                     "-l", "info"]))

    shown_host = "localhost" if args.host in {"0.0.0.0", "::"} else args.host
    print("\n  VirtualClass")
    print(f"  ├─ http://{shown_host}:{args.port}/   (LAN: http://<your-ip>:{args.port}/)")
    print(f"  ├─ jobs: {'queued to Redis — worker running' if queued else 'inline (no Redis)'}")
    print(f"  └─ scheduler: {'on' if args.beat and queued else 'off'}")
    print("\n  Ctrl-C to stop everything.\n", flush=True)

    processes: list[tuple[str, subprocess.Popen]] = []
    try:
        for label, command in planned:
            processes.append((label, _spawn(label, command)))
        # Exit as soon as any child dies (usually the web server on a crash).
        while True:
            for label, process in processes:
                if process.poll() is not None:
                    print(f"[{label}] exited with code {process.returncode}", flush=True)
                    return process.returncode or 0
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n  shutting down…", flush=True)
        return 0
    finally:
        _stop_all(processes)


if __name__ == "__main__":
    raise SystemExit(main())
