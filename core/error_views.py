"""Error pages that are part of the product, not a stack trace.

Django's defaults render ``404.html``/``500.html`` with the request's context
processors; a 500 has to be renderable when the reason for it is a broken
database, a missing cache or a template that raised — so these views render the
pages **without** context processors and pass only what the page needs.

The four handlers are wired in ``config/urls.py`` (``handler400`` …), which is
also what makes them testable: a test can call ``server_error`` directly instead
of provoking a real crash.
"""
from __future__ import annotations

import logging

from django.conf import settings
from django.http import Http404, HttpResponse
from django.template import loader

from config.assets import asset_version

logger = logging.getLogger(__name__)


def _render(template_name: str, status: int, *, request=None, **extra) -> HttpResponse:
    """Render an error page with a deliberately tiny, request-free context."""
    context = {"ASSET_V": asset_version()}
    signed_in = False
    if request is not None:
        # ``user`` may be a lazy object whose session lookup is what just
        # failed; never let the error page become the second exception.
        try:
            signed_in = bool(request.user.is_authenticated)
        except Exception:  # pragma: no cover - defensive
            signed_in = False
        context["request_path"] = request.path
    context["signed_in"] = signed_in
    context.update(extra)
    body = loader.get_template(template_name).render(context)
    return HttpResponse(body, status=status, content_type="text/html; charset=utf-8")


def bad_request(request, exception=None) -> HttpResponse:
    return _render("400.html", 400, request=request)


def permission_denied(request, exception=None) -> HttpResponse:
    return _render("403.html", 403, request=request)


def csrf_failure(request, reason="") -> HttpResponse:
    """CSRF rejections reach ``403.html`` too, with the real reason."""
    logger.warning("csrf_failure: %s (%s)", request.path, reason)
    return _render("403.html", 403, request=request, csrf_reason=reason)


def page_not_found(request, exception=None) -> HttpResponse:
    return _render("404.html", 404, request=request)


def server_error(request) -> HttpResponse:
    logger.error("server_error on %s", getattr(request, "path", "?"))
    return _render("500.html", 500, request=request)


#: DEBUG-only design preview — see ``config/urls.py``.
_PREVIEW = {400: bad_request, 403: permission_denied, 404: page_not_found, 500: server_error}


def preview(request, code: int) -> HttpResponse:
    """Render an error page on purpose, for design work.

    With DEBUG on, Django answers a real 404 with its yellow traceback page, so
    the designed pages would be invisible while they are being built. This route
    exists only while DEBUG is on and 404s otherwise.
    """
    if not settings.DEBUG or code not in _PREVIEW:
        raise Http404("Not found")
    return _PREVIEW[code](request)
