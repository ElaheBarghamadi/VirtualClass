"""Root URL configuration."""
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    # HTML frontend (Django Templates)
    path("", include("core.urls")),
    path("accounts/", include("accounts.urls")),
    path("dashboard/", include("classrooms.urls")),
    path("classrooms/", include(("classrooms.urls_manage", "classrooms_manage"), namespace="classrooms")),
    path("class/", include(("classrooms.urls_room", "classrooms_room"), namespace="room")),
    # JSON API
    path("api/", include("core.api_urls")),
]

admin.site.site_title = "مدیریت کلاس آنلاین"
admin.site.site_header = "پنل مدیریت کلاس آنلاین"
admin.site.index_title = "مدیریت سامانه"

# Development-only media serving (production: web server / object storage).
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
