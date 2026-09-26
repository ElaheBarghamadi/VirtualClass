/**
 * quiz.js — live quiz client.
 *
 * Hosts start/end quizzes from the side panel; every participant answers
 * in a simple one-question-at-a-time modal.  The server is authoritative:
 * correct answers never reach the client until the run ends.
 */
import { toast } from './toast.js';

const el = (id) => document.getElementById(id);

export const QuizClient = {
    api: null,
    identity: '',
    privileged: false,
    runId: null,
    quiz: null,        // {run_id, quiz_id, title, questions:[...]}
    answers: {},       // question_id -> option_id (local mirror for UI state)
    qIndex: 0,
    ended: false,

    init({ api, identity, privileged }) {
        this.api = api;
        this.identity = identity;
        this.privileged = privileged;
        el('quiz-x')?.addEventListener('click', () => el('quiz-dialog').close());
        el('quiz-prev')?.addEventListener('click', () => this._go(-1));
        el('quiz-next')?.addEventListener('click', () => this._go(1));
        document.querySelectorAll('.quiz-start').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.closest('.quiz-item').dataset.quizId;
                btn.disabled = true;
                this.api('/quizzes/start/', { quiz_id: Number(id) })
                    .catch(() => {})
                    .finally(() => { btn.disabled = false; });
            });
        });
        el('quiz-end')?.addEventListener('click', () => {
            if (this.runId == null) return;
            this.api('/quizzes/end/', { run_id: this.runId }).catch(() => {});
        });
    },

    // ------------------------------------------------------------ WS events
    handleStarted(payload) {
        // snapshots are re-sent on roster changes — don't reset an ongoing run
        if (this.runId === payload.run_id && !this.ended) {
            this._setActiveUI(true);
            el('quiz-live-pill')?.classList.remove('hidden');
            return;
        }
        this.runId = payload.run_id;
        this.quiz = payload;
        this.answers = {};
        this.qIndex = 0;
        this.ended = false;
        el('quiz-results')?.classList.add('hidden');
        this._setActiveUI(true);
        el('quiz-live-pill')?.classList.remove('hidden');
        if (this.privileged) {
            toast(`آزمون «${payload.title}» شروع شد.`, 'info');
            el('quiz-progress').textContent = 'در انتظار پاسخ شرکت‌کنندگان…';
        } else {
            toast(`آزمون «${payload.title}» شروع شد — پاسخ دهید.`, 'info');
            this._openModal();
            this._renderQuestion();
        }
    },

    handleProgress(payload) {
        if (payload.run_id !== this.runId) return;
        const line = `${payload.answered_count} از ${payload.total_members} نفر پاسخ داده‌اند`;
        const p = el('quiz-progress');
        if (p) p.textContent = line;
    },

    handleEnded(payload) {
        if (payload.run_id !== this.runId) return;
        this.ended = true;
        this._setActiveUI(false);
        el('quiz-live-pill')?.classList.add('hidden');
        const results = payload.results || [];
        const box = el('quiz-results');
        box.classList.remove('hidden');
        box.innerHTML = '';
        const title = document.createElement('h3');
        title.textContent = `نتایج «${payload.title}»`;
        box.appendChild(title);
        const rows = this.privileged
            ? results
            : results.filter((r) => r.identity === this.identity);
        if (rows.length === 0) {
            const p = document.createElement('p');
            p.className = 'muted';
            p.textContent = this.privileged ? 'پاسخی ثبت نشد.' : 'شما پاسخی ثبت نکردید.';
            box.appendChild(p);
        }
        const list = document.createElement('ul');
        list.className = 'quiz-result-list';
        rows.forEach((r, i) => {
            const li = document.createElement('li');
            const rank = document.createElement('span');
            rank.className = 'quiz-rank';
            rank.textContent = `${i + 1}.`;
            const name = document.createElement('span');
            name.textContent = r.name;
            const score = document.createElement('strong');
            score.textContent = `${r.score} از ${r.max}`;
            li.append(rank, name, score);
            list.appendChild(li);
        });
        box.appendChild(list);
        // ensure the dialog is visible so nobody misses their result
        this._openModal();
        el('quiz-question-text').textContent = 'آزمون به پایان رسید.';
        el('quiz-options').innerHTML = '';
        el('quiz-q-index').textContent = '';
        el('quiz-q-points').textContent = '';
        el('quiz-hint').textContent = '';
        el('quiz-progress-fill').style.width = '100%';
    },

    // ------------------------------------------------------------ UI pieces
    _setActiveUI(active) {
        el('quiz-active')?.classList.toggle('hidden', !active);
        const end = el('quiz-end');
        if (end) {
            end.classList.toggle('hidden', !active || !this.privileged);
        }
        if (active) {
            const t = el('quiz-active-title');
            if (t && this.quiz) t.textContent = `آزمون در جریان: ${this.quiz.title}`;
        }
    },

    _openModal() {
        const d = el('quiz-dialog');
        if (d && !d.open) {
            try { d.showModal(); } catch (e) { d.show(); }
        }
    },

    _renderQuestion() {
        if (!this.quiz) return;
        const qs = this.quiz.questions;
        const q = qs[this.qIndex];
        if (!q) return;
        el('quiz-dialog-title').textContent = this.quiz.title;
        el('quiz-q-index').textContent = `پرسش ${this.qIndex + 1} از ${qs.length}`;
        el('quiz-q-points').textContent = `${q.points} نمره`;
        el('quiz-question-text').textContent = q.text;
        el('quiz-progress-fill').style.width =
            `${Math.round(((this.qIndex + 1) / qs.length) * 100)}%`;
        el('quiz-hint').textContent =
            Object.keys(this.answers).length === qs.length
                ? 'به همهٔ پرسش‌ها پاسخ داده‌اید ✓'
                : 'با کلیک روی گزینه، پاسخ شما ثبت می‌شود.';
        const box = el('quiz-options');
        box.innerHTML = '';
        q.options.forEach((o) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'quiz-option';
            btn.textContent = o.text;
            if (this.answers[q.id] === o.id) btn.classList.add('selected');
            btn.addEventListener('click', () => this._answer(q, o));
            box.appendChild(btn);
        });
        el('quiz-prev').disabled = this.qIndex === 0;
        el('quiz-next').disabled = this.qIndex === qs.length - 1;
    },

    _go(delta) {
        const qs = this.quiz?.questions || [];
        const next = this.qIndex + delta;
        if (next < 0 || next >= qs.length) return;
        this.qIndex = next;
        this._renderQuestion();
    },

    async _answer(q, option) {
        if (this.answers[q.id] === option.id) return;
        this.answers[q.id] = option.id;
        try {
            await this.api('/quizzes/answer/', {
                run_id: this.runId, question_id: q.id, option_id: option.id,
            });
        } catch (e) {
            delete this.answers[q.id];
            return;
        }
        this._renderQuestion();
        // gentle auto-advance to the first unanswered question
        const qs = this.quiz.questions;
        const unanswered = qs.findIndex((x) => this.answers[x.id] === undefined);
        if (unanswered !== -1 && unanswered !== this.qIndex) {
            setTimeout(() => {
                if (this.quiz && !this.ended) { this.qIndex = unanswered; this._renderQuestion(); }
            }, 450);
        }
    },
};
