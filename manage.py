#!/usr/bin/env python
"""Django's command-line utility for administrative tasks."""
import os
import sys

from dotenv import load_dotenv


def main() -> None:
    """Run administrative tasks."""
    # `manage.py test` runs without Redis: no broker, no worker and no channel
    # layer server (see config/settings_test.py).  An explicit
    # DJANGO_SETTINGS_MODULE in the environment still wins over both defaults.
    testing = len(sys.argv) > 1 and sys.argv[1] in {"test", "testserver"}
    os.environ.setdefault(
        "DJANGO_SETTINGS_MODULE",
        "config.settings_test" if testing else "config.settings",
    )
    # Load .env (if present) before settings are evaluated.
    load_dotenv()
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Couldn't import Django. Are you sure it's installed and "
            "available on your PYTHONPATH environment variable? Did you "
            "forget to activate a virtual environment?"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
