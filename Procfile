# Procfile — only used by platforms that read it (Heroku-style runners).
# It is never used locally; `scripts/dev.py` and `manage.py runserver` stay the
# development path. Weblines: point the app at deploy/weblines/Dockerfile
# instead — the image's CMD already does all of this.
#
# The point of this file: whatever starts the app must be an ASGI server.
# gunicorn (the default for most Python presets) cannot carry /ws/, so the
# room, chat and whiteboard would stay disconnected.
web: daphne -b 0.0.0.0 -p ${PORT:-8000} --proxy-headers config.asgi:application
worker: celery -A config worker --loglevel=INFO --concurrency=2
beat: celery -A config beat --loglevel=INFO
release: python manage.py migrate --noinput && python manage.py collectstatic --noinput
