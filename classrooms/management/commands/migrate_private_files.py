"""Copy referenced legacy files into private storage without deleting originals."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from assignments.models import Submission
from classrooms.models import SharedFile


def _digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def _safe_path(root, name):
    relative = PurePosixPath(name)
    if relative.is_absolute() or '..' in relative.parts or not relative.parts or relative.parts[0] != 'classrooms':
        raise ValueError('invalid storage name')
    path = root.joinpath(*relative.parts)
    # Never follow an existing symlink, including within a parent directory.
    parent = root
    for part in relative.parts:
        parent = parent / part
        if parent.is_symlink():
            raise ValueError('symlink in storage path')
    if not path.resolve().is_relative_to(root):
        raise ValueError('path escapes storage root')
    return path


class Command(BaseCommand):
    help = 'Verify or safely copy DB-referenced legacy private files. Dry-run is the default.'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true', help='Copy missing files; never overwrite or delete.')

    def handle(self, *args, **options):
        source_root = Path(settings.MEDIA_ROOT).resolve()
        destination_root = Path(settings.PRIVATE_MEDIA_ROOT).resolve()
        if (source_root == destination_root or source_root in destination_root.parents
                or destination_root in source_root.parents):
            raise CommandError('Public and private storage roots must be disjoint.')
        counts = {'checked': 0, 'already_verified': 0, 'would_copy': 0,
                  'copied': 0, 'missing': 0, 'conflicts': 0, 'errors': 0}
        references = []
        for pk, name, pdf in SharedFile.objects.values_list('pk', 'file', 'pdf_version').iterator():
            references.extend((('shared', pk, 'file', name), ('shared', pk, 'pdf_version', pdf)))
        for pk, name in Submission.objects.values_list('pk', 'file').iterator():
            references.append(('submission', pk, 'file', name))
        for kind, pk, field, name in references:
            if not name:
                continue
            counts['checked'] += 1
            try:
                src = _safe_path(source_root, name)
                dst = _safe_path(destination_root, name)
                if not src.is_file():
                    counts['missing'] += 1
                    self.stderr.write(f'{kind}:{pk}:{field}: source missing')
                    continue
                if dst.exists():
                    if not dst.is_file() or _digest(src) != _digest(dst):
                        counts['conflicts'] += 1
                        self.stderr.write(f'{kind}:{pk}:{field}: destination conflict')
                    else:
                        counts['already_verified'] += 1
                    continue
                if not options['apply']:
                    counts['would_copy'] += 1
                    continue
                dst.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                # Re-check after mkdir. Run under maintenance to avoid filesystem races.
                dst = _safe_path(destination_root, name)
                temp_name = None
                try:
                    with src.open('rb') as reader, tempfile.NamedTemporaryFile(
                        mode='wb', prefix='.nextclass-copy-', dir=dst.parent, delete=False,
                    ) as writer:
                        temp_name = writer.name
                        for block in iter(lambda: reader.read(1024 * 1024), b''):
                            writer.write(block)
                        writer.flush()
                        os.fsync(writer.fileno())
                    if _digest(src) != _digest(Path(temp_name)):
                        raise OSError('source changed while copying')
                    # Atomic create, no overwrite even when another process wins the race.
                    os.link(temp_name, dst)
                    if _digest(src) != _digest(dst):
                        raise OSError('verification failed')
                    counts['copied'] += 1
                finally:
                    if temp_name and os.path.exists(temp_name):
                        os.unlink(temp_name)
            except FileExistsError:
                counts['conflicts'] += 1
                self.stderr.write(f'{kind}:{pk}:{field}: destination appeared during copy')
            except (OSError, ValueError):
                counts['errors'] += 1
                self.stderr.write(f'{kind}:{pk}:{field}: copy or validation failed')
        self.stdout.write(json.dumps({'mode': 'apply' if options['apply'] else 'dry-run', **counts}))
        if counts['missing'] or counts['conflicts'] or counts['errors']:
            raise CommandError('Private file verification incomplete; see counts and review before deployment.')
