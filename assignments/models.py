"""Assignments with submissions and teacher grading."""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.utils import timezone


def assignment_upload_path(instance: "Submission", filename: str) -> str:
    return f"classrooms/{instance.assignment.classroom_id}/assignments/{filename}"


class Assignment(models.Model):
    classroom = models.ForeignKey(
        "classrooms.Classroom", on_delete=models.CASCADE,
        related_name="assignments", verbose_name="کلاس",
    )
    title = models.CharField(max_length=200, verbose_name="عنوان")
    description = models.TextField(blank=True, verbose_name="شرح تکلیف")
    due_at = models.DateTimeField(verbose_name="مهلت ارسال")
    max_score = models.PositiveIntegerField(default=20, verbose_name="بارم کل")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, related_name="created_assignments", verbose_name="سازنده",
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="تاریخ ساخت")

    class Meta:
        verbose_name = "تکلیف"
        verbose_name_plural = "تکالیف"
        ordering = ("-due_at", "-id")

    def __str__(self) -> str:  # pragma: no cover - debug helper
        return self.title

    @property
    def is_open(self) -> bool:
        return timezone.now() <= self.due_at


class Submission(models.Model):
    assignment = models.ForeignKey(Assignment, on_delete=models.CASCADE,
                                   related_name="submissions", verbose_name="تکلیف")
    member = models.ForeignKey(
        "classrooms.ClassroomMember", on_delete=models.CASCADE,
        related_name="assignment_submissions", verbose_name="عضو",
    )
    content = models.TextField(blank=True, verbose_name="متن پاسخ")
    file = models.FileField(upload_to=assignment_upload_path,
                            null=True, blank=True, verbose_name="فایل پاسخ")
    submitted_at = models.DateTimeField(auto_now_add=True, verbose_name="زمان ارسال")
    updated_at = models.DateTimeField(auto_now=True, verbose_name="آخرین ویرایش")
    score = models.DecimalField(max_digits=5, decimal_places=1, null=True,
                                blank=True, verbose_name="نمره")
    feedback = models.TextField(blank=True, verbose_name="بازخورد")
    graded_at = models.DateTimeField(null=True, blank=True, verbose_name="زمان تصحیح")

    class Meta:
        verbose_name = "ارسال پاسخ"
        verbose_name_plural = "ارسال‌های پاسخ"
        constraints = [
            models.UniqueConstraint(
                fields=("assignment", "member"), name="unique_submission"
            ),
        ]

    @property
    def student_name(self) -> str:
        if self.member.display_name:
            return self.member.display_name
        return self.member.user.get_full_name() if self.member.user else "?"
