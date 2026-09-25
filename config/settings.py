"""
Django settings for the Online Classroom project.

All environment-specific values (secrets, hosts, databases, Redis) are read
from environment variables — see ``.env.example``.  Nothing sensitive is
hard-coded here.
"""
import os
from pathlib import Path
from urllib.parse import urlparse

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
SECRET_KEY = os.environ.get(
    "SECRET_KEY",
    # Fallback ONLY for local development convenience.  In production the
    # SECRET_KEY environment variable MUST be set to a random secret.
    "django-insecure-dev-only-key-change-me-in-production",
)
DEBUG = env_bool("DEBUG", "true")
ALLOWED_HOSTS = env_list("ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]")

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
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
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
# Models are written to stay PostgreSQL-compatible.
DATABASE_URL = os.environ.get("DATABASE_URL", "")

if DATABASE_URL:
    _parsed = urlparse(DATABASE_URL)
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": _parsed.path.lstrip("/") or os.environ.get("DB_NAME", ""),
            "USER": _parsed.username or os.environ.get("DB_USER", ""),
            "PASSWORD": _parsed.password or os.environ.get("DB_PASSWORD", ""),
            "HOST": _parsed.hostname or os.environ.get("DB_HOST", "localhost"),
            "PORT": str(_parsed.port or os.environ.get("DB_PORT", 5432)),
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }

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
LIVEKIT_TOKEN_TTL_MINUTES = int(os.environ.get("MEDIA_TOKEN_TTL_MINUTES", "360"))

# ---------------------------------------------------------------------------
# Uploads
# ---------------------------------------------------------------------------
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "25"))
FILE_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024  # larger uploads stream to disk

# ---------------------------------------------------------------------------
# Cache — Redis in production, local-memory fallback in development.
# Used for classroom password rate limiting and other ephemeral state.
# ---------------------------------------------------------------------------
if REDIS_URL:
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.redis.RedisCache",
            "LOCATION": REDIS_URL,
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
# Static files
# ---------------------------------------------------------------------------
STATIC_URL = "static/"
STATICFILES_DIRS = [BASE_DIR / "static"]
STATIC_ROOT = BASE_DIR / "staticfiles"

MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "media"

# ---------------------------------------------------------------------------
# Security (tightened automatically when DEBUG is off)
# ---------------------------------------------------------------------------
CSRF_COOKIE_HTTPONLY = False  # must remain readable by JS templates (Django default)
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS", "")
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
