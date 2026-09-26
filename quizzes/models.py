"""Live in-class quizzes: multiple-choice questions launched over WebSocket."""
from __future__ import annotations

from django.conf import settings
from django.db import models
from django.utils import timezone


class Quiz(models.Model):
    """A reusable multiple-choice quiz owned by a classroom."""

    classroom = models.ForeignKey(
        "classrooms.Classroom", on_delete=models.CASCADE,
        related_name="quizzes", verbose_name="کلاس",
    )
    title = models.CharField(max_length=200, verbose_name="عنوان")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        null=True, related_name="created_quizzes", verbose_name="سازنده",
    )
    created_at = models.DateTimeField(auto_now_add=True, verbose_name="تاریخ ساخت")

    class Meta:
        verbose_name = "آزمون"
        verbose_name_plural = "آزمون‌ها"
        ordering = ("-created_at", "-id")

    def __str__(self) -> str:  # pragma: no cover - debug helper
        return f"{self.title} ({self.classroom.room_code})"

    @property
    def total_points(self) -> int:
        return sum(q.points for q in self.questions.all())

    @property
    def question_count(self) -> int:
        return self.questions.count()


class QuizQuestion(models.Model):
    quiz = models.ForeignKey(Quiz, on_delete=models.CASCADE,
                             related_name="questions", verbose_name="آزمون")
    text = models.TextField(verbose_name="متن پرسش")
    order = models.PositiveIntegerField(default=1, verbose_name="ترتیب")
    points = models.PositiveIntegerField(default=1, verbose_name="بارم")

    class Meta:
        verbose_name = "پرسش"
        verbose_name_plural = "پرسش‌ها"
        ordering = ("order", "id")

    def __str__(self) -> str:  # pragma: no cover - debug helper
        return self.text[:40]


class QuizOption(models.Model):
    question = models.ForeignKey(QuizQuestion, on_delete=models.CASCADE,
                                 related_name="options", verbose_name="پرسش")
    text = models.CharField(max_length=300, verbose_name="متن گزینه")
    order = models.PositiveIntegerField(default=1, verbose_name="ترتیب")
    is_correct = models.BooleanField(default=False, verbose_name="گزینهٔ صحیح")

    class Meta:
        verbose_name = "گزینه"
        verbose_name_plural = "گزینه‌ها"
        ordering = ("order", "id")


class QuizRun(models.Model):
    """One live launch of a quiz inside the classroom."""

    quiz = models.ForeignKey(Quiz, on_delete=models.CASCADE,
                             related_name="runs", verbose_name="آزمون")
    started_by = models.ForeignKey(
        "classrooms.ClassroomMember", on_delete=models.SET_NULL, null=True,
        related_name="started_quiz_runs", verbose_name="شروع‌کننده",
    )
    started_at = models.DateTimeField(default=timezone.now, verbose_name="شروع")
    ended_at = models.DateTimeField(null=True, blank=True, verbose_name="پایان")

    class Meta:
        verbose_name = "اجرای آزمون"
        verbose_name_plural = "اجراهای آزمون"
        ordering = ("-started_at", "-id")

    @property
    def is_active(self) -> bool:
        return self.ended_at is None


class QuizAnswer(models.Model):
    """One member's latest choice for one question of one run (upserted)."""

    run = models.ForeignKey(QuizRun, on_delete=models.CASCADE,
                            related_name="answers", verbose_name="اجرا")
    member = models.ForeignKey(
        "classrooms.ClassroomMember", on_delete=models.CASCADE,
        related_name="quiz_answers", verbose_name="عضو",
    )
    question = models.ForeignKey(QuizQuestion, on_delete=models.CASCADE,
                                 related_name="answers", verbose_name="پرسش")
    option = models.ForeignKey(QuizOption, on_delete=models.CASCADE,
                               verbose_name="گزینهٔ انتخابی")
    answered_at = models.DateTimeField(auto_now=True, verbose_name="زمان پاسخ")

    class Meta:
        verbose_name = "پاسخ"
        verbose_name_plural = "پاسخ‌ها"
        constraints = [
            models.UniqueConstraint(
                fields=("run", "member", "question"), name="unique_quiz_answer"
            ),
        ]
