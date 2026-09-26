"""Server-side tests for the live quiz pipeline."""
import json

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone

from classrooms.models import Classroom, ClassroomMember
from classrooms.permissions import Role
from classrooms.services import create_classroom

from .models import Quiz, QuizAnswer, QuizOption, QuizQuestion, QuizRun
from .services import active_run, results_payload, run_payload

User = get_user_model()


def make_user(username: str):
    return User.objects.create_user(
        username=username, password="Pass-12345",
        first_name=username, email=f"{username}@ex.com",
    )


class QuizFlowTests(TestCase):
    def setUp(self):
        self.owner = make_user("q_owner")
        self.student = make_user("q_stu")
        self.classroom = create_classroom(self.owner, title="Quiz room")
        self.student_member = ClassroomMember.objects.create(
            classroom=self.classroom, user=self.student, role=Role.STUDENT,
        )
        self.quiz = Quiz.objects.create(
            classroom=self.classroom, title="آزمون ۱", created_by=self.owner,
        )
        q1 = QuizQuestion.objects.create(quiz=self.quiz, text="۲+۲؟", order=1, points=2)
        QuizOption.objects.create(question=q1, text="۳", order=1)
        self.q1_ok = QuizOption.objects.create(question=q1, text="۴", order=2, is_correct=True)
        q2 = QuizQuestion.objects.create(quiz=self.quiz, text="پایتخت ایران؟", order=2, points=1)
        self.q2_ok = QuizOption.objects.create(question=q2, text="تهران", order=1, is_correct=True)
        QuizOption.objects.create(question=q2, text="شیراز", order=2)
        self.q1, self.q2 = q1, q2

    def _post(self, name, user, **body):
        self.client.force_login(user)
        return self.client.post(
            reverse(f"quizzes:{name}", args=[self.classroom.room_code]),
            data=json.dumps(body), content_type="application/json",
        )

    def test_start_requires_privilege(self):
        resp = self._post("start", self.student, quiz_id=self.quiz.id)
        self.assertEqual(resp.status_code, 403)
        self.assertFalse(QuizRun.objects.exists())

    def test_full_flow_and_scoring(self):
        resp = self._post("start", self.owner, quiz_id=self.quiz.id)
        self.assertEqual(resp.status_code, 200)
        run_id = resp.json()["run_id"]
        run = QuizRun.objects.get(id=run_id)
        # payload never leaks correctness
        payload = run_payload(run)
        self.assertNotIn("is_correct", json.dumps(payload))

        # student answers q1 correctly, q2 wrongly (option of q1 reused → 400)
        r1 = self._post("answer", self.student, run_id=run_id,
                        question_id=self.q1.id, option_id=self.q1_ok.id)
        self.assertEqual(r1.status_code, 200)
        bad = self._post("answer", self.student, run_id=run_id,
                         question_id=self.q2.id, option_id=self.q1_ok.id)
        self.assertEqual(bad.status_code, 400)
        # change of mind is an upsert, not a duplicate
        self._post("answer", self.student, run_id=run_id,
                   question_id=self.q1.id, option_id=self.q1_ok.id)
        self.assertEqual(QuizAnswer.objects.filter(run=run).count(), 1)

        resp = self._post("end", self.owner, run_id=run_id)
        self.assertEqual(resp.status_code, 200)
        results = resp.json()["results"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["score"], 2)
        self.assertEqual(results[0]["max"], 3)
        self.assertEqual(results[0]["identity"], self.student_member.identity)
        # answering after the end is rejected
        late = self._post("answer", self.student, run_id=run_id,
                          question_id=self.q2.id, option_id=self.q2_ok.id)
        self.assertEqual(late.status_code, 400)

    def test_student_cannot_end(self):
        run_id = self._post("start", self.owner, quiz_id=self.quiz.id).json()["run_id"]
        resp = self._post("end", self.student, run_id=run_id)
        self.assertEqual(resp.status_code, 400)
        self.assertTrue(QuizRun.objects.get(id=run_id).is_active)

    def test_non_member_cannot_answer(self):
        run_id = self._post("start", self.owner, quiz_id=self.quiz.id).json()["run_id"]
        outsider = make_user("q_out")
        resp = self._post("answer", outsider, run_id=run_id,
                          question_id=self.q1.id, option_id=self.q1_ok.id)
        self.assertEqual(resp.status_code, 403)

    def test_empty_quiz_cannot_start(self):
        empty = Quiz.objects.create(classroom=self.classroom, title="خالی")
        resp = self._post("start", self.owner, quiz_id=empty.id)
        self.assertEqual(resp.status_code, 403)

    def test_other_classroom_quiz_rejected(self):
        other_owner = make_user("q_other")
        other = create_classroom(other_owner, title="دیگر")
        foreign = Quiz.objects.create(classroom=other, title="بیگانه")
        resp = self._post("start", self.owner, quiz_id=foreign.id)
        self.assertEqual(resp.status_code, 403)

    def test_active_run_snapshot_helper(self):
        self.assertIsNone(active_run(self.classroom))
        self._post("start", self.owner, quiz_id=self.quiz.id)
        run = active_run(self.classroom)
        self.assertIsNotNone(run)
        self._post("end", self.owner, run_id=run.id)
        self.assertIsNone(active_run(self.classroom))
        self.assertEqual(len(results_payload(run)), 0)

    def test_start_closes_dangling_run(self):
        r1 = self._post("start", self.owner, quiz_id=self.quiz.id).json()["run_id"]
        r2 = self._post("start", self.owner, quiz_id=self.quiz.id).json()["run_id"]
        self.assertFalse(QuizRun.objects.get(id=r1).is_active)
        self.assertTrue(QuizRun.objects.get(id=r2).is_active)


class QuizAuthoringTests(TestCase):
    def setUp(self):
        self.owner = make_user("qa_owner")
        self.classroom = create_classroom(self.owner, title="Authoring")

    def test_owner_creates_quiz_and_question(self):
        self.client.force_login(self.owner)
        resp = self.client.post(
            reverse("quizzes_manage:list", args=[self.classroom.room_code]),
            {"title": "آزمون فصل ۱"},
        )
        quiz = Quiz.objects.get(title="آزمون فصل ۱")
        self.assertRedirects(resp, reverse(
            "quizzes_manage:detail", args=[self.classroom.room_code, quiz.id]))
        resp = self.client.post(
            reverse("quizzes_manage:detail", args=[self.classroom.room_code, quiz.id]),
            {"add_question": "1", "text": "۱+۱؟", "points": "2",
             "option_1": "یک", "option_2": "دو", "option_3": "", "option_4": "",
             "correct": "2"},
        )
        self.assertEqual(resp.status_code, 302)
        q = quiz.questions.get()
        self.assertEqual(q.points, 2)
        self.assertEqual(q.options.count(), 2)
        self.assertTrue(q.options.get(order=2).is_correct)

    def test_non_owner_cannot_author(self):
        other = make_user("qa_other")
        self.client.force_login(other)
        resp = self.client.get(
            reverse("quizzes_manage:list", args=[self.classroom.room_code]))
        self.assertEqual(resp.status_code, 404)

    def test_question_requires_two_options(self):
        quiz = Quiz.objects.create(classroom=self.classroom, title="q")
        self.client.force_login(self.owner)
        self.client.post(
            reverse("quizzes_manage:detail", args=[self.classroom.room_code, quiz.id]),
            {"add_question": "1", "text": "سوال", "points": "1",
             "option_1": "الف", "option_2": "", "option_3": "", "option_4": "",
             "correct": "1"},
        )
        self.assertEqual(quiz.questions.count(), 0)
