"""Public page URLs (mounted at /)."""
from django.urls import path

from . import views

urlpatterns = [
    path("", views.home_view, name="home"),
    # Probe for the host's health check / uptime monitor (no auth, no session).
    # `/healthz?db=1` also verifies the database connection.
    path("healthz", views.health_view, name="healthz"),
]
