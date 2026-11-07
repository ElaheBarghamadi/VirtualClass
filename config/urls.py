"""Root URL configuration."""
from django.conf import settings
from django.contrib import admin
from django.urls import include, path, re_path

from core.views import public_media

urlpatterns = [
    path("admin/", admin.site.urls),
    # HTML frontend (Django Templates)
    path("", include("core.urls")),
    path("accounts/", include("accounts.urls")),
    path("dashboard/", include("classrooms.urls")),
    path("classrooms/", include(("classrooms.urls_manage", "classrooms_manage"), namespace="classrooms")),
    path("classrooms/", include(("quizzes.urls_manage", "quizzes_manage"), namespace="quizzes_manage")),
    path("classrooms/", include(("assignments.urls_manage", "assignments_manage"), namespace="assignments_manage")),
    path("class/", include(("classrooms.urls_room", "classrooms_room"), namespace="room")),
    path("class/", include(("quizzes.urls_room", "quizzes_room"), namespace="quizzes")),
    # JSON API
    path("api/", include("core.api_urls")),
]

admin.site.site_title = "مدیریت کلاس آنلاین"
admin.site.site_header = "پنل مدیریت کلاس آنلاین"
admin.site.index_title = "مدیریت سامانه"

# Public media (classroom logos) — served by the app in every environment, so
# a deployment without nginx still shows them. Only the public subtree is
# reachable: see core/views.py::public_media.
urlpatterns += [
    re_path(
        rf"^{settings.MEDIA_URL.strip('/')}/(?P<path>.+)$",
        public_media,
        name="public_media",
    ),
]
