# Online Classroom — production image (Django + Daphne ASGI)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System deps: only what's needed for psycopg (PostgreSQL) builds.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpq5 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt "psycopg[binary]>=3.1,<4"

COPY . .

RUN python manage.py collectstatic --noinput || true

# Run as a non-root user.
RUN useradd --create-home appuser \
    && mkdir -p /app/media /app/staticfiles \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

# Collect static files and start the ASGI server (HTTP + WebSockets).
CMD ["sh", "-c", "python manage.py migrate --noinput && daphne -b 0.0.0.0 -p 8000 config.asgi:application"]
