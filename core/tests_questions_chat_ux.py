"""Contracts for the «سوالات» tab and the two-channel chat.

These are the decisions that are easy to break silently, because every one of
them is a *policy*, not a visual detail:

* a question is two-to-ten options, and the only place the correct answer is
  ever shown is the payload sent when the question ends;
* percentages and counts are for everybody, names only for the host team in a
  class below fifty — and the *server* makes that call, so the client must not
  invent a name list of its own;
* the private chat channel is a host tool: students never see the switch (the
  server also refuses their `private` flag), and the private bubble must never
  be rendered before the server says it may be.
"""
from __future__ import annotations

import re
from pathlib import Path

from django.test import SimpleTestCase

REPO_ROOT = Path(__file__).resolve().parent.parent
JS = REPO_ROOT / "static" / "js"
CSS = REPO_ROOT / "static" / "css"
TEMPLATES = REPO_ROOT / "classrooms" / "templates" / "classrooms"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class QuestionTabTests(SimpleTestCase):
    def setUp(self):
        self.room = read(TEMPLATES / "room.html")
        self.quiz_js = read(JS / "quiz.js")

    def test_tab_is_called_questions_not_exam(self):
        self.assertIn("سوالات", self.room)
        # The rename is product-wide: no «آزمون» left in the room markup.
        self.assertNotIn("آزمون", self.room)

    def test_composer_is_host_only_and_carries_no_question_by_default(self):
        block = re.search(
            r"<div class=\"quiz-compose hidden\" id=\"quiz-compose\">(.*?)</div>\s*\n\s*\{% endif %\}",
            self.room,
            re.S,
        )
        self.assertIsNotNone(block, "the composer must ship hidden and inside the host block")
        self.assertIn('id="quiz-new-text"', block.group(1))
        self.assertIn('id="quiz-option-inputs"', block.group(1))
        self.assertIn('id="quiz-add-option"', block.group(1))
        self.assertIn('id="quiz-ask"', block.group(1))

    def test_option_bounds_are_two_and_ten(self):
        self.assertIn("const MIN_OPTIONS = 2;", self.quiz_js)
        self.assertIn("const MAX_OPTIONS = 10;", self.quiz_js)
        self.assertIn(
            "if (box.children.length >= MAX_OPTIONS)", self.quiz_js,
            "the composer must stop at ten rows",
        )
        self.assertIn(
            "if (box.children.length <= MIN_OPTIONS)", self.quiz_js,
            "the composer must refuse to drop below two rows",
        )

    def test_correct_option_survives_blank_rows(self):
        """A tick on the third row must still point at the third *kept* row."""
        ask = re.search(r"async _ask\(\) \{(.*?)\n    \},", self.quiz_js, re.S)
        self.assertIsNotNone(ask)
        body = ask.group(1)
        self.assertIn(".filter((entry) => entry.text)", body)
        self.assertIn("picked.findIndex((entry) => entry.correct)", body)
        self.assertIn("correct: correctIndex >= 0 ? correctIndex : null", body)

    def test_live_stats_never_render_correctness_until_the_end(self):
        detail = re.search(r"handleStatsDetail\(payload\) \{(.*?)\n    \},", self.quiz_js, re.S)
        self.assertIsNotNone(detail)
        # Live detail is only "correct" when the payload says the run ended.
        self.assertIn("showCorrect: Boolean(payload.ended) || this.ended", detail.group(1))
        ended = re.search(r"handleEnded\(payload\) \{(.*?)\n    \},", self.quiz_js, re.S)
        self.assertIsNotNone(ended)
        self.assertIn("showCorrect: true", ended.group(1))

    def test_percentages_and_counts_are_rendered(self):
        self.assertIn("`${fa(option.percent)}٪ · ${fa(option.count)} نفر`", self.quiz_js)
        self.assertIn("quiz-stat-fill", self.quiz_js)
        # …and the width is clamped: the server rounds, the client must not
        # paint a 101% bar.
        self.assertIn("Math.min(100, Number(option.percent) || 0)", self.quiz_js)

    def test_names_are_only_painted_for_the_host_team(self):
        ended = re.search(r"handleEnded\(payload\) \{(.*?)\n    \},", self.quiz_js, re.S).group(1)
        self.assertIn("payload.show_who", ended)
        self.assertIn("this.privileged || this.authority", ended)
        stats = re.search(r"handleStats\(payload\) \{(.*?)\n    \},", self.quiz_js, re.S).group(1)
        self.assertIn("showWho: false", stats)

    def test_results_replace_the_question_inside_the_dialog(self):
        self.assertIn('id="quiz-results"', self.room)
        self.assertIn('id="quiz-question-body"', self.room)
        self.assertIn("el('quiz-question-body')?.classList.add('hidden')", self.quiz_js)

    def test_results_show_up_without_waiting_for_the_end(self):
        """Bars under the options the moment a student answers."""
        self.assertIn('id="quiz-question-stats"', self.room)
        self.assertIn("_renderQuestionStats()", self.quiz_js)
        render = re.search(r"_renderQuestionStats\(\) \{(.*?)\n    \},", self.quiz_js, re.S)
        self.assertIsNotNone(render)
        self.assertIn("this.statsMap[question.id]", render.group(1))
        # ... and the panel keeps every question that already has a row
        stats = re.search(r"_paintStats\(\{ showWho = false, showCorrect = false \} = \{\}\) \{(.*?)\n    \},", self.quiz_js, re.S)
        self.assertIsNotNone(stats)
        self.assertIn("this._renderStats(panel, rows, { showWho, showCorrect })", stats.group(1))
        self.assertIn("_statRows()", stats.group(1))

    def test_stats_frames_merge_instead_of_replacing(self):
        merge = re.search(r"mergeStats\(rows\) \{(.*?)\n    \},", self.quiz_js, re.S)
        self.assertIsNotNone(merge)
        self.assertIn("{ ...previous, ...row }", merge.group(1))
        # the old run's rows must not survive into the next question
        started = re.search(r"handleStarted\(payload\) \{(.*?)\n    \},", self.quiz_js, re.S)
        self.assertIn("this.statsMap = {};", started.group(1))


class ChatChannelTests(SimpleTestCase):
    def setUp(self):
        self.room = read(TEMPLATES / "room.html")
        self.chat_js = read(JS / "chat.js")
        self.css = read(CSS / "room.css")

    def test_private_switch_is_inside_the_host_block(self):
        idx_switch = self.room.index('class="chat-channels"')
        idx_guard = self.room.rindex("{% if can_control_board %}", 0, idx_switch)
        idx_end = self.room.index("{% endif %}", idx_guard)
        self.assertLess(idx_guard, idx_switch)
        self.assertLess(idx_switch, idx_end)

    def test_composer_is_shared_by_everybody(self):
        self.assertIn('id="chat-form"', self.room)
        self.assertIn('id="chat-input"', self.room)
        self.assertIn('id="chat-reply"', self.room)

    def test_private_flag_only_leaves_a_privileged_client(self):
        start = self.chat_js.index("send(text) {")
        body = self.chat_js[start: self.chat_js.index("nudge(force = false)", start)]
        self.assertIn("this.channel === 'private'", body)
        self.assertIn("this.privileged", body)
        self.assertIn("payload.private = true", body)

    def test_students_lose_the_switch_and_cannot_switch_to_it(self):
        self.assertIn(
            'document.querySelectorAll(\'.chat-channel[data-channel="private"]\')',
            self.chat_js,
        )
        self.assertIn(
            "channel === 'private' && this.privileged ? 'private' : 'public'",
            self.chat_js,
        )

    def test_message_text_is_never_injected_as_html(self):
        self.assertIn("body.textContent = m.message;", self.chat_js)
        self.assertIn("who.textContent = option.who.join('، ')", read(JS / "quiz.js"))

    def test_private_bubbles_have_their_own_skin(self):
        self.assertIn(".chat-msg.private", self.css)
        self.assertIn(".chat-priv-tag", self.css)
        # Softer than the old solid fill: the bubble is a tint of the accent.
        bubble = re.search(r"\.chat-msg\.own \.chat-bubble \{(.*?)\}", self.css, re.S)
        self.assertIsNotNone(bubble)
        self.assertIn("color-mix", bubble.group(1))
        self.assertIn("var(--room-surface)", bubble.group(1))

    def test_reply_quote_styles_exist(self):
        for selector in (".chat-quote", ".chat-reply", ".chat-reply-name", ".chat-reply-x"):
            self.assertIn(selector, self.css)
