"""Authentication and profile forms (Django auth-based, intentionally simple)."""
from django import forms
from django.contrib.auth.forms import AuthenticationForm, UserCreationForm

from .models import User


class RegisterForm(UserCreationForm):
    """Registration form built on Django's ``UserCreationForm``."""

    email = forms.EmailField(required=True, label="ایمیل")
    first_name = forms.CharField(max_length=150, required=False, label="نام")
    last_name = forms.CharField(max_length=150, required=False, label="نام خانوادگی")

    class Meta(UserCreationForm.Meta):
        model = User
        fields = ("username", "first_name", "last_name", "email")


class LoginForm(AuthenticationForm):
    """Thin subclass so we can restyle fields later without touching views."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.fields["username"].label = "نام کاربری"
        self.fields["password"].label = "رمز عبور"


class ProfileForm(forms.ModelForm):
    """Edit basic profile information + UI preferences."""

    class Meta:
        model = User
        fields = (
            "first_name",
            "last_name",
            "email",
            "display_name",
            "theme",
            "density",
            "reduce_animations",
            "landing_page",
        )
        labels = {
            "first_name": "نام",
            "last_name": "نام خانوادگی",
            "email": "ایمیل",
            "display_name": "نام نمایشی",
            "theme": "پوسته",
            "density": "تراکم رابط کاربری",
            "reduce_animations": "کاهش انیمیشن‌ها",
            "landing_page": "صفحهٔ فرود پس از ورود",
        }
