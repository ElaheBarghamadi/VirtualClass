"""Public views."""
from __future__ import annotations

import posixpath

from django.conf import settings
from django.http import Http404
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
