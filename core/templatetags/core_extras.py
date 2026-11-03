"""Template filters used across the project."""
from django import template
from django.utils import timezone
from django.utils.timesince import timesince

register = template.Library()

# Persian digits must not depend on the webfont's `locl` feature: without it a
# page mixed ۱۴۰۴ with 2026 whenever the font had not loaded yet. Templates
# pass display numbers through `fa_digits`; identifiers (room codes, e-mails,
# file names) are never passed through it.
_DIGITS = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")


def to_fa_digits(value) -> str:
    """«1404» → «۱۴۰۴» (shared with Python-side help texts)."""
    if value is None:
        return ""
    return str(value).translate(_DIGITS)


@register.filter(name="fa_digits")
def fa_digits(value) -> str:
    return to_fa_digits(value)


@register.filter(name="fa_num")
def fa_num(value) -> str:
    """Thousands grouped with the Persian separator, then converted."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return to_fa_digits(value)
    return to_fa_digits(f"{number:,}".replace(",", "٬"))


@register.filter
def fa_timesince(value) -> str:
    """Human-friendly Persian-ish relative time (e.g. «۲ ساعت، ۵ دقیقه»)."""
    if value is None:
        return ""
    return timesince(value)

# --- Jalali dates ----------------------------------------------------------
# A Persian classroom that prints 2026/11/03 forces every teacher to convert in
# their head. `|jalali:"Y/m/d H:i"` prints the same instant on the Iranian
# calendar with Persian digits; the Gregorian value stays in the DB and in the
# machine-readable <time datetime> attributes.

def _to_jalali(gy: int, gm: int, gd: int):
    """Gregorian -> Jalali (jalaali/Jalaali algorithm, no dependency)."""
    days_in_month = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
    gy2 = gy + 1 if gm > 2 else gy
    days = (
        355666
        + (365 * gy)
        + ((gy2 + 3) // 4)
        - ((gy2 + 99) // 100)
        + ((gy2 + 399) // 400)
        + gd
        + days_in_month[gm - 1]
    )
    jy = -1595 + (33 * (days // 12053))
    days %= 12053
    jy += 4 * (days // 1461)
    days %= 1461
    if days > 365:
        jy += (days - 1) // 365
        days = (days - 1) % 365
    if days < 186:
        jm, jd = 1 + (days // 31), 1 + (days % 31)
    else:
        jm, jd = 7 + ((days - 186) // 30), 1 + ((days - 186) % 30)
    return jy, jm, jd


@register.filter(name="jalali")
def jalali(value, fmt: str = "Y/m/d"):
    """Format a datetime on the Jalali calendar, in Persian digits."""
    if not value:
        return ""
    if isinstance(value, str):
        # already formatted (e.g. a `default:` chain hands over a rendered
        # string) — never try to read .year off it
        return to_fa_digits(value)
    moment = value
    if hasattr(moment, "tzinfo") and timezone.is_aware(moment):
        try:
            moment = timezone.localtime(moment)
        except (ValueError, OverflowError):
            pass
    jy, jm, jd = _to_jalali(moment.year, moment.month, moment.day)
    out = (
        fmt.replace("Y", str(jy))
        .replace("m", f"{jm:02d}")
        .replace("d", f"{jd:02d}")
        .replace("H", f"{moment.hour:02d}")
        .replace("i", f"{moment.minute:02d}")
    )
    return to_fa_digits(out)
