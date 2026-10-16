"""Client asset helpers.

A browser — or a reverse proxy in front of it — can keep serving an old
``whiteboard.js`` long after a deploy has replaced the markup.  Nothing on the
server can see that, and the symptom is nasty: the room keeps working (chat,
people, video) while the whiteboard silently does nothing, because the script
that runs no longer matches the DOM it is wired to.

Rendering the build stamp *the server is serving* into the page lets the page
compare it with the stamp of the script that actually ran and tell the user to
reload, instead of leaving them with a dead board and no explanation.
"""

from __future__ import annotations

import re
from pathlib import Path

from django import template
from django.conf import settings

register = template.Library()

_BUILD_RE = re.compile(r"""export\s+const\s+BUILD\s*=\s*['"]([^'"]+)['"]""")


def _whiteboard_source() -> Path | None:
    """Locate the whiteboard bundle that is actually being served."""
    roots = []
    for entry in getattr(settings, "STATICFILES_DIRS", []) or []:
        roots.append(Path(entry))
    base = getattr(settings, "BASE_DIR", None)
    if base:
        roots.append(Path(base) / "static")
    for root in roots:
        candidate = Path(root) / "js" / "whiteboard.js"
        if candidate.exists():
            return candidate
    return None


@register.simple_tag
def client_build() -> str:
    """Build stamp baked into the whiteboard bundle ("" when unknown)."""
    source = _whiteboard_source()
    if source is None:
        return ""
    try:
        match = _BUILD_RE.search(source.read_text(encoding="utf-8"))
    except OSError:  # pragma: no cover - unreadable file
        return ""
    return match.group(1) if match else ""
