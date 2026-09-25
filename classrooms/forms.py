"""Forms for classroom creation, joining, scheduling and settings."""
from django import forms

from .models import Classroom, ClassroomSession
from .services import SETTING_FIELDS


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
            self.add_error("password", "محافظت با رمز فعال است؛ لطفاً رمز کلاس را وارد کنید.")
        if not protected:
            cleaned["password"] = None
        return cleaned


class ClassroomJoinForm(forms.Form):
    """Password prompt shown in the lobby for protected classrooms."""

    password = forms.CharField(
        widget=forms.PasswordInput(attrs={"autocomplete": "current-password", "autofocus": True}),
        label="رمز کلاس",
    )


class SessionScheduleForm(forms.ModelForm):
    """Schedule an upcoming session for a classroom."""

    class Meta:
        model = ClassroomSession
        fields = ("title", "scheduled_start", "scheduled_end")
        labels = {
            "title": "عنوان جلسه",
            "scheduled_start": "شروع",
            "scheduled_end": "پایان",
        }
        widgets = {
            "scheduled_start": forms.DateTimeInput(attrs={"type": "datetime-local"}),
            "scheduled_end": forms.DateTimeInput(attrs={"type": "datetime-local"}),
        }

    def clean(self) -> dict:
        cleaned = super().clean()
        start, end = cleaned.get("scheduled_start"), cleaned.get("scheduled_end")
        if start and end and end <= start:
            self.add_error("scheduled_end", "زمان پایان باید بعد از شروع باشد.")
        return cleaned


SETTING_LABELS = {
    "enable_waiting_room": "اتاق انتظار (تأیید ورود توسط میزبان)",
    "allow_student_chat": "دانش‌آموزان بتوانند پیام بفرستند",
    "allow_student_mic": "دانش‌آموزان بتوانند میکروفون روشن کنند",
    "allow_student_camera": "دانش‌آموزان بتوانند دوربین روشن کنند",
    "allow_student_screen_share": "دانش‌آموزان بتوانند صفحه به اشتراک بگذارند",
    "allow_student_whiteboard": "دانش‌آموزان بتوانند از تخته استفاده کنند",
    "allow_file_upload": "غیرمالک بتواند فایل بارگذاری کند",
    "chat_disabled": "گفتگو برای همه قطع شود",
}


class ClassroomSettingsForm(forms.ModelForm):
    """Owner settings panel (persisted on the Classroom row)."""

    class Meta:
        model = Classroom
        fields = list(SETTING_FIELDS)
        labels = SETTING_LABELS
