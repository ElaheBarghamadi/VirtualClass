"""Office → PDF conversion via LibreOffice (optional dependency).

Teachers mostly carry PPTX/DOCX.  When ``soffice`` is installed on the
server, uploads of those formats are converted once, at upload time, and
the PDF copy powers the in-browser presentation (pdf.js).  When it is
not installed everything still works — Office files simply stay
download-only, exactly as before.

Deliberately synchronous and bounded: conversion runs during the upload
request (the progress bar covers it) with a hard timeout, and any
failure is logged, never raised — an unconvertible file must not break
the upload.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile

from django.conf import settings
from django.core.files import File

logger = logging.getLogger("classrooms.office")

CONVERTIBLE_EXTENSIONS = {"docx", "pptx", "xlsx"}
_CONVERT_TIMEOUT = int(os.environ.get("OFFICE_CONVERT_TIMEOUT", "90"))  # seconds


def soffice_path() -> str | None:
    """Locate the LibreOffice binary (env override → PATH → common spots)."""
    explicit = os.environ.get("LIBREOFFICE_PATH", "")
    if explicit and os.path.isfile(explicit):
        return explicit
    found = shutil.which("soffice") or shutil.which("libreoffice")
    if found:
        return found
    for candidate in (
        "/usr/bin/soffice",
        "/usr/lib/libreoffice/program/soffice",
        "/opt/libreoffice/program/soffice",
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ):
        if os.path.isfile(candidate):
            return candidate
    return None


def conversion_available() -> bool:
    return soffice_path() is not None


def convert_to_pdf(shared_file) -> bool:
    """Convert an uploaded Office file to PDF and attach it as pdf_version.

    Returns True on success.  Safe to call for any file — non-Office
    extensions are a no-op.
    """
    ext = shared_file.original_name.rsplit(".", 1)[-1].lower() if "." in shared_file.original_name else ""
    if ext not in CONVERTIBLE_EXTENSIONS:
        return False
    soffice = soffice_path()
    if soffice is None:
        logger.info("office_convert_skipped_no_libreoffice")
        return False

    with tempfile.TemporaryDirectory(prefix="officeconv-") as tmp:
        # materialise the uploaded bytes on disk for soffice
        src = os.path.join(tmp, f"source.{ext}")
        with open(src, "wb") as fh:
            for chunk in shared_file.file.chunks():
                fh.write(chunk)
        outdir = os.path.join(tmp, "out")
        os.makedirs(outdir, exist_ok=True)
        try:
            proc = subprocess.run(
                [soffice, "--headless", "--norestore", "--convert-to", "pdf",
                 "--outdir", outdir, src],
                capture_output=True, timeout=_CONVERT_TIMEOUT,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            logger.warning("office_convert_failed", extra={"reason": str(exc)})
            return False
        pdf_path = os.path.join(outdir, f"source.pdf")
        if proc.returncode != 0 or not os.path.isfile(pdf_path):
            logger.warning("office_convert_failed",
                           extra={"rc": proc.returncode, "err": proc.stderr[:300]})
            return False
        with open(pdf_path, "rb") as fh:
            # keep a recognisable name alongside the original
            pdf_name = shared_file.original_name.rsplit(".", 1)[0] + ".pdf"
            shared_file.pdf_version.save(pdf_name, File(fh), save=True)
    logger.info("office_converted", extra={"file_id": shared_file.id})
    return True
