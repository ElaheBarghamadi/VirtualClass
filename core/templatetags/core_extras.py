"""Template filters used across the project."""
from django import template
from django.utils.timesince import timesince

register = template.Library()


@register.filter
def fa_timesince(value) -> str:
    """Human-friendly Persian-ish relative time (e.g. «۲ ساعت، ۵ دقیقه»)."""
    if value is None:
        return ""
    return timesince(value)
