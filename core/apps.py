from django.apps import AppConfig


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "core"
    verbose_name = "هسته"

    def ready(self) -> None:
        from . import checks  # noqa: F401  — registers @register() checks
