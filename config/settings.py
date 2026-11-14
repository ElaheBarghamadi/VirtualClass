"""
Django settings for the Online Classroom project.

**Nothing here is required.**  Every value has a working default, so the project
boots on a bare server with no ``.env`` and no environment variable at all —
that is the "just put it on a host and look at it" mode, and ``ZERO_CONFIG``
below records whether that is the mode this process is in.  Variables still
exist for a real deployment (see ``.env.example``), and an explicitly provided
value always wins over the default.
"""
import os
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

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


def env_first(*names: str) -> str:
    """The first of ``names`` that is set and non-empty.

    Hosting platforms are not consistent about the name of the variable that
    holds the database DSN or the published address (``DATABASE_URL`` here,
    ``POSTGRES_URL`` there, ``DATABASE_PRIVATE_URL`` on one PaaS).  Reading them
    all means a linked add-on is used without the operator retyping anything.
    """
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


# ---------------------------------------------------------------------------
# Where this deployment lives (optional, read from the platform when provided)
# ---------------------------------------------------------------------------
_PUBLISHED_URL_VARS = (
    "PUBLIC_URL",
    "APP_URL",
    "SITE_URL",
    "WEBSITE_URL",
    "BASE_URL",
    "RENDER_EXTERNAL_URL",
    "RAILWAY_PUBLIC_DOMAIN",
    "FLY_APP_NAME",
)


def _published_url() -> str:
    """The address this deployment is publicly served on, if it says so."""
    for name in _PUBLISHED_URL_VARS:
        raw = (os.environ.get(name) or "").strip()
        if not raw:
            continue
        if name == "FLY_APP_NAME":
            return f"https://{raw}.fly.dev"
        return raw if "://" in raw else f"https://{raw}"
    return ""


_PUBLISHED_URL = _published_url()
_PUBLISHED_PARSED = urlparse(_PUBLISHED_URL) if _PUBLISHED_URL else None
PUBLISHED_HOST = (_PUBLISHED_PARSED.netloc.lower() if _PUBLISHED_PARSED else "")
PUBLISHED_SCHEME = ((_PUBLISHED_PARSED.scheme or "https").lower() if _PUBLISHED_PARSED else "")

# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------
_DEV_SECRET_KEY = "django-insecure-dev-only-key-change-me-in-production"
DEBUG = env_bool("DEBUG", "true")


def _secret_key_path() -> Path:
    """Where an auto-generated SECRET_KEY is kept between restarts."""
    configured = (os.environ.get("SECRET_KEY_FILE") or "").strip()
    if configured:
        return Path(configured)
    # Inside the private uploads directory: already gitignored, and already the
    # one folder a container platform mounts as a volume — so the key survives a
    # redeploy and nobody is logged out by a deployment.
    private_root = (os.environ.get("PRIVATE_MEDIA_ROOT") or "").strip()
    if private_root:
        return Path(private_root) / ".secret_key"
    return BASE_DIR / "private_media" / ".secret_key"


def _load_or_create_secret_key() -> tuple[str, str]:
    """A random key that survives a restart without being configured.

    Returns ``(key, source)`` where source is ``"file"`` when an earlier run
    left a key behind, ``"generated"`` when this run minted and stored one, and
    ``"ephemeral"`` when the file system refused to keep it (a container with a
    read-only app directory): the app still runs, sessions just end on restart.
    """
    from django.core.management.utils import get_random_secret_key

    path = _secret_key_path()
    try:
        existing = path.read_text(encoding="utf-8").strip()
    except OSError:
        existing = ""
    if len(existing) >= 40:
        return existing, "file"

    key = get_random_secret_key()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(key, encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:  # pragma: no cover - exotic file systems
            pass
        return key, "generated"
    except OSError:  # pragma: no cover - read-only app directory
        return key, "ephemeral"


_configured_secret_key = (os.environ.get("SECRET_KEY") or "").strip()

if _configured_secret_key and _configured_secret_key != _DEV_SECRET_KEY:
    SECRET_KEY, SECRET_KEY_SOURCE = _configured_secret_key, "env"
elif DEBUG:
    # Local convenience: nothing is public, and sessions may reset at will.
    SECRET_KEY, SECRET_KEY_SOURCE = _DEV_SECRET_KEY, "dev"
else:
    # Zero-config deployment: mint a key and keep it in a gitignored 0600 file,
    # so logins survive a restart.  Never the public development key — that one
    # would make sessions and CSRF tokens forgeable by anyone reading the repo.
    SECRET_KEY, SECRET_KEY_SOURCE = _load_or_create_secret_key()

# Accept the address the browser actually types, without being told which one it
# is.  ``*`` is a supported answer in every mode — including production, where a
# test server is reached by an IP or a platform-generated hostname that nobody
# wants to type twice.  An explicit list narrows it; a platform-published
# address (PUBLISHED_*) narrows it automatically.  ``deploy.W012`` reports the
# open case at boot so it is visible in the log, not a silent surprise.
_configured_hosts = env_list("ALLOWED_HOSTS")

if _configured_hosts:
    ALLOWED_HOSTS = _configured_hosts
elif PUBLISHED_HOST:
    # The platform told us its domain: name it, and keep the loopback names so a
    # health probe or an SSH tunnel still answers.
    ALLOWED_HOSTS = [PUBLISHED_HOST, "localhost", "127.0.0.1", "[::1]"]
else:
    ALLOWED_HOSTS = ["*"]

# True whenever Host-header validation is effectively off (``*``), whether that
# came from the default or from an explicit ALLOWED_HOSTS=*.
HOSTS_AUTO = "*" in ALLOWED_HOSTS

if PUBLISHED_HOST and "*" not in ALLOWED_HOSTS and PUBLISHED_HOST not in ALLOWED_HOSTS:
    ALLOWED_HOSTS = [*ALLOWED_HOSTS, PUBLISHED_HOST]

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
    # First on purpose: lets a platform's health probe answer even when it calls
    # the container by IP (see core.middleware.HealthProbeHostMiddleware).
    "core.middleware.HealthProbeHostMiddleware",
    # Before SecurityMiddleware: it calls request.get_host() itself, and a
    # DisallowedHost there must still reach a designed page.
    "core.middleware.HostHeaderGuardMiddleware",
    "django.middleware.security.SecurityMiddleware",
    # An unmigrated database answers with a page + 503 instead of a traceback
    # (see core.middleware.DatabaseNotReadyMiddleware).
    "core.middleware.DatabaseNotReadyMiddleware",
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
DATABASE_URL = env_first(
    "DATABASE_URL",
    "POSTGRES_URL",
    "DATABASE_PRIVATE_URL",
    "POSTGRESQL_URL",
)


def _database_from_url(url: str) -> dict:
    """Translate a DATABASE_URL DSN into a Django DATABASES entry.

    Supported schemes: ``postgres(ql)://`` and ``mysql://``.  An empty URL
    selects SQLite for development; an unsupported URL is rejected instead of
    silently falling back (data must never land in the wrong place).

    Managed hosts hand out DSNs that carry their TLS requirements in the query
    string — ``postgres://u:p@h:5432/db?sslmode=require`` — and percent-encoded
    credentials (``p%40ss`` for ``p@ss``).  Both were dropped before, which on a
    real host means either a refused connection ("no pg_hba.conf entry … SSL
    off") or a wrong password.  Query parameters are honoured, credentials are
    decoded, and ``DB_CONN_MAX_AGE`` / ``DB_DISABLE_SERVER_SIDE_CURSORS`` cover
    the two connection-pooling setups managed PostgreSQL usually uses.
    """
    if url:
        parsed = urlparse(url)
        scheme = parsed.scheme.lower()
        if scheme in {"postgres", "postgresql"}:
            engine, default_port = "django.db.backends.postgresql", 5432
        elif scheme in {"mysql", "mysql2"}:
            engine, default_port = "django.db.backends.mysql", 3306
        else:
            raise ImproperlyConfigured(
                "Unsupported DATABASE_URL scheme; refusing SQLite fallback. "
                "Use postgres:// or mysql://."
            )

        query = parse_qs(parsed.query)

        def param(name: str) -> str | None:
            values = query.get(name)
            return unquote(values[0]) if values else None

        options: dict[str, object] = {}
        if engine.endswith("postgresql"):
            # libpq parameters a hosted database asks for explicitly.
            for key in ("sslmode", "connect_timeout", "application_name", "options"):
                value = param(key)
                if not value:
                    continue
                options[key] = int(value) if key == "connect_timeout" and value.isdigit() else value
        else:
            # Persian text needs the 4-byte charset on MySQL/MariaDB.
            options["charset"] = "utf8mb4"

        try:
            connect_timeout = int(os.environ.get("DB_CONNECT_TIMEOUT", "10"))
        except ValueError:
            connect_timeout = 10
        if engine.endswith("postgresql") and "connect_timeout" not in options:
            # A hung database must fail a request, not freeze a worker.
            options["connect_timeout"] = connect_timeout

        entry = {
            "ENGINE": engine,
            "NAME": unquote(parsed.path.lstrip("/")) or os.environ.get("DB_NAME", ""),
            "USER": unquote(parsed.username or os.environ.get("DB_USER", "")),
            "PASSWORD": unquote(parsed.password or os.environ.get("DB_PASSWORD", "")),
            "HOST": parsed.hostname or os.environ.get("DB_HOST", "localhost"),
            "PORT": str(parsed.port or os.environ.get("DB_PORT", default_port)),
            "OPTIONS": options,
        }
        # Persistent connections are what make a Django process cheap under
        # load — but a supervised/pooled database drops them, so the default is
        # 0 (open per request) unless the operator asks for reuse.
        try:
            entry["CONN_MAX_AGE"] = int(os.environ.get("DB_CONN_MAX_AGE", "0"))
        except ValueError:
            entry["CONN_MAX_AGE"] = 0
        if entry["CONN_MAX_AGE"]:
            entry["CONN_HEALTH_CHECKS"] = True
        # A transaction-pooling pgbouncer cannot use server-side cursors.
        entry["DISABLE_SERVER_SIDE_CURSORS"] = env_bool(
            "DB_DISABLE_SERVER_SIDE_CURSORS", "false"
        )
        return entry
    return {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
        # SQLite under several workers: fail loudly instead of "database is
        # locked" after a 5-second stall.
        "OPTIONS": {"timeout": 20},
    }


def _database_from_env() -> dict:
    """Pick the database without being told: DSN, then PG* parts, then SQLite.

    A platform that links a PostgreSQL add-on injects either one DSN or the
    ``PG*`` component variables; both are used as-is.  Only when neither exists
    does the project fall back to SQLite — which works immediately, and
    ``deploy.W003`` says out loud that a container's SQLite does not survive the
    next deploy.
    """
    if DATABASE_URL:
        return _database_from_url(DATABASE_URL)

    host = env_first("PGHOST", "POSTGRES_HOST")
    name = env_first("PGDATABASE", "POSTGRES_DB")
    if host and name:
        entry: dict[str, object] = {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": name,
            "USER": env_first("PGUSER", "POSTGRES_USER"),
            "PASSWORD": env_first("PGPASSWORD", "POSTGRES_PASSWORD"),
            "HOST": host,
            "PORT": env_first("PGPORT", "POSTGRES_PORT") or "5432",
            "OPTIONS": {"connect_timeout": 10},
            "CONN_MAX_AGE": 0,
            "DISABLE_SERVER_SIDE_CURSORS": env_bool(
                "DB_DISABLE_SERVER_SIDE_CURSORS", "false"
            ),
        }
        sslmode = env_first("PGSSLMODE")
        if sslmode:
            entry["OPTIONS"]["sslmode"] = sslmode  # type: ignore[index]
        return entry

    return _database_from_url("")


DATABASES = {"default": _database_from_env()}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ---------------------------------------------------------------------------
# Channels / WebSockets
# ---------------------------------------------------------------------------
# Same idea as the database: the platform links one Redis and names it whatever
# it likes.  Empty means "no broker" — in-memory channel layer, local cache,
# background jobs inline — which is exactly what a single-process test deploy
# needs.
REDIS_URL = env_first("REDIS_URL", "REDIS_TLS_URL", "REDISCLOUD_URL")
if REDIS_URL and not REDIS_URL.startswith(("redis://", "rediss://", "unix://")):
    REDIS_URL = ""

# True when this process runs on defaults: no secret, no host list, no database
# DSN, no broker — "put it on a server and look at it".  Only the deployment
# report and `deploy_check` read it; no behaviour depends on it.
ZERO_CONFIG = (
    not (_configured_secret_key and _configured_secret_key != _DEV_SECRET_KEY)
    and not _configured_hosts
    and not DATABASE_URL
    and not REDIS_URL
)

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

# Mesh cannot enforce revocation of an existing peer connection, so a
# deployment that *has* an SFU should use it: the mesh is off as soon as
# MEDIA_SERVER_URL is configured.  With no SFU in front of it, the mesh is the
# only thing that puts a camera in the room — so it is on by default rather than
# leaving a zero-config deployment with silently dead microphones.
MESH_ENABLED = env_bool("MESH_ENABLED", "0" if LIVEKIT_URL else "1")

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
# ...and a bare server that never ran `collectstatic` still renders with styles:
# with no collected files, WhiteNoise serves straight from the source
# directories instead of answering 404 for every stylesheet.
_static_files_collected = STATIC_ROOT.is_dir() and any(STATIC_ROOT.iterdir())
WHITENOISE_USE_FINDERS = env_bool(
    "WHITENOISE_USE_FINDERS", "false" if _static_files_collected else "true"
)
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

# Same idea as the Host header: if the deployment publishes its own address,
# that origin is by definition ours, so form posts from it must not fail CSRF.
# (The list still has no bare ``*``; every entry is a concrete origin.)
if PUBLISHED_HOST:
    _published_origin = f"{PUBLISHED_SCHEME or 'https'}://{PUBLISHED_HOST}"
    if _published_origin not in CSRF_TRUSTED_ORIGINS:
        CSRF_TRUSTED_ORIGINS = [*CSRF_TRUSTED_ORIGINS, _published_origin]

# Preview/sandbox proxies (and most local reverse proxies) terminate TLS and
# forward plain HTTP.  Without this, Django considers every request insecure,
# so the browser's ``Origin: https://<host>`` never matches and every form POST
# — login first of all — dies with 403 CSRF.  Trusted by default now: it is what
# makes a proxy-hosted deployment work with no configuration, and it can no
# longer decide whether a request is *allowed* to be secure — the redirect and
# the ``Secure`` cookies below stay off until HTTPS is actually declared.
if env_bool("TRUST_X_FORWARDED_PROTO", "true"):
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# CSRF rejections render the same designed page as every other 403.
CSRF_FAILURE_VIEW = "core.error_views.csrf_failure"

# Is TLS really in front of this deployment?  Known when it publishes an https
# address (``PUBLIC_URL``/``APP_URL``/…) or when ``HTTPS_IN_USE=true`` says so;
# otherwise "not yet".  The default leans this way on purpose, because the two
# mistakes are not equally bad:
#   * a cookie without ``Secure`` is still sent over https — nobody notices;
#   * a ``Secure`` cookie is *never* sent over plain http, so on a bare
#     ``http://server:8000`` the login form posts, sets a cookie, and the next
#     request arrives without it — "the login does nothing", the worst possible
#     first impression of a test deploy.
# The intermediate state is reported by ``deploy.W013``, and one variable
# (``HTTPS_IN_USE=true``) turns the strict settings on.
HTTPS_IN_USE = env_bool(
    "HTTPS_IN_USE",
    "true" if (PUBLISHED_HOST and PUBLISHED_SCHEME == "https") else "false",
)

if not DEBUG:
    SESSION_COOKIE_SECURE = env_bool("SESSION_COOKIE_SECURE", "false" if not HTTPS_IN_USE else "true")
    CSRF_COOKIE_SECURE = env_bool("CSRF_COOKIE_SECURE", "false" if not HTTPS_IN_USE else "true")
    SECURE_SSL_REDIRECT = env_bool("SECURE_SSL_REDIRECT", "false" if not HTTPS_IN_USE else "true")
    # HSTS is a promise to the browser for a whole year: never send it for a
    # host that may be opened over http (it would make that host unreachable).
    SECURE_HSTS_SECONDS = int(
        os.environ.get(
            "SECURE_HSTS_SECONDS", str(60 * 60 * 24 * 30) if HTTPS_IN_USE else "0"
        )
    )
    SECURE_HSTS_INCLUDE_SUBDOMAINS = env_bool(
        "SECURE_HSTS_INCLUDE_SUBDOMAINS", "true" if HTTPS_IN_USE else "false"
    )
    # Only meaningful once the domain is submitted to the browser preload list;
    # blanket-enabling it is a decision the operator has to make.
    SECURE_HSTS_PRELOAD = env_bool("SECURE_HSTS_PRELOAD", "false")
    SECURE_REFERRER_POLICY = os.environ.get("SECURE_REFERRER_POLICY", "same-origin")
    SECURE_CONTENT_TYPE_NOSNIFF = True
    X_FRAME_OPTIONS = "DENY"
    # A platform probe must get an answer, not a 301 to the same machine over
    # TLS it cannot speak.  `/healthz` returns no data, so serving it over the
    # internal HTTP port leaks nothing.
    SECURE_REDIRECT_EXEMPT = env_list("SECURE_REDIRECT_EXEMPT", r"^healthz$")

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
