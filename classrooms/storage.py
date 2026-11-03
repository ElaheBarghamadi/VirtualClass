"""Local storage for files that must never be exposed by a web server."""
from django.conf import settings
from django.core.files.storage import FileSystemStorage
from django.utils.functional import cached_property


class PrivateFileStorage(FileSystemStorage):
    @cached_property
    def base_location(self):
        return str(settings.PRIVATE_MEDIA_ROOT)

    def _clear_cached_properties(self, setting, **kwargs):
        super()._clear_cached_properties(setting, **kwargs)
        if setting == "PRIVATE_MEDIA_ROOT":
            self.__dict__.pop("base_location", None)
            self.__dict__.pop("location", None)

    def url(self, name):
        raise ValueError("Private files do not have public URLs.")


private_storage = PrivateFileStorage()


#: Only these types may be served *inline* (viewed inside the app).  Everything
#: else stays an attachment, so a shared .html/.svg/.xml file can never execute
#: script in the classroom origin.
INLINE_TYPES = {
    "pdf": "application/pdf",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
}


def private_file_response(field, filename, inline: bool = False):
    """Serve private content only after the caller has authorized the request.

    ``inline=True`` is used by the in-room presentation renderer: the browser
    must *draw* the bytes, not save them.  Anything outside :data:`INLINE_TYPES`
    is still sent as an attachment (a download), which is also what the explicit
    download buttons ask for.
    """
    from django.http import FileResponse, Http404

    if not field:
        raise Http404

    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    content_type = INLINE_TYPES.get(ext)
    if inline and content_type:
        try:
            response = FileResponse(field.open("rb"), as_attachment=False,
                                    filename=filename, content_type=content_type)
        except FileNotFoundError:
            raise Http404 from None
        # Defence in depth: even if a browser sniffs, the document is inert.
        response["Content-Security-Policy"] = "default-src 'none'; sandbox"
    else:
        try:
            response = FileResponse(field.open("rb"), as_attachment=True, filename=filename)
        except FileNotFoundError:
            raise Http404 from None

    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response
