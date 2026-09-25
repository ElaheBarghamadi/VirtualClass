"""Account views: register, login, logout, profile."""
from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render
from django.urls import reverse_lazy
from django.views.decorators.http import require_http_methods

from .forms import ProfileForm, RegisterForm


def register_view(request):
    """Create a new account and log the user in immediately."""
    if request.user.is_authenticated:
        return redirect("dashboard")

    form = RegisterForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        user = form.save()
        login(request, user)
        messages.success(request, "حساب کاربری شما با موفقیت ساخته شد. خوش آمدید!")
        return redirect("dashboard")
    return render(request, "accounts/register.html", {"form": form})


@require_http_methods(["GET"])
def profile_view(request):
    """Display and update basic profile information."""
    if request.method == "POST":
        form = ProfileForm(request.POST, instance=request.user)
        if form.is_valid():
            form.save()
            messages.success(request, "اطلاعات پروفایل به‌روزرسانی شد.")
            return redirect("accounts:profile")
    else:
        form = ProfileForm(instance=request.user)
    return render(request, "accounts/profile.html", {"form": form})
