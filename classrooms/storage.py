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


def private_file_response(field, filename):
    """Serve private content only after the caller has authorized the request."""
    from django.http import FileResponse, Http404

    if not field:
        raise Http404
    try:
        response = FileResponse(field.open("rb"), as_attachment=True, filename=filename)
    except FileNotFoundError:
        raise Http404 from None
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response
