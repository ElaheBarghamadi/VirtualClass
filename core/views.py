"""Public views."""
from __future__ import annotations

import posixpath

from django.conf import settings
from django.db import connection
from django.http import Http404, JsonResponse
from django.shortcuts import render
from django.views.static import serve

#: The only part of MEDIA_ROOT that is public.  Everything else in there (and
#: all of PRIVATE_MEDIA_ROOT) belongs to permission-checked views.
PUBLIC_MEDIA_PREFIXES = ("classroom_logos/",)


def home_view(request):
    """Landing page. Authenticated users land on their dashboard."""
    return render(request, "home.html")


def public_media(request, path: str):
    """Serve public media (classroom logos) without needing a web server.

    `runserver` serves MEDIA_ROOT only while DEBUG is on, and a container
    platform gives you no nginx to add a `/media/` rule — logos would simply
    disappear in production.  This view serves exactly the public subtree, so
    the behaviour is identical on a laptop, on a VPS and on a platform; nginx
    can still take over by mapping `/media/` directly (it is only a shortcut).

    Anything outside :data:`PUBLIC_MEDIA_PREFIXES` is a 404 here — shared
    classroom files, presentation PDFs and assignment uploads live in
    ``PRIVATE_MEDIA_ROOT`` and are streamed by their own gated views.
    """
    # Normalise BEFORE the prefix check: "classroom_logos/../secret.txt"
    # starts with the public prefix but resolves outside it.
    normalized = posixpath.normpath(path)
    if normalized.startswith(("/", "..")):
        raise Http404("Not public media")
    if not any(normalized.startswith(prefix) for prefix in PUBLIC_MEDIA_PREFIXES):
        raise Http404("Not public media")
    return serve(request, normalized, document_root=str(settings.MEDIA_ROOT))


def health_view(request):
    """Liveness/readiness probe for the host (``/healthz``).

    Platform health checks and uptime monitors need one URL that answers fast
    and says nothing sensitive.  ``/healthz`` proves the ASGI process is up;
    ``/healthz?db=1`` additionally opens a database connection, which is what a
    readiness check should use (a process that cannot reach its database is not
    ready, even though it is alive).

    Deliberately cheap and silent: no session read, no session write, no
    template, no error details (an unauthenticated endpoint must not leak the
    driver's message).  Always ``Cache-Control: no-store`` so a CDN cannot
    cache a failure.
    """
    payload = {"status": "ok", "debug": settings.DEBUG}
    status = 200
    wants_db = request.GET.get("db", "").lower() in {"1", "true", "yes", "on"}
    if wants_db:
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1")
                cursor.fetchone()
            payload["database"] = "ok"
        except Exception:  # pragma: no cover - depends on the database
            payload["status"] = "error"
            payload["database"] = "unavailable"
            status = 503
    response = JsonResponse(payload, status=status)
    response["Cache-Control"] = "no-store"
    response["X-Robots-Tag"] = "noindex"
    return response
