#!/usr/bin/env bash
#
# scripts/dev.sh — bring the classroom up locally, in one command.
#
#   ./scripts/dev.sh              # set everything up and start the server
#   ./scripts/dev.sh --demo       # …and seed a demo class (owner1 / stu1)
#   ./scripts/dev.sh --setup-only # install + migrate, do not start a server
#   ./scripts/dev.sh --port=9000  # a different port
#
# It is safe to re-run: the virtualenv, .env, migrations and (with --demo) the
# demo class all converge to the same state.  Nothing here is needed for
# production — see README §"راه‌اندازی".
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

SETUP_ONLY=0
SEED=0
PORT="${PORT:-8000}"

for arg in "$@"; do
    case "$arg" in
        --setup-only) SETUP_ONLY=1 ;;
        --demo) SEED=1 ;;
        --port=*) PORT="${arg#*=}" ;;
        -h|--help)
            sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
    esac
done

info()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- python
PYTHON=""
for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        version="$("$candidate" -c 'import sys; print("%d%02d" % sys.version_info[:2])' 2>/dev/null || echo 0)"
        if [ "$version" -ge 311 ]; then PYTHON="$candidate"; break; fi
    fi
done
[ -n "$PYTHON" ] || die "Python 3.11+ not found. Install it, then run this again."

# ---------------------------------------------------------------- venv
if [ ! -x ".venv/bin/python" ]; then
    info "creating the virtualenv (.venv)"
    "$PYTHON" -m venv .venv
fi
VENV_PY=".venv/bin/python"

if ! "$VENV_PY" -c 'import django' >/dev/null 2>&1; then
    info "installing requirements (one time, ~30 s)"
    "$VENV_PY" -m pip install --quiet --upgrade pip
    "$VENV_PY" -m pip install --quiet -r requirements.txt
fi

# ---------------------------------------------------------------- .env
if [ ! -f .env ]; then
    info "creating .env from .env.example (with a fresh SECRET_KEY)"
    cp .env.example .env
    secret="$("$VENV_PY" -c 'from django.core.management.utils import get_random_secret_key as k; print(k())')"
    # portable in-place edit: rewrite the line through a temp file
    tmp="$(mktemp)"
    while IFS= read -r line; do
        case "$line" in
            SECRET_KEY=*) printf 'SECRET_KEY=%s\n' "$secret" ;;
            *) printf '%s\n' "$line" ;;
        esac
    done < .env > "$tmp"
    mv "$tmp" .env
fi

# ---------------------------------------------------------------- database
info "applying migrations"
"$VENV_PY" manage.py migrate --noinput >/dev/null

if [ "$SEED" = "1" ]; then
    info "seeding the demo classroom"
    "$VENV_PY" manage.py seed_demo
fi

# ---------------------------------------------------------------- hints
if ! grep -qE '^REDIS_URL=.+' .env 2>/dev/null; then
    warn "REDIS_URL is empty → the in-memory channel layer is used."
    warn "That is fine for a single-process local test; for a real class with"
    warn "several people (or more than one worker) start Redis and set"
    warn "REDIS_URL=redis://127.0.0.1:6379/0 in .env.  'manage.py check' warns"
    warn "about this too (whiteboard.W001)."
fi

if [ "$SETUP_ONLY" = "1" ]; then
    info "setup complete. Start the server with: $VENV_PY manage.py runserver"
    exit 0
fi

# ---------------------------------------------------------------- LAN address
# Handy for testing with a phone or a second laptop on the same Wi-Fi.  The
# browser only grants camera/microphone access on https:// or localhost, so a
# phone on http://<ip> will not get media — see README §"تست با چند نفر".
LAN_IP=""
if command -v ip >/dev/null 2>&1; then
    LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
fi
if [ -z "$LAN_IP" ] && command -v hostname >/dev/null 2>&1; then
    LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

# ``load_dotenv`` does not override variables that are already exported, so
# these win over .env for this run only.
export ALLOWED_HOSTS="localhost,127.0.0.1,[::1]${LAN_IP:+,$LAN_IP}"
export CSRF_TRUSTED_ORIGINS="http://localhost:$PORT,http://127.0.0.1:$PORT${LAN_IP:+,http://$LAN_IP:$PORT}"

printf '\n'
info "classroom is starting on http://localhost:$PORT"
[ -n "$LAN_IP" ] && info "same Wi-Fi (no camera there, http):  http://$LAN_IP:$PORT"
info "first time? create a login:  $VENV_PY manage.py createsuperuser"
info "then make a class at /classrooms/create/ and open its link in two windows."
info "Ctrl+C stops the server."
printf '\n'

exec "$VENV_PY" manage.py runserver "0.0.0.0:$PORT"
