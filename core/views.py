"""Public views."""
from django.shortcuts import render


def home_view(request):
    """Landing page. Authenticated users land on their dashboard."""
    return render(request, "home.html")
