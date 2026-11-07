# Deploy-only image for container platforms (Weblines Cloud, Fly, Render, k8s…).
#
# The project itself needs no Docker: `python scripts/dev.py` and
# `manage.py runserver` run on the host.  This file exists because container
# platforms *require* an image (Weblines' auto-build only understands
# Node.js), and it is the one place where "build the static files, run Daphne
# on the platform's port" is expressed.
#
#   Weblines → Build settings: Dockerfile → deploy/weblines/Dockerfile
#              Port: 8000
#
# Three services share this image (see entrypoint.sh):
#   app     ROLE=web      (has the public address)
#   worker  ROLE=worker   (celery worker)
#   beat    ROLE=beat     (celery beat, one instance)
#
# Build arg INSTALL_LIBREOFFICE=1 adds LibreOffice for Office → PDF
# presentation (~700 MB more; everything else works without it).

FROM python:3.12-slim

ARG INSTALL_LIBREOFFICE=0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8000

WORKDIR /app

# curl is used by the platform health checks and by the troubleshooting steps
# in deploy/DEPLOY.md.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN if [ "$INSTALL_LIBREOFFICE" = "1" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends \
            libreoffice-impress libreoffice-writer \
            fonts-dejavu-core fonts-liberation \
        && rm -rf /var/lib/apt/lists/*; \
    fi

# Dependencies first: this layer is cached across code changes.
COPY requirements.txt ./
# psycopg is optional in requirements.txt (SQLite is the development default);
# a deployed platform almost always gives you PostgreSQL, so install it here.
RUN pip install -r requirements.txt "psycopg[binary]>=3.1,<4"

COPY . .

# Static files are collected at BUILD time: on a container platform the image is
# the artifact, and files written at runtime disappear with the next deploy.
# They are then served by WhiteNoise from STATIC_ROOT, no nginx needed.
RUN python manage.py collectstatic --noinput --clear

COPY deploy/weblines/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

EXPOSE 8000

# The platform's port field must match PORT/EXPOSE (8000 here).
CMD ["/usr/local/bin/entrypoint"]
