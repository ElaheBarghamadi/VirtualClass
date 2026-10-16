"""
ASGI entrypoint.

Routes HTTP traffic to Django and WebSocket traffic to Django Channels
consumers.  Redis (or the in-memory layer in development) is used as the
channel layer for cross-process messaging.

It also refuses to start silently with an outdated database: a missing
migration used to surface as a WebSocket that connects and then dies with a
SQL traceback (``no such column: whiteboard_whiteboard.page_count``), which
looks like a broken whiteboard rather than a database that needs one command.
"""
import os
import sys

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

# get_asgi_application() must be called before importing anything that
# touches models, so keep this import below it.
django_asgi_app = get_asgi_application()


def _pending_migrations() -> list[str]:
    """Names of the migrations this database has not applied yet."""
    try:
        from django.db import connection
        from django.db.migrations.executor import MigrationExecutor

        executor = MigrationExecutor(connection)
        plan = executor.migration_plan(executor.loader.graph.leaf_nodes())
        return [f"{migration.app_label}.{migration.name}" for migration, _ in plan]
    except Exception:  # a missing/unreachable database is reported elsewhere
        return []


def _warn_about_pending_migrations() -> None:
    if "test" in sys.argv or os.environ.get("SKIP_MIGRATION_CHECK") == "1":
        return
    pending = _pending_migrations()
    if not pending:
        return
    shown = ", ".join(pending[:6]) + ("…" if len(pending) > 6 else "")
    banner = (
        "\n" + "=" * 78 + "\n"
        "  DATABASE IS NOT UP TO DATE — the real-time features will not work.\n"
        f"  Pending migrations: {shown}\n"
        "  Fix it with:  python manage.py migrate\n"
        "=" * 78 + "\n"
    )
    print(banner, file=sys.stderr, flush=True)


_warn_about_pending_migrations()

from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from channels.sessions import SessionMiddlewareStack  # noqa: E402

from chat.routing import websocket_urlpatterns as chat_ws  # noqa: E402
from classrooms.routing import websocket_urlpatterns as classroom_ws  # noqa: E402
from whiteboard.routing import websocket_urlpatterns as whiteboard_ws  # noqa: E402

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        # SessionMiddlewareStack gives consumers access to the Django
        # session — how guest participants are authenticated on sockets.
        "websocket": SessionMiddlewareStack(
            AuthMiddlewareStack(URLRouter([*classroom_ws, *chat_ws, *whiteboard_ws]))
        ),
    }
)
