"""Rebuild the board storage: sequence numbers, compaction watermark, pages.

The board used to be addressed by ``WhiteboardEvent.id``.  Rows are now
numbered by a per-board ``seq`` that survives ``clear`` (the old design could
reuse ids after a compaction, which made reconnect/resync ambiguous), and the
board row carries the metadata clients need for an incremental resync:
``revision`` (last handed-out seq), ``compacted_before``, ``page_count``,
per-page backgrounds and the client published flattened snapshot.

Existing boards are migrated in place: their operations keep their order,
their page numbers are preserved and the per-page backgrounds are recovered
from the stored ``page_setup`` operations.
"""
from django.db import migrations, models


def backfill(apps, schema_editor):
    Whiteboard = apps.get_model("whiteboard", "Whiteboard")
    WhiteboardEvent = apps.get_model("whiteboard", "WhiteboardEvent")

    for board in Whiteboard.objects.all().iterator():
        seq = 0
        page_count = 1
        pages: dict = {}
        for event in WhiteboardEvent.objects.filter(whiteboard=board).order_by("id").iterator():
            seq += 1
            operation = event.operation if isinstance(event.operation, dict) else {}
            kind = str(operation.get("type") or "")
            tool = operation.get("tool")
            if kind == "draw" and isinstance(tool, str):
                kind = f"draw:{tool}"
            page = event.page
            if not page:
                raw_page = operation.get("page")
                page = raw_page if isinstance(raw_page, int) and raw_page > 0 else 1
            WhiteboardEvent.objects.filter(pk=event.pk).update(
                seq=seq,
                kind=kind[:24],
                scope="file" if operation.get("file_id") else "board",
                page=page,
            )
            page_count = max(page_count, int(page))
            if kind == "page_setup" and not operation.get("file_id"):
                entry = pages.setdefault(str(page), {})
                color = operation.get("color")
                grid = operation.get("grid")
                if isinstance(color, str):
                    entry["color"] = color
                if isinstance(grid, str):
                    entry["grid"] = grid
        Whiteboard.objects.filter(pk=board.pk).update(
            page_count=page_count,
            pages=pages,
            revision=seq,
            compacted_before=0,
            snapshot_ops=[],
            snapshot_seq=0,
        )


class Migration(migrations.Migration):

    dependencies = [
        ("whiteboard", "0003_whiteboardevent_page"),
    ]

    operations = [
        migrations.AddField(
            model_name="whiteboard",
            name="compacted_before",
            field=models.BigIntegerField(default=0, verbose_name="کوتاه‌سازی تا شماره"),
        ),
        migrations.AddField(
            model_name="whiteboard",
            name="created_at",
            field=models.DateTimeField(auto_now_add=True, null=True, verbose_name="ساخته‌شده"),
        ),
        migrations.AddField(
            model_name="whiteboard",
            name="page_count",
            field=models.PositiveIntegerField(default=1, verbose_name="تعداد صفحه"),
        ),
        migrations.AddField(
            model_name="whiteboard",
            name="pages",
            field=models.JSONField(blank=True, default=dict, verbose_name="تنظیمات صفحه‌ها"),
        ),
        migrations.AddField(
            model_name="whiteboard",
            name="revision",
            field=models.BigIntegerField(default=0, verbose_name="شمارهٔ آخرین عملیات"),
        ),
        migrations.AddField(
            model_name="whiteboard",
            name="snapshot_ops",
            field=models.JSONField(blank=True, default=list, verbose_name="تصویر فشرده"),
        ),
        migrations.AddField(
            model_name="whiteboard",
            name="snapshot_seq",
            field=models.BigIntegerField(default=0, verbose_name="شمارهٔ تصویر فشرده"),
        ),
        migrations.AddField(
            model_name="whiteboardevent",
            name="kind",
            field=models.CharField(
                db_index=True, default="", max_length=24, verbose_name="نوع"
            ),
        ),
        migrations.AddField(
            model_name="whiteboardevent",
            name="scope",
            field=models.CharField(
                choices=[("board", "تخته"), ("file", "ارائه")],
                default="board",
                max_length=8,
                verbose_name="دامنه",
            ),
        ),
        migrations.AddField(
            model_name="whiteboardevent",
            name="seq",
            field=models.BigIntegerField(db_index=True, default=0, verbose_name="ترتیب"),
        ),
        migrations.RunPython(backfill, migrations.RunPython.noop),
        migrations.AlterModelOptions(
            name="whiteboardevent",
            options={
                "ordering": ("seq", "id"),
                "verbose_name": "رویداد تخته",
                "verbose_name_plural": "رویدادهای تخته",
            },
        ),
        migrations.RemoveIndex(
            model_name="whiteboardevent",
            name="wb_board_id_idx",
        ),
        migrations.AddConstraint(
            model_name="whiteboardevent",
            constraint=models.UniqueConstraint(
                fields=("whiteboard", "seq"), name="wb_event_seq_unique"
            ),
        ),
        migrations.AddIndex(
            model_name="whiteboardevent",
            index=models.Index(fields=["whiteboard", "seq"], name="wb_board_seq_idx"),
        ),
        migrations.AddIndex(
            model_name="whiteboardevent",
            index=models.Index(
                fields=["whiteboard", "page", "seq"], name="wb_board_page_seq_idx"
            ),
        ),
    ]
