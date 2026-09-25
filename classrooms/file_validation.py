"""Server-side file upload validation.

Extensions alone are trivially spoofed, so every upload is checked three
ways: extension whitelist → declared size limit → magic-byte sniffing of
the actual content.  Office formats are ZIP containers, so their entries
are inspected too.
"""
from __future__ import annotations

import zipfile
from typing import BinaryIO

from django.core.exceptions import ValidationError
from django.utils.text import get_valid_filename

ALLOWED_EXTENSIONS = {"pdf", "png", "jpg", "jpeg", "docx", "pptx", "xlsx", "zip"}

# First bytes that identify each real format.
_MAGIC = {
    "pdf": (b"%PDF-",),
    "png": (b"\x89PNG\r\n\x1a\n",),
    "jpeg": (b"\xff\xd8\xff",),
    "zip": (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"),
}

# Extension → the magic family it must belong to.
_EXTENSION_FAMILY = {
    "pdf": "pdf",
    "png": "png",
    "jpg": "jpeg",
    "jpeg": "jpeg",
    "zip": "zip",
    "docx": "zip",
    "pptx": "zip",
    "xlsx": "zip",
}

# Marker entry that distinguishes a real OOXML document from a plain ZIP.
_OOXML_MARKER = "[Content_Types].xml"
_OOXML_WORDMARK = "word/"
_OOXML_SHEETMARK = "xl/"
_OOXML_SLIDEMARK = "ppt/"


def extension_of(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def sniff_family(head: bytes) -> str | None:
    """Identify the real format from the leading bytes."""
    for family, signatures in _MAGIC.items():
        if any(head.startswith(sig) for sig in signatures):
            return family
    return None


def validate_office_container(stream: BinaryIO, ext: str) -> None:
    """Confirm an OOXML file really is the Office type it claims to be."""
    try:
        with zipfile.ZipFile(stream) as archive:
            names = archive.namelist()
    except (zipfile.BadZipFile, OSError) as exc:
        raise ValidationError("فایل Office معتبر نیست.") from exc

    if _OOXML_MARKER not in names:
        raise ValidationError("فایل Office معتبر نیست.")

    expected = {"docx": _OOXML_WORDMARK, "xlsx": _OOXML_SHEETMARK, "pptx": _OOXML_SLIDEMARK}[ext]
    if not any(name.startswith(expected) for name in names):
        raise ValidationError(f"محتوای فایل با پسوند .{ext} همخوانی ندارد.")


def sanitize_filename(filename: str, max_length: int = 120) -> str:
    """Strip path components and unsafe characters from a client filename."""
    base = (filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = get_valid_filename(base).strip("._") or "file"
    ext = extension_of(cleaned)
    if ext and len(cleaned) > max_length:
        cleaned = f"{cleaned[: max_length - len(ext) - 1]}.{ext}"
    return cleaned[:max_length]


def validate_upload(file, max_bytes: int) -> str:
    """Validate an uploaded file in place; returns the sanitised filename.

    ``file`` is a Django ``UploadedFile``; its stream position is restored
    so the caller can still save it.
    """
    original_name = sanitize_filename(file.name)
    ext = extension_of(original_name)

    if ext not in ALLOWED_EXTENSIONS:
        raise ValidationError(
            f"پسوند .{ext or 'نامشخص'} مجاز نیست. "
            f"فرمت‌های مجاز: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    if file.size > max_bytes:
        limit_mb = max_bytes / (1024 * 1024)
        raise ValidationError(f"حجم فایل بیش از حد مجاز ({limit_mb:.0f} مگابایت) است.")
    if file.size == 0:
        raise ValidationError("فایل خالی است.")

    head = file.read(8)
    file.seek(0)
    family = sniff_family(head)
    if family is None:
        raise ValidationError("محتوای فایل قابل شناسایی نیست.")
    if family != _EXTENSION_FAMILY[ext]:
        raise ValidationError("محتوای فایل با پسوند آن همخوانی ندارد.")

    if ext in {"docx", "pptx", "xlsx"}:
        validate_office_container(file, ext)
        file.seek(0)

    file.seek(0)
    return original_name
