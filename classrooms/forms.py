"""Forms for classroom creation and joining."""
from django import forms

from .models import Classroom


class ClassroomForm(forms.ModelForm):
    """Classroom creation form with optional password protection."""

    password = forms.CharField(
        required=False,
        min_length=4,
        widget=forms.PasswordInput(attrs={"autocomplete": "new-password"}),
        label="رمز کلاس",
        help_text="در صورت فعال بودن محافظت با رمز، حداقل ۴ نویسه وارد کنید.",
    )

    class Meta:
        model = Classroom
        fields = ("title", "description", "is_password_protected")
        labels = {
            "title": "عنوان کلاس",
            "description": "توضیحات",
            "is_password_protected": "محافظت با رمز عبور",
        }
        widgets = {
            "description": forms.Textarea(attrs={"rows": 3}),
        }

    def clean(self) -> dict:
        cleaned = super().clean()
        protected = cleaned.get("is_password_protected")
        password = cleaned.get("password")
        if protected and not password:
            self.add_error(
                "password", "محافظت با رمز فعال است؛ لطفاً رمز کلاس را وارد کنید."
            )
        if not protected:
            cleaned["password"] = None
        return cleaned


class ClassroomJoinForm(forms.Form):
    """Password prompt shown in the lobby for protected classrooms."""

    password = forms.CharField(
        widget=forms.PasswordInput(attrs={"autocomplete": "current-password", "autofocus": True}),
        label="رمز کلاس",
    )
