"""Template context: UI preferences available on every page.

Registered users get their saved preferences; guests/anonymous visitors
fall back to cookie/system defaults (client-side ``theme.js`` refines).
"""
from django.conf import settings

DEFAULTS = {
    "theme": "system",
    "density": "comfortable",
    "reduce_animations": False,
    "landing_page": "dashboard",
}


def ui_preferences(request):
    user = getattr(request, "user", None)
    if user is not None and getattr(user, "is_authenticated", False):
        prefs = {
            "theme": user.theme,
            "density": user.density,
            "reduce_animations": user.reduce_animations,
            "landing_page": user.landing_page,
        }
    else:
        cookie_theme = request.COOKIES.get("ui_theme", "")
        prefs = {
            "theme": cookie_theme if cookie_theme in ("system", "light", "dark") else DEFAULTS["theme"],
            "density": DEFAULTS["density"],
            "reduce_animations": request.COOKIES.get("ui_motion", "full") == "reduced",
            "landing_page": DEFAULTS["landing_page"],
        }
    return {"ui": {**DEFAULTS, **prefs, "app_name": getattr(settings, "APP_NAME", "کلاس آنلاین")}}
