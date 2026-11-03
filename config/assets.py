"""Asset cache-busting.

Static files are served with ``Last-Modified`` only, so browsers apply
*heuristic* freshness and may keep a stale ``.js`` module for minutes — which is
how a page can keep running old code right after a pull (the room kept asking
for ``/files/<id>/download/`` instead of ``?inline=1`` because the browser was
still on the previous ``presentation.js``).

``asset_version()`` is the newest mtime under the static directories, exposed to
templates as ``ASSET_V`` so every asset URL changes whenever any asset changes.
The value is cached for a couple of seconds (several templates render per page).
"""
from __future__ import annotations

import time

from django.conf import settings

_cache: dict[str, object] = {"at": 0.0, "value": ""}
TTL = 2.0


def _newest_mtime() -> float:
    newest = 0.0
    for root in getattr(settings, "STATICFILES_DIRS", []):
        try:
            for path in root.rglob("*"):
                if not path.is_file():
                    continue
                mtime = path.stat().st_mtime
                if mtime > newest:
                    newest = mtime
        except OSError:  # pragma: no cover - unreadable dir
            continue
    return newest


def asset_version() -> str:
    """Short token that changes whenever any static file changes."""
    now = time.monotonic()
    if now - float(_cache["at"]) < TTL:
        return str(_cache["value"])
    try:
        newest = _newest_mtime()
        value = format(int(newest), "x") if newest else ""
    except Exception:  # pragma: no cover - never break page rendering
        value = ""
    _cache["at"] = now
    _cache["value"] = value
    return value


def asset_version_context(request=None) -> dict[str, str]:
    return {"ASSET_V": asset_version()}
