#!/bin/sh
# One image, three roles — Web / Celery worker / Celery beat.
#
# Weblines (and most container platforms) run whatever the image's CMD is, so
# the role is chosen with an environment variable per service:
#
#   ROLE=web     (app)    → Daphne on $PORT, after migrating
#   ROLE=worker  (worker) → celery worker
#   ROLE=beat    (worker) → celery beat, exactly one instance
#   ROLE=shell            → a Django shell (handy in the container shell)
set -eu

ROLE="${ROLE:-web}"
PORT="${PORT:-8000}"

echo "entrypoint: role=${ROLE} port=${PORT}"

# Data directories live on a mounted volume; Django writes into them but does
# not create their roots for you.
mkdir -p "${MEDIA_ROOT:-/app/media}" "${PRIVATE_MEDIA_ROOT:-/app/private_media}" 2>/dev/null || true

case "$ROLE" in
  web)
    # Idempotent and cheap; keeps schema and code in step on every deploy.
    if [ "${MIGRATE_ON_START:-1}" = "1" ]; then
      echo "entrypoint: applying migrations"
      python manage.py migrate --noinput
    fi
    # Static files are baked into the image by `collectstatic` at build time
    # and served by WhiteNoise, so there is no nginx rule to get wrong.
    exec daphne -b 0.0.0.0 -p "$PORT" --proxy-headers config.asgi:application
    ;;
  worker)
    exec celery -A config worker \
      --loglevel="${CELERY_LOG_LEVEL:-INFO}" \
      --concurrency="${CELERY_CONCURRENCY:-2}" \
      --max-tasks-per-child="${CELERY_MAX_TASKS_PER_CHILD:-200}"
    ;;
  beat)
    exec celery -A config beat --loglevel="${CELERY_LOG_LEVEL:-INFO}"
    ;;
  shell)
    exec python manage.py shell
    ;;
  *)
    echo "entrypoint: unknown ROLE='$ROLE' (use web|worker|beat|shell)" >&2
    exit 1
    ;;
esac
