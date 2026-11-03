"""Forms for classroom creation, joining, scheduling and settings."""
import re

from django import forms
from django.core.exceptions import ValidationError

from core.templatetags.core_extras import to_fa_digits

from .models import Classroom, ClassroomSession
from .services import (
    GUEST_NAME_MAX,
    GUEST_NAME_MIN,
    SETTING_FIELDS,
    validate_display_name,
)


DEFAULT_ACCENT = "#6366f1"


class ClassroomForm(forms.ModelForm):
    """Classroom creation form.

    A host picks everything up front — access rules, capacity and which
    student capabilities start enabled — instead of opening the class and
    hunting for the switches afterwards.  Only whitelisted fields reach
    :func:`classrooms.services.create_classroom`.
    """

    password = forms.CharField(
        required=False,
        min_length=4,
        widget=forms.PasswordInput(attrs={"autocomplete": "new-password"}),
        label="رمز کلاس",
        help_text="حداقل ۴ نویسه؛ فقط افرادی که این رمز را می‌دانند وارد می‌شوند.",
    )
    max_participants = forms.IntegerField(
        required=False,
        min_value=0,
        max_value=500,
        initial=0,
        label="حداکثر شرکت‌کننده",
        help_text="۰ یعنی بدون محدودیت. میزبان هم جزو این تعداد است.",
        widget=forms.NumberInput(attrs={"min": 0, "max": 500, "inputmode": "numeric"}),
    )

    class Meta:
        model = Classroom
        fields = (
            "title",
            "description",
            "is_password_protected",
            "password",
            "allow_guests",
            "enable_waiting_room",
            "max_participants",
            "allow_student_chat",
            "allow_student_mic",
            "allow_student_camera",
            "allow_student_screen_share",
            "allow_student_whiteboard",
            "allow_file_upload",
            "show_chat_default",
            "accent_color",
            "welcome_message",
        )
        labels = {
            "title": "عنوان کلاس",
            "description": "توضیحات",
            "is_password_protected": "محافظت با رمز عبور",
            "allow_guests": "ورود مهمان با لینک (بدون حساب)",
            "enable_waiting_room": "تأیید ورود توسط میزبان (اتاق انتظار)",
            "allow_student_chat": "گفتگوی متنی",
            "allow_student_mic": "میکروفون",
            "allow_student_camera": "دوربین",
            "allow_student_screen_share": "اشتراک صفحه",
            "allow_student_whiteboard": "تختهٔ سفید",
            "allow_file_upload": "بارگذاری فایل",
            "show_chat_default": "پنل گفتگو در شروع باز باشد",
            "accent_color": "رنگ کلاس",
            "welcome_message": "پیام خوش‌آمد",
        }
        help_texts = {
            "description": "یک خط توضیح که در لیست کلاس‌ها و صفحهٔ ورود دیده می‌شود.",
            "enable_waiting_room": "هر تازه‌وارد تا تأیید شما بیرون از کلاس می‌ماند.",
            "welcome_message": "وقتی دانش‌آموز وارد اتاق می‌شود نمایش داده می‌شود (حداکثر ۲۰۰ نویسه).",
        }
        widgets = {
            "title": forms.TextInput(attrs={"placeholder": "مثلاً ریاضی ۲ — فصل سوم", "autofocus": True}),
            "description": forms.Textarea(attrs={"rows": 2, "placeholder": "این کلاس برای چه کسانی است؟"}),
            "welcome_message": forms.Textarea(attrs={"rows": 2, "maxlength": 200}),
            "accent_color": forms.TextInput(attrs={"type": "color"}),
        }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # A blank <input type="color"> paints black, so a brand-new class
        # starts from the product accent instead of a black swatch.
        if not self.initial.get("accent_color"):
            self.initial["accent_color"] = DEFAULT_ACCENT
        if self.initial.get("max_participants") in (None, ""):
            self.initial["max_participants"] = 0

    def clean_max_participants(self) -> int:
        value = self.cleaned_data.get("max_participants")
        return int(value or 0)

    def clean_accent_color(self) -> str:
        value = (self.cleaned_data.get("accent_color") or "").strip().lower()
        if value and not re.fullmatch(r"#[0-9a-f]{6}", value):
            raise forms.ValidationError("رنگ باید هگز شش‌رقمی باشد (مانند #4f46e5).")
        return value

    def clean(self) -> dict:
        cleaned = super().clean()
        protected = cleaned.get("is_password_protected")
        password = cleaned.get("password")
        if protected and not password:
            self.add_error("password", "محافظت با رمز فعال است؛ لطفاً رمز کلاس را وارد کنید.")
        if not protected:
            cleaned["password"] = None
        return cleaned

    def settings_dict(self) -> dict:
        """Only the fields :func:`create_classroom` is allowed to persist."""
        return {
            "allow_guests": self.cleaned_data.get("allow_guests", True),
            "enable_waiting_room": self.cleaned_data.get("enable_waiting_room", False),
            "max_participants": self.cleaned_data.get("max_participants", 0),
            "allow_student_chat": self.cleaned_data.get("allow_student_chat", True),
            "allow_student_mic": self.cleaned_data.get("allow_student_mic", True),
            "allow_student_camera": self.cleaned_data.get("allow_student_camera", True),
            "allow_student_screen_share": self.cleaned_data.get("allow_student_screen_share", False),
            "allow_student_whiteboard": self.cleaned_data.get("allow_student_whiteboard", False),
            "allow_file_upload": self.cleaned_data.get("allow_file_upload", True),
            "show_chat_default": self.cleaned_data.get("show_chat_default", True),
            "accent_color": self.cleaned_data.get("accent_color", "") or "",
            "welcome_message": self.cleaned_data.get("welcome_message", "") or "",
        }


class ClassroomJoinForm(forms.Form):
    """Password prompt shown in the lobby for protected classrooms."""

    password = forms.CharField(
        widget=forms.PasswordInput(attrs={"autocomplete": "current-password", "autofocus": True}),
        label="رمز کلاس",
    )


class GuestJoinForm(forms.Form):
    """Lobby form for guests — display name (+ password when protected)."""

    display_name = forms.CharField(
        max_length=GUEST_NAME_MAX,
        label="نام نمایشی",
        widget=forms.TextInput(attrs={"autofocus": True, "autocomplete": "nickname", "maxlength": GUEST_NAME_MAX}),
        help_text=(
                f"بین {to_fa_digits(GUEST_NAME_MIN)} تا {to_fa_digits(GUEST_NAME_MAX)} نویسه — "
                "همین نام در کلاس نمایش داده می‌شود."
            ),
    )
    password = forms.CharField(
        required=False,
        widget=forms.PasswordInput(attrs={"autocomplete": "current-password"}),
        label="رمز کلاس",
    )

    def __init__(self, *args, requires_password: bool = False, **kwargs):
        super().__init__(*args, **kwargs)
        self.requires_password = requires_password
        if not requires_password:
            del self.fields["password"]

    def clean_display_name(self) -> str:
        try:
            return validate_display_name(self.cleaned_data["display_name"])
        except ValidationError as exc:
            raise forms.ValidationError(exc.messages or str(exc)) from exc

    def clean_password(self) -> str:
        value = self.cleaned_data.get("password", "")
        if self.requires_password and not value:
            raise forms.ValidationError("ورود به این کلاس نیازمند رمز است.")
        return value


class ClassroomCustomizationForm(forms.ModelForm):
    """Owner-only appearance & access customization (phase 3)."""

    class Meta:
        model = Classroom
        fields = (
            "title",
            "description",
            "logo",
            "accent_color",
            "welcome_message",
            "allow_guests",
            "show_chat_default",
        )
        labels = {
            "title": "عنوان کلاس",
            "description": "توضیحات",
            "logo": "لوگو",
            "accent_color": "رنگ اصلی کلاس",
            "welcome_message": "پیام خوش‌آمدگویی",
            "allow_guests": "اجازهٔ ورود مهمان با لینک (بدون حساب کاربری)",
            "show_chat_default": "نمایش گفتگو به‌صورت پیش‌فرض",
        }
        widgets = {
            "description": forms.Textarea(attrs={"rows": 3}),
            "welcome_message": forms.Textarea(attrs={"rows": 2, "maxlength": 200}),
            "accent_color": forms.TextInput(attrs={"type": "color"}),
        }

    def clean_accent_color(self) -> str:
        value = (self.cleaned_data.get("accent_color") or "").strip().lower()
        if not re.fullmatch(r"#[0-9a-f]{6}", value):
            raise forms.ValidationError("رنگ باید هگز شش‌رقمی باشد (مانند #4f46e5).")
        return value


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
