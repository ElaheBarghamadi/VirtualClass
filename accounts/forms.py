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

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        # Keyboard, password managers and iOS autofill all key off these: a
        # signup form without them is the reason "suggest a strong password"
        # never appears.  Nothing here changes validation.
        self.fields["username"].widget.attrs.update({
            "autocomplete": "username",
            "autocapitalize": "none",
            "spellcheck": "false",
            "autofocus": True,
        })
        self.fields["email"].widget.attrs.update({
            "autocomplete": "email",
            "inputmode": "email",
        })
        self.fields["first_name"].widget.attrs["autocomplete"] = "given-name"
        self.fields["last_name"].widget.attrs["autocomplete"] = "family-name"
        for name in ("password1", "password2"):
            self.fields[name].widget.attrs["autocomplete"] = "new-password"


class LoginForm(AuthenticationForm):
    """Thin subclass so we can restyle fields later without touching views."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.fields["username"].label = "نام کاربری"
        self.fields["password"].label = "رمز عبور"
        self.fields["username"].widget.attrs.update({
            "autocomplete": "username",
            "autocapitalize": "none",
            "spellcheck": "false",
            "autofocus": True,
        })
        self.fields["password"].widget.attrs["autocomplete"] = "current-password"


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
