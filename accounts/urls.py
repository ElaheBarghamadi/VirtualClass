"""Account URL patterns (mounted under /accounts/)."""
from django.contrib.auth import views as auth_views
from django.urls import path, reverse_lazy

from . import views

app_name = "accounts"

urlpatterns = [
    path(
        "login/",
        views.RateLimitedLoginView.as_view(),
        name="login",
    ),
    path("logout/", auth_views.LogoutView.as_view(), name="logout"),
    # Password reset — Django's hardened flow (token single-use, no user
    # enumeration), dressed in our Persian templates.  Emails go to the
    # console in development and SMTP in production (settings).
    path("password-reset/",
         auth_views.PasswordResetView.as_view(
             template_name="accounts/password_reset_form.html",
             email_template_name="accounts/password_reset_email.html",
             subject_template_name="accounts/password_reset_subject.txt",
             success_url=reverse_lazy("accounts:password_reset_done"),
         ),
         name="password_reset"),
    path("password-reset/done/",
         auth_views.PasswordResetDoneView.as_view(
             template_name="accounts/password_reset_done.html"),
         name="password_reset_done"),
    path("reset/<uidb64>/<token>/",
         auth_views.PasswordResetConfirmView.as_view(
             template_name="accounts/password_reset_confirm.html",
             success_url=reverse_lazy("accounts:password_reset_complete"),
         ),
         name="password_reset_confirm"),
    path("reset/done/",
         auth_views.PasswordResetCompleteView.as_view(
             template_name="accounts/password_reset_complete.html"),
         name="password_reset_complete"),
    path("register/", views.register_view, name="register"),
    path("profile/", views.profile_view, name="profile"),
    path("after-login/", views.post_login_redirect, name="post_login"),
]
