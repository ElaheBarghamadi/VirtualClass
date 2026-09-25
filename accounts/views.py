"""Account views: register, login, logout, profile."""
from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth import views as auth_views
from django.contrib.auth.decorators import login_required
from django.core.cache import cache
from django.shortcuts import redirect, render
from django.urls import reverse_lazy
from django.views.decorators.http import require_http_methods

from core.ratelimit import clear as rl_clear
from core.ratelimit import hit as rl_hit

from .forms import ProfileForm, RegisterForm

# Login throttling: a failed attempt is counted against BOTH the IP and
# the IP+username pair, so credential stuffing (many usernames, one IP)
# and single-account guessing are both capped.
LOGIN_MAX_IP = 20
LOGIN_MAX_IP_USER = 8
LOGIN_WINDOW = 300  # seconds

REGISTER_MAX_IP = 12
REGISTER_WINDOW = 3600


def _client_ip(request) -> str:
    return (request.META.get("REMOTE_ADDR") or "?")[:64]


def _login_keys(request) -> tuple[str, str]:
    ip = _client_ip(request)
    username = (request.POST.get("username") or "")[:150]
    return f"login:ip:{ip}", f"login:ipuser:{ip}:{username}"


class RateLimitedLoginView(auth_views.LoginView):
    """LoginView + cache-backed throttling of failed attempts.

    Blocks happen BEFORE authentication is attempted (cheap), and a
    successful login clears the counters so genuine users are never
    locked out by their own earlier typos once they get it right.
    """

    template_name = "accounts/login.html"

    def post(self, request, *args, **kwargs):
        ip_key, pair_key = _login_keys(request)
        if cache.get(f"login:blocked:{ip_key}") or cache.get(f"login:blocked:{pair_key}"):
            messages.error(request, "تلاش‌های ناموفق بیش از حد مجاز است؛ چند دقیقه بعد دوباره تلاش کنید.")
            return self.render_to_response(self.get_context_data())
        return super().post(request, *args, **kwargs)

    def form_invalid(self, form):
        ip_key, pair_key = _login_keys(self.request)
        if not rl_hit(ip_key, LOGIN_MAX_IP, LOGIN_WINDOW):
            cache.set(f"login:blocked:{ip_key}", 1, LOGIN_WINDOW)
        if not rl_hit(pair_key, LOGIN_MAX_IP_USER, LOGIN_WINDOW):
            cache.set(f"login:blocked:{pair_key}", 1, LOGIN_WINDOW)
        if cache.get(f"login:blocked:{ip_key}") or cache.get(f"login:blocked:{pair_key}"):
            messages.error(self.request, "تلاش‌های ناموفق بیش از حد مجاز است؛ چند دقیقه بعد دوباره تلاش کنید.")
        return super().form_invalid(form)

    def form_valid(self, form):
        ip_key, pair_key = _login_keys(self.request)
        rl_clear(ip_key)
        rl_clear(pair_key)
        return super().form_valid(form)


def register_view(request):
    """Create a new account and log the user in immediately (IP-throttled)."""
    if request.user.is_authenticated:
        return redirect("dashboard")

    form = RegisterForm(request.POST or None)
    if request.method == "POST":
        if not rl_hit(f"register:ip:{_client_ip(request)}", REGISTER_MAX_IP, REGISTER_WINDOW):
            messages.error(request, "ساخت حساب از این اتصال موقتاً محدود شده است.")
            return render(request, "accounts/register.html", {"form": form})
        if form.is_valid():
            user = form.save()
            login(request, user)
            messages.success(request, "حساب کاربری شما با موفقیت ساخته شد. خوش آمدید!")
            return redirect("accounts:post_login")
    return render(request, "accounts/register.html", {"form": form})


@login_required
@require_http_methods(["GET", "POST"])
def profile_view(request):
    """Display and update profile information + UI preferences."""
    if request.method == "POST":
        form = ProfileForm(request.POST, instance=request.user)
        if form.is_valid():
            form.save()
            messages.success(request, "اطلاعات پروفایل به‌روزرسانی شد.")
            return redirect("accounts:profile")
    else:
        form = ProfileForm(instance=request.user)
    return render(request, "accounts/profile.html", {"form": form})


@login_required
def post_login_redirect(request):
    """Honour the per-user landing-page preference after login."""
    target = request.user.landing_page
    return redirect("home" if target == "home" else "dashboard")
