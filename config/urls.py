"""Root URL configuration."""
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
