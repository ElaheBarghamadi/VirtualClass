"""Server-side tests for the live quiz pipeline."""
import json

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from classrooms.models import ClassroomMember
from classrooms.permissions import Role
from classrooms.services import create_classroom, join_classroom

from .models import Quiz, QuizAnswer, QuizOption, QuizQuestion, QuizRun
from .services import (
    WHO_LIST_MAX_CLASS,
    QuizError,
    active_run,
    ask_question,
    class_participant_count,
    question_stats,
    results_payload,
    run_payload,
)

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

    def test_scoreboard_uses_the_roster_name(self):
        """Accounts with only a username used to render as a blank row.

        ``User.get_full_name()`` is empty unless first/last name is set, so
        the scoreboard must read the roster name (display name → username).
        """
        bare = User.objects.create_user(username="q_bare", password="Pass-12345")
        bare_member = ClassroomMember.objects.create(
            classroom=self.classroom, user=bare, role=Role.STUDENT,
        )
        resp = self._post("start", self.owner, quiz_id=self.quiz.id)
        run_id = resp.json()["run_id"]
        self._post("answer", bare, run_id=run_id,
                   question_id=self.q1.id, option_id=self.q1_ok.id)
        self._post("end", self.owner, run_id=run_id)

        run = QuizRun.objects.get(id=run_id)
        rows = {row["identity"]: row for row in results_payload(run)}
        self.assertEqual(rows[bare_member.identity]["name"], "q_bare")
        self.assertEqual(rows[bare_member.identity]["score"], 2)

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


class LiveQuestionTests(TestCase):
    """«طرح سوال» — instant authoring from inside the room."""

    def setUp(self):
        self.owner = make_user("lq_owner")
        self.moderator = make_user("lq_mod")
        self.presenter = make_user("lq_pres")
        self.student = make_user("lq_stu")
        self.classroom = create_classroom(self.owner, title="Live")
        ClassroomMember.objects.create(
            classroom=self.classroom, user=self.moderator, role=Role.MODERATOR,
        )
        ClassroomMember.objects.create(
            classroom=self.classroom, user=self.presenter, role=Role.PRESENTER,
        )
        self.student_member = ClassroomMember.objects.create(
            classroom=self.classroom, user=self.student, role=Role.STUDENT,
        )

    def _ask(self, user, **body):
        self.client.force_login(user)
        return self.client.post(
            reverse("quizzes:ask", args=[self.classroom.room_code]),
            data=json.dumps(body), content_type="application/json",
        )

    def test_authority_asks_and_run_starts_immediately(self):
        resp = self._ask(self.owner, text="پایتخت ایران؟", options=["تهران", "شیراز"])
        self.assertEqual(resp.status_code, 200)
        run = QuizRun.objects.get(id=resp.json()["run_id"])
        self.assertTrue(run.is_active)
        question = run.quiz.questions.get()
        self.assertEqual(question.options.count(), 2)
        self.assertEqual(question.created_by, self.classroom.members.get(user=self.owner))
        # students are told who asked, and the payload still hides correctness
        payload = run_payload(run)
        self.assertNotIn("is_correct", json.dumps(payload))
        self.assertTrue(payload["asked_by"])

    def test_moderator_and_presenter_may_ask(self):
        for user in (self.moderator, self.presenter):
            resp = self._ask(user, text="سوال", options=["الف", "ب"])
            self.assertEqual(resp.status_code, 200, user.username)

    def test_student_cannot_ask(self):
        resp = self._ask(self.student, text="سوال", options=["الف", "ب"])
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(Quiz.objects.exists())

    def test_option_bounds(self):
        one = self._ask(self.owner, text="سوال", options=["تنها"])
        self.assertEqual(one.status_code, 400)
        self.assertIn("دو گزینه", one.json()["detail"])

        ten = self._ask(self.owner, text="سوال", options=[f"گزینهٔ {i}" for i in range(1, 11)])
        self.assertEqual(ten.status_code, 200)
        self.assertEqual(
            QuizRun.objects.get(id=ten.json()["run_id"]).quiz.questions.get().options.count(), 10,
        )

        eleven = self._ask(self.owner, text="سوال", options=[f"گزینهٔ {i}" for i in range(1, 12)])
        self.assertEqual(eleven.status_code, 400)
        self.assertIn("۱۰", eleven.json()["detail"])

    def test_blank_options_are_ignored_before_numbering(self):
        # The client normalises first (see quiz.js `_ask`), so `correct` counts
        # positions in the *cleaned* list: 1 → «ب» here.
        resp = self._ask(
            self.owner, text="سوال", options=["الف", "   ", "ب", ""], correct=1,
        )
        self.assertEqual(resp.status_code, 200)
        question = QuizRun.objects.get(id=resp.json()["run_id"]).quiz.questions.get()
        self.assertEqual([o.text for o in question.options.all()], ["الف", "ب"])
        self.assertTrue(question.options.get(text="ب").is_correct)
        self.assertFalse(question.options.get(text="الف").is_correct)

    def test_correct_index_out_of_range_is_rejected(self):
        with self.assertRaises(QuizError):
            ask_question(self.classroom, self.classroom.members.get(user=self.owner),
                         text="سوال", options=["الف", "ب"], correct_index=5)

    def test_empty_text_rejected(self):
        resp = self._ask(self.owner, text="   ", options=["الف", "ب"])
        self.assertEqual(resp.status_code, 400)


class QuestionStatsTests(TestCase):
    """Percentages, counts and the «زیر ۵۰ نفر» attribution rule."""

    def setUp(self):
        self.owner = make_user("st_owner")
        self.classroom = create_classroom(self.owner, title="Stats")
        self.owner_member = self.classroom.members.get(user=self.owner)
        self.participants = []
        for index in range(3):
            user = make_user(f"st_stu{index}")
            ClassroomMember.objects.create(
                classroom=self.classroom, user=user, role=Role.STUDENT,
            )
            self.participants.append(self.classroom.members.get(user=user))
        self.run = ask_question(
            self.classroom, self.owner_member,
            text="۲+۲؟", options=["۳", "۴", "۵"], correct_index=1,
        )
        self.question = self.run.quiz.questions.get()
        self.options = list(self.question.options.all())
        for member, option in zip(self.participants, self.options):
            QuizAnswer.objects.create(
                run=self.run, question=self.question, member=member, option=option,
            )

    def test_percentages_and_counts(self):
        stats = question_stats(self.run)
        row = stats[0]
        self.assertEqual(row["total"], 3)
        counts = {o["text"]: o["count"] for o in row["options"]}
        self.assertEqual(counts, {"۳": 1, "۴": 1, "۵": 1})
        self.assertEqual([o["percent"] for o in row["options"]], [33, 33, 33])
        self.assertNotIn("is_correct", row["options"][0])
        self.assertNotIn("who", row["options"][0])

    def test_percent_rounds_and_sums_close_to_hundred(self):
        extra = ClassroomMember.objects.create(
            classroom=self.classroom, user=make_user("st_extra"), role=Role.STUDENT,
        )
        QuizAnswer.objects.create(
            run=self.run, question=self.question, member=extra, option=self.options[1],
        )
        row = question_stats(self.run)[0]
        self.assertEqual(row["total"], 4)
        self.assertEqual([o["count"] for o in row["options"]], [1, 2, 1])
        self.assertEqual([o["percent"] for o in row["options"]], [25, 50, 25])

    def test_small_class_gets_names(self):
        row = question_stats(self.run, include_names=True)[0]
        who = {o["text"]: o["who"] for o in row["options"]}
        self.assertEqual(who["۳"], [self.participants[0].participant_name])
        self.assertLess(class_participant_count(self.classroom), WHO_LIST_MAX_CLASS)

    def test_correctness_only_on_reveal(self):
        live = question_stats(self.run)
        self.assertFalse(any("is_correct" in o for o in live[0]["options"]))
        final = question_stats(self.run, reveal_correct=True)
        correct = [o for o in final[0]["options"] if o.get("is_correct")]
        self.assertEqual([o["text"] for o in correct], ["۴"])

    def test_large_class_hides_names(self):
        """At 50+ participants the broadcast stops naming names."""
        missing = 50 - class_participant_count(self.classroom)
        for index in range(missing):
            ClassroomMember.objects.create(
                classroom=self.classroom, user=make_user(f"st_bulk{index}"),
                role=Role.STUDENT,
            )
        self.assertEqual(class_participant_count(self.classroom), 50)
        row = question_stats(self.run, include_names=False)[0]
        self.assertFalse(any("who" in o for o in row["options"]))
        # percentages are unaffected by the privacy cut-off
        self.assertEqual(row["total"], 3)


class StatsBroadcastTests(TestCase):
    """Who gets percentages, and when.

    The rule the room is built around: a bar chart is an answer key, so the
    numbers only reach somebody who has already answered (or everybody, once
    the question is over).  The host team always sees the whole picture.
    """

    def setUp(self):
        self.owner = make_user("sb_owner")
        self.classroom = create_classroom(self.owner, title="Broadcast")
        self.owner_member = self.classroom.members.get(user=self.owner)
        self.answerer = ClassroomMember.objects.create(
            classroom=self.classroom, user=make_user("sb_answer"), role=Role.STUDENT,
        )
        self.quiet = ClassroomMember.objects.create(
            classroom=self.classroom, user=make_user("sb_quiet"), role=Role.STUDENT,
        )
        self.run = ask_question(
            self.classroom, self.owner_member, text="س؟", options=["الف", "ب"],
            correct_index=0,
        )
        self.question = self.run.quiz.questions.get()

    def _answer(self):
        QuizAnswer.objects.create(
            run=self.run, question=self.question, member=self.answerer,
            option=self.question.options.first(),
        )

    def _frames(self):
        from unittest import mock

        from . import services

        with mock.patch.object(services, "broadcast") as sent, \
                mock.patch.object(services, "notify_member") as notified:
            services._broadcast_stats(self.classroom, self.run)
        return sent, notified

    def test_nothing_is_broadcast_to_the_room_while_the_question_is_open(self):
        self._answer()
        sent, _ = self._frames()
        self.assertEqual(sent.call_count, 0, "percentages must not go room-wide")

    def test_hosts_get_the_detail_even_before_anybody_answers(self):
        _, notified = self._frames()
        self.assertEqual(notified.call_count, 1)
        room, member, payload = notified.call_args.args
        self.assertEqual(member.id, self.owner_member.id)
        self.assertEqual(payload["type"], "quiz_stats_detail")
        self.assertTrue(payload["show_who"])
        self.assertNotIn("is_correct", json.dumps(payload["stats"]))

    def test_the_student_who_answered_gets_their_row(self):
        self._answer()
        _, notified = self._frames()
        by_type = {}
        for call in notified.call_args_list:
            _, member, payload = call.args
            by_type.setdefault(payload["type"], []).append((member.id, payload))
        stats_frames = by_type.get("quiz_stats", [])
        self.assertEqual([mid for mid, _ in stats_frames], [self.answerer.id])
        payload = stats_frames[0][1]
        self.assertEqual([row["id"] for row in payload["stats"]], [self.question.id])
        self.assertNotIn("who", json.dumps(payload["stats"]))
        self.assertNotIn("is_correct", json.dumps(payload["stats"]))

    def test_the_student_who_has_not_answered_gets_nothing(self):
        self._answer()
        _, notified = self._frames()
        targets = {call.args[1].id for call in notified.call_args_list}
        self.assertNotIn(self.quiet.id, targets)

    def test_ending_reveals_everything_to_the_room(self):
        from unittest import mock

        from . import services

        self._answer()
        with mock.patch.object(services, "broadcast") as sent, \
                mock.patch.object(services, "notify_member") as notified:
            services._broadcast_stats(self.classroom, self.run, ended=True)

        self.assertEqual(sent.call_count, 1)
        event = sent.call_args.args[1]
        self.assertEqual(event["type"], "quiz_stats")
        self.assertTrue(event["ended"])
        self.assertIn("is_correct", json.dumps(event["stats"]))
        # correctness still never travels as a live event
        self.assertNotIn("who", json.dumps(event["stats"]))
        self.assertTrue(notified.call_count >= 1)

    def test_live_events_never_reveal_correctness(self):
        from unittest import mock

        from . import services

        self._answer()
        with mock.patch.object(services, "broadcast") as sent:
            services._broadcast_stats(self.classroom, self.run)
        self.assertEqual(sent.call_count, 0)
