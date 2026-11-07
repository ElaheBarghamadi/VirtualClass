"""
Django settings for the Online Classroom project.

All environment-specific values (secrets, hosts, databases, Redis) are read
from environment variables — see ``.env.example``.  Nothing sensitive is
hard-coded here.
"""
import os
from pathlib import Path
from urllib.parse import urlparse

from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent

# Load variables from a local .env file (silently ignored when absent).
load_dotenv(BASE_DIR / ".env")


def env_bool(name: str, default: str = "false") -> bool:
    return os.environ.get(name, default).lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str = "") -> list[str]:
    value = os.environ.get(name, default)
    return [item.strip() for item in value.split(",") if item.strip()]


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------
_DEV_SECRET_KEY = "django-insecure-dev-only-key-change-me-in-production"
SECRET_KEY = os.environ.get(
    "SECRET_KEY",
    # Fallback ONLY for local development convenience.  In production the
    # SECRET_KEY environment variable MUST be set to a random secret —
    # the fail-fast check below refuses to boot otherwise.
    _DEV_SECRET_KEY,
)
DEBUG = env_bool("DEBUG", "true")
# Development default: accept any Host header, so the app answers on
# localhost, a LAN IP, a phone on the same network and preview/proxy hosts
# (host names such as ``<port>-<sandbox>.e2b.app``) without extra setup.
# This is deliberately tied to DEBUG: with DEBUG off the default is strict and
# a literal ``*`` is refused by the guard right below.
ALLOWED_HOSTS = env_list("ALLOWED_HOSTS", "*" if DEBUG else "localhost,127.0.0.1,[::1]")

if not DEBUG and "*" in ALLOWED_HOSTS:
    # Fail fast: Host-header validation is what keeps password-reset links and
    # cache keys bound to *our* domain.  A wildcard silently disables that.
    raise ImproperlyConfigured(
        "ALLOWED_HOSTS=* is only allowed while DEBUG=true. With DEBUG=false "
        "list the real host names (e.g. ALLOWED_HOSTS=class.example.com)."
    )

if not DEBUG and SECRET_KEY == _DEV_SECRET_KEY:
    # Fail fast: a production deployment must never run on the public
    # dev key — sessions/CSRF tokens would be forgeable.
    raise ImproperlyConfigured(
        "SECRET_KEY is not set (or is the development default) while "
        "DEBUG=false. Generate one with:\n"
        "  python -c \"from django.core.management.utils import "
        "get_random_secret_key; print(get_random_secret_key())\"\n"
        "and put it in your .env file."
    )

INSTALLED_APPS = [
    "daphne",  # ASGI server (also powers `runserver` with WebSockets)
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Third party
    "channels",
    "rest_framework",
    "rest_framework.authtoken",
    # Local apps
    "core.apps.CoreConfig",
    "accounts.apps.AccountsConfig",
    "classrooms.apps.ClassroomsConfig",
    "chat.apps.ChatConfig",
    "whiteboard.apps.WhiteboardConfig",
    "quizzes.apps.QuizzesConfig",
    "assignments.apps.AssignmentsConfig",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # Serves /static/ straight from the app (compressed, cached), so a
    # deployment needs no nginx rule — and static is never missing on a
    # platform where you cannot edit one. Directly after SecurityMiddleware,
    # before anything that needs the session.
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    # Last: only ever fires when a WebSocket handshake reaches Django, which
    # means the process is WSGI (under ASGI, asgi.py routes /ws/ to Channels
    # before the HTTP stack). Answering 426 turns a flood of puzzling
    # "Not Found: /ws/…" lines into one actionable error.
    "core.middleware.ASGIOnlyWebSocketsMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
                "accounts.context_processors.ui_preferences",
                "config.assets.asset_context",
            ],
        },
    },
]

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
# SQLite is used for development.  In production set DATABASE_URL to a
# PostgreSQL DSN, e.g.:
#   DATABASE_URL=postgres://user:password@host:5432/dbname
# or a MySQL DSN (PythonAnywhere's standard database), e.g.:
#   DATABASE_URL=mysql://user:password@user.mysql.pythonanywhere-services.com/dbname
# Models are written to stay PostgreSQL/MySQL-compatible.
DATABASE_URL = os.environ.get("DATABASE_URL", "")


def _database_from_url(url: str) -> dict:
    """Translate a DATABASE_URL DSN into a Django DATABASES entry.

    Supported schemes: ``postgres(ql)://`` and ``mysql://``. An empty URL
    selects SQLite for development; an unsupported URL is rejected.
    """
    if url:
        parsed = urlparse(url)
        scheme = parsed.scheme.lower()
        if scheme in {"postgres", "postgresql"}:
            engine, default_port = "django.db.backends.postgresql", 5432
        elif scheme in {"mysql", "mysql2"}:
            engine, default_port = "django.db.backends.mysql", 3306
        else:
            raise ImproperlyConfigured("Unsupported DATABASE_URL scheme; refusing SQLite fallback.")
        if engine:
            return {
                "ENGINE": engine,
                "NAME": parsed.path.lstrip("/") or os.environ.get("DB_NAME", ""),
                "USER": parsed.username or os.environ.get("DB_USER", ""),
                "PASSWORD": parsed.password or os.environ.get("DB_PASSWORD", ""),
                "HOST": parsed.hostname or os.environ.get("DB_HOST", "localhost"),
                "PORT": str(parsed.port or os.environ.get("DB_PORT", default_port)),
            }
    return {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }


DATABASES = {"default": _database_from_url(DATABASE_URL)}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ---------------------------------------------------------------------------
# Channels / WebSockets
# ---------------------------------------------------------------------------
REDIS_URL = os.environ.get("REDIS_URL", "")

if REDIS_URL:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [REDIS_URL]},
        }
    }
else:
    # Single-process in-memory layer for local development without Redis.
    CHANNEL_LAYERS = {
        "default": {"BACKEND": "channels.layers.InMemoryChannelLayer"},
    }

# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------
AUTH_USER_MODEL = "accounts.User"

LOGIN_URL = "accounts:login"
LOGIN_REDIRECT_URL = "accounts:post_login"
LOGOUT_REDIRECT_URL = "home"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# ---------------------------------------------------------------------------
# Media server (LiveKit SFU)
# ---------------------------------------------------------------------------
# Django NEVER proxies media.  It only issues short-lived scoped JWTs
# (see classrooms/media.py); the browser connects to the SFU directly.
# Leave empty to run without media (chat/whiteboard still work).
LIVEKIT_URL = os.environ.get("MEDIA_SERVER_URL", "")
LIVEKIT_API_KEY = os.environ.get("MEDIA_SERVER_API_KEY", "")
LIVEKIT_API_SECRET = os.environ.get("MEDIA_SERVER_API_SECRET", "")
# A media token carries the publish grants, so its lifetime is also how long a
# revoked student could keep talking before the SFU drops them.  Two hours
# covers a long lesson, and the browser re-fetches a token and rejoins when the
# SFU disconnects it (static/js/media.js ``_scheduleReconnect``).
LIVEKIT_TOKEN_TTL_MINUTES = int(os.environ.get("MEDIA_TOKEN_TTL_MINUTES", "120"))

# Mesh cannot enforce revocation of an existing peer connection. Production
# defaults off; an explicit opt-in is for trusted/test deployments only.
MESH_ENABLED = os.environ.get("MESH_ENABLED", "1" if DEBUG else "0") == "1"

# ICE servers for the fallback P2P mesh.  STUN alone fails behind strict
# NATs, so deployments should run coturn and list it here, e.g.:
#   WEBRTC_ICE_SERVERS=[{"urls":["stun:turn.example.com:3478"]},
#     {"urls":["turn:turn.example.com:3478"],"username":"u","credential":"p"}]
# Empty → the client falls back to public Google STUN (no TURN relay).
import json as _json

def _parse_ice_servers(raw: str) -> list[dict]:
    if not raw:
        return []
    try:
        parsed = _json.loads(raw)
    except ValueError:
        return []
    return parsed if isinstance(parsed, list) else []

WEBRTC_ICE_SERVERS = _parse_ice_servers(os.environ.get("WEBRTC_ICE_SERVERS", ""))

# The mesh is O(n²) in connections; beyond this many concurrent
# participants the owner is warned to configure the LiveKit media server.
MESH_MAX_PARTICIPANTS = int(os.environ.get("MESH_MAX_PARTICIPANTS", "12"))

# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "25"))
FILE_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024  # larger uploads stream to disk
# per-user throttle for the upload endpoint (abuse/disk-fill protection)
UPLOAD_RATE_LIMIT = int(os.environ.get("UPLOAD_RATE_LIMIT", "10"))
UPLOAD_RATE_WINDOW = int(os.environ.get("UPLOAD_RATE_WINDOW", "600"))  # seconds

# ---------------------------------------------------------------------------
# Email — password reset and future notifications.
# Development: console backend (links print to the server console).
# Production: set EMAIL_HOST etc. in .env and EMAIL_BACKEND=smtp.
# ---------------------------------------------------------------------------
EMAIL_MODE = os.environ.get("EMAIL_BACKEND", "console").lower()
if EMAIL_MODE == "smtp":
    EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
    EMAIL_HOST = os.environ.get("EMAIL_HOST", "")
    EMAIL_PORT = int(os.environ.get("EMAIL_PORT", "587"))
    EMAIL_HOST_USER = os.environ.get("EMAIL_HOST_USER", "")
    EMAIL_HOST_PASSWORD = os.environ.get("EMAIL_HOST_PASSWORD", "")
    EMAIL_USE_TLS = env_bool("EMAIL_USE_TLS", "true")
else:
    EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
DEFAULT_FROM_EMAIL = os.environ.get("DEFAULT_FROM_EMAIL", "no-reply@classroom.local")

# ---------------------------------------------------------------------------
# Cache — Redis in production, local-memory fallback in development.
# Used for classroom password rate limiting and other ephemeral state.
# ---------------------------------------------------------------------------
if REDIS_URL:
    CACHES = {
        "default": {
            # Same Redis, but a cache that degrades instead of raising: a
            # restarted Redis must not 500 the login page (see core/cache.py).
            "BACKEND": "core.cache.ResilientRedisCache",
            "LOCATION": REDIS_URL,
            "OPTIONS": {
                # Fail fast: a dead Redis should cost milliseconds, not a
                # 20-second hang on every request that touches the cache.
                "socket_connect_timeout": 1,
                "socket_timeout": 2,
            },
        }
    }
else:
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        }
    }

# ---------------------------------------------------------------------------
# Django REST Framework
# ---------------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.TokenAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 20,
    # Scoped rates used by the throttled auth endpoints (api.py).
    "DEFAULT_THROTTLE_RATES": {
        "login": "30/hour",
        "register": "20/hour",
    },
}

# ---------------------------------------------------------------------------
# Internationalization
# ---------------------------------------------------------------------------
LANGUAGE_CODE = "fa-ir"
TIME_ZONE = os.environ.get("TIME_ZONE", "UTC")
USE_I18N = True
USE_TZ = True

# ---------------------------------------------------------------------------
# Background jobs — Celery
# ---------------------------------------------------------------------------
# One Redis does the whole job list: channel layer, cache, task broker and
# result backend.  ``REDIS_URL`` (see Channels above) is the single switch:
#
#   REDIS_URL set    → real queue.  Run one worker:
#                      celery -A config worker -l info
#                      celery -A config beat -l info   (periodic jobs)
#   REDIS_URL empty  → no broker, so tasks run inline (eager) in the web
#                      process.  Development and the test-suite stay
#                      dependency-free, and uploads behave as they always did.
CELERY_BROKER_URL = os.environ.get("CELERY_BROKER_URL", REDIS_URL or "memory://")
CELERY_RESULT_BACKEND = os.environ.get(
    "CELERY_RESULT_BACKEND", REDIS_URL or "cache+memory://"
)
CELERY_TASK_ALWAYS_EAGER = env_bool(
    "CELERY_TASK_ALWAYS_EAGER", "true" if not REDIS_URL else "false"
)
# A background job must never be able to turn a successful upload into a 500.
CELERY_TASK_EAGER_PROPAGATES = False
# Nobody waits on the result of these jobs; skipping the backend keeps Redis
# free of one key per upload.
CELERY_TASK_IGNORE_RESULT = True
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TIMEZONE = TIME_ZONE
CELERY_ENABLE_UTC = True
# Fail fast instead of hanging a request when the broker is unreachable;
# ``core.queue.dispatch`` then runs the job inline.
CELERY_BROKER_CONNECTION_TIMEOUT = int(
    os.environ.get("CELERY_BROKER_CONNECTION_TIMEOUT", "2")
)
# One failed publish is enough: retrying hides the outage behind a slow
# request.  ``core.queue.dispatch`` runs the job in-process instead.
CELERY_TASK_PUBLISH_RETRY = False
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
# A stuck conversion or an infinite loop in a job is killed, not left forever.
CELERY_TASK_TIME_LIMIT = int(os.environ.get("CELERY_TASK_TIME_LIMIT", "600"))
# soft limit = a chance to clean up before the hard kill
CELERY_TASK_SOFT_TIME_LIMIT = max(30, CELERY_TASK_TIME_LIMIT - 60)
CELERY_TASK_DEFAULT_QUEUE = "default"
CELERY_WORKER_MAX_TASKS_PER_CHILD = int(os.environ.get("CELERY_MAX_TASKS_PER_CHILD", "200"))

# Periodic jobs, driven by `celery -A config beat` (no system cron needed).
# Interval jobs are in seconds; the daily ones use cron syntax.
from celery.schedules import crontab  # noqa: E402  (used by the schedule below)

CELERY_BEAT_SCHEDULE = {
    # A session that was never ended would keep its room "in class" forever.
    "close-stale-sessions": {
        "task": "classrooms.tasks.close_stale_sessions",
        "schedule": 15 * 60,
    },
    # Same housekeeping as `manage.py prune_history`, just automatic.
    "prune-history": {
        "task": "core.tasks.prune_history",
        "schedule": crontab(hour=3, minute=30),
    },
    # Guests are throwaway rows; nobody needs last term's.
    "prune-stale-guests": {
        "task": "classrooms.tasks.prune_stale_guests",
        "schedule": crontab(hour=3, minute=50),
    },
}

# Housekeeping windows (0 / negative disables the corresponding job).
STALE_SESSION_HOURS = int(os.environ.get("STALE_SESSION_HOURS", "8"))
GUEST_RETENTION_DAYS = int(os.environ.get("GUEST_RETENTION_DAYS", "7"))
# Defaults mirror `manage.py prune_history`: boards 90 days, chat kept forever.
PRUNE_BOARD_DAYS = int(os.environ.get("PRUNE_BOARD_DAYS", "90"))
PRUNE_CHAT_DAYS = int(os.environ.get("PRUNE_CHAT_DAYS", "0"))

# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------
STATIC_URL = "static/"
STATICFILES_DIRS = [BASE_DIR / "static"]
# `collectstatic` target.  Overridable so a container can build the files into
# the image and a bare-metal host can serve them from /var/www.
STATIC_ROOT = Path(os.environ.get("STATIC_ROOT") or BASE_DIR / "staticfiles")

MEDIA_URL = "media/"
# Public uploads (classroom logos).  On a container platform this MUST point at
# a persistent volume, otherwise every deploy wipes the files.
MEDIA_ROOT = Path(os.environ.get("MEDIA_ROOT") or BASE_DIR / "media")

# WhiteNoise reads STATIC_ROOT; compressed variants are built by collectstatic.
# Deliberately not the *manifest* storage: the templates already version their
# URLs (config/assets.py), and a missing manifest would break a deployment
# that forgot one collectstatic.
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedStaticFilesStorage",
    },
}
# Static files rarely change and are served by the app: a short browser cache
# keeps the room fast without pinning old CSS after a deploy.
WHITENOISE_MAX_AGE = int(os.environ.get("WHITENOISE_MAX_AGE", "0" if DEBUG else "3600"))
# `runserver` already serves static; collecting on every boot would be noise.
WHITENOISE_AUTOREFRESH = DEBUG
# Must be outside MEDIA_ROOT and any web-server static mapping.
PRIVATE_MEDIA_ROOT = Path(os.environ.get("PRIVATE_MEDIA_ROOT") or BASE_DIR / "private_media").resolve()
if (PRIVATE_MEDIA_ROOT == MEDIA_ROOT.resolve()
        or MEDIA_ROOT.resolve() in PRIVATE_MEDIA_ROOT.parents
        or PRIVATE_MEDIA_ROOT in MEDIA_ROOT.resolve().parents):
    raise ImproperlyConfigured("PRIVATE_MEDIA_ROOT and MEDIA_ROOT must be disjoint.")

# ---------------------------------------------------------------------------
# Security (tightened automatically when DEBUG is off)
# ---------------------------------------------------------------------------
CSRF_COOKIE_HTTPONLY = False  # must remain readable by JS templates (Django default)
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS", "")
# Preview/sandbox proxies (and most local reverse proxies) terminate TLS and
# forward plain HTTP.  Without this, Django considers every request insecure,
# so the browser's ``Origin: https://<host>`` never matches and every form POST
# — login first of all — dies with 403 CSRF.  Only trusted by default while
# DEBUG is on: in production the operator opts in explicitly, because a
# spoofable header must never decide whether a request was secure.
if env_bool("TRUST_X_FORWARDED_PROTO", "true" if DEBUG else "false"):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

if not DEBUG:
    SESSION_COOKIE_SECURE = env_bool("SESSION_COOKIE_SECURE", "true")
    CSRF_COOKIE_SECURE = env_bool("CSRF_COOKIE_SECURE", "true")
    SECURE_SSL_REDIRECT = env_bool("SECURE_SSL_REDIRECT", "true")
    SECURE_HSTS_SECONDS = 60 * 60 * 24 * 30
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    X_FRAME_OPTIONS = "DENY"

# Structured application logging.  Sensitive data (passwords, tokens,
# credentials) is never logged — loggers receive identifiers only.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "structured": {
            "format": "{levelname} {asctime} {name} {message}",
            "style": "{",
        },
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "structured"},
    },
    "loggers": {
        "classrooms.consumers": {"handlers": ["console"], "level": "INFO"},
        "classrooms.services": {"handlers": ["console"], "level": "INFO"},
        "classrooms.views": {"handlers": ["console"], "level": "INFO"},
        "chat.consumers": {"handlers": ["console"], "level": "INFO"},
        "whiteboard.consumers": {"handlers": ["console"], "level": "INFO"},
    },
}
