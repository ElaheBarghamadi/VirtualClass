/**
 * quiz.js — the live «سوالات» client.
 *
 * Hosts (owner / moderator / presenter) compose a question right inside the
 * room: a text plus any number of options between two and ten.  Everybody
 * answers in a one-question-at-a-time modal; the server is authoritative and
 * never sends the correct option before the question ends.
 *
 * Results: counts and percentages for every option, live while people answer.
 * In a class below 50 people the host team also receives the names behind each
 * option (the server decides that; a student is never sent those names).
 */
import { toast } from './toast.js';

const el = (id) => document.getElementById(id);
const fa = (value) => Number(value || 0).toLocaleString('fa-IR');
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

export const QuizClient = {
    api: null,
    identity: '',
    privileged: false,   // owner/moderator — the moderation side of the room
    authority: false,    // owner/moderator/presenter — may ask & end questions
    runId: null,
    quiz: null,        // {run_id, quiz_id, title, questions:[...], show_who}
    answers: {},       // question_id -> option_id (local mirror for UI state)
    qIndex: 0,
    ended: false,
    stats: null,       // latest quiz_stats payload
    detail: null,      // quiz_stats_detail (names + correctness) for hosts
    statsMap: {},      // question_id → latest row; the panel renders this
    _optionRows: 0,

    init({ api, identity, privileged, authority = false }) {
        this.api = api;
        this.identity = identity;
        this.privileged = privileged;
        this.authority = Boolean(authority);
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
        this._initCompose();
    },

    // ------------------------------------------------------------ composer
    _initCompose() {
        const box = el('quiz-option-inputs');
        if (!box) return;
        el('quiz-add-option')?.addEventListener('click', () => this._addOptionRow());
        el('quiz-ask')?.addEventListener('click', () => this._ask());
        el('quiz-new-text')?.addEventListener('keydown', (e) => {
            // Enter inside the question text asks straight away; the option
            // fields stay single-line so Enter there just moves on.
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._ask();
            }
        });
        // Two rows are the minimum a question can have; start there.
        this._addOptionRow();
        this._addOptionRow();
        el('quiz-compose')?.classList.remove('hidden');
        this._syncCompose();
    },

    _addOptionRow(focus = false) {
        const box = el('quiz-option-inputs');
        if (!box) return null;
        if (box.children.length >= MAX_OPTIONS) {
            toast(`حداکثر ${fa(MAX_OPTIONS)} گزینه مجاز است.`, 'warning');
            return null;
        }
        this._optionRows += 1;
        const row = document.createElement('div');
        row.className = 'quiz-option-input';

        const correct = document.createElement('input');
        correct.type = 'radio';
        correct.name = 'quiz-correct';
        correct.value = '';
        correct.className = 'quiz-correct-radio';
        correct.title = 'این گزینه صحیح است';
        correct.setAttribute('aria-label', 'این گزینه صحیح است');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'quiz-option-text';
        input.maxLength = 300;
        input.placeholder = `گزینهٔ ${fa(box.children.length + 1)}`;
        input.setAttribute('aria-label', `متن گزینهٔ ${fa(box.children.length + 1)}`);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'quiz-option-remove';
        remove.title = 'حذف گزینه';
        remove.setAttribute('aria-label', 'حذف گزینه');
        remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
        remove.addEventListener('click', () => {
            if (box.children.length <= MIN_OPTIONS) {
                toast('حداقل دو گزینه لازم است.', 'warning');
                return;
            }
            row.remove();
            this._syncCompose();
        });

        row.append(correct, input, remove);
        box.appendChild(row);
        this._syncCompose();
        if (focus) input.focus();
        return row;
    },

    _optionInputs() {
        return Array.from(document.querySelectorAll('#quiz-option-inputs .quiz-option-input'));
    },

    _syncCompose() {
        const rows = this._optionInputs();
        rows.forEach((row, index) => {
            row.querySelector('.quiz-option-text').placeholder = `گزینهٔ ${fa(index + 1)}`;
        });
        const count = el('quiz-option-count');
        if (count) count.textContent = `${fa(rows.length)} گزینه`;
        const add = el('quiz-add-option');
        if (add) add.disabled = rows.length >= MAX_OPTIONS;
    },

    _resetCompose() {
        const box = el('quiz-option-inputs');
        const text = el('quiz-new-text');
        if (text) text.value = '';
        if (!box) return;
        box.innerHTML = '';
        this._addOptionRow();
        this._addOptionRow();
        this._syncCompose();
    },

    async _ask() {
        const text = (el('quiz-new-text')?.value || '').trim();
        const rows = this._optionInputs();
        const options = rows.map((row) => (row.querySelector('.quiz-option-text')?.value || '').trim());
        const filled = options.filter(Boolean);
        if (!text) {
            toast('متن سوال را بنویسید.', 'warning');
            el('quiz-new-text')?.focus();
            return;
        }
        if (filled.length < MIN_OPTIONS) {
            toast('دست‌کم دو گزینه لازم است.', 'warning');
            return;
        }
        let correct = null;
        rows.forEach((row, index) => {
            if (row.querySelector('.quiz-correct-radio')?.checked) correct = index;
        });
        // Blank rows are dropped *before* numbering: a tick on option 3 must
        // still point at option 3 after the gaps are removed.
        const picked = options
            .map((optionText, index) => ({ text: optionText, correct: correct === index }))
            .filter((entry) => entry.text);
        const correctIndex = picked.findIndex((entry) => entry.correct);

        const btn = el('quiz-ask');
        if (btn) btn.disabled = true;
        try {
            await this.api('/quizzes/ask/', {
                text,
                options: picked.map((entry) => entry.text),
                correct: correctIndex >= 0 ? correctIndex : null,
            });
            this._resetCompose();
        } catch (err) {
            // api() already surfaced the server message; keep the draft intact.
        } finally {
            if (btn) btn.disabled = false;
        }
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
        this.stats = null;
        this.detail = null;
        this.statsMap = {};
        el('quiz-results')?.classList.add('hidden');
        el('quiz-results').innerHTML = '';
        el('quiz-question-body')?.classList.remove('hidden');
        const liveBox = el('quiz-live-stats');
        if (liveBox) liveBox.innerHTML = '';
        const dialogStats = el('quiz-question-stats');
        if (dialogStats) dialogStats.innerHTML = '';
        this._setActiveUI(true);
        el('quiz-live-pill')?.classList.remove('hidden');
        if (this.authority) {
            toast(`سوال «${payload.title}» مطرح شد.`, 'info');
            el('quiz-progress').textContent = 'در انتظار پاسخ شرکت‌کنندگان…';
        } else {
            toast(`سوال «${payload.title}» — پاسخ دهید.`, 'info');
            this._openModal();
            this._renderQuestion();
        }
    },

    handleProgress(payload) {
        if (payload.run_id !== this.runId) return;
        const line = `${fa(payload.answered_count)} از ${fa(payload.total_members)} نفر پاسخ داده‌اند`;
        const p = el('quiz-progress');
        if (p) p.textContent = line;
    },

    /**
     * Percentages for the questions the server decided this browser may see.
     *
     * A student receives a row only for a question they answered (the server
     * does not broadcast the numbers room-wide while the question is open), so
     * the map is always "what I already answered" — nothing to gate here.
     */
    handleStats(payload) {
        if (payload.run_id !== this.runId) return;
        this.stats = payload;
        this.mergeStats(payload.stats);
        this._paintStats({
            showWho: false,
            showCorrect: this.ended,
        });
    },

    /** Host-only: the whole picture, with the names below fifty people. */
    handleStatsDetail(payload) {
        if (payload.run_id !== this.runId) return;
        this.detail = payload;
        this.mergeStats(payload.stats);
        this._paintStats({
            showWho: Boolean(payload.show_who) && (this.privileged || this.authority),
            showCorrect: Boolean(payload.ended) || this.ended,
        });
    },

    /** Fold incoming rows into the map: a later frame only updates its own. */
    mergeStats(rows) {
        (rows || []).forEach((row) => {
            if (!row || row.id == null) return;
            const previous = this.statsMap[row.id];
            this.statsMap[row.id] = previous ? { ...previous, ...row } : row;
        });
    },

    /** Question order of the running quiz, for a stable panel. */
    _statRows() {
        const order = (this.quiz?.questions || []).map((q) => q.id);
        const rank = (id) => {
            const at = order.indexOf(id);
            return at === -1 ? order.length : at;
        };
        return Object.values(this.statsMap).sort((a, b) => rank(a.id) - rank(b.id));
    },

    _paintStats({ showWho = false, showCorrect = false } = {}) {
        const rows = this._statRows();
        const panel = el('quiz-live-stats');
        if (panel) {
            if (rows.length) this._renderStats(panel, rows, { showWho, showCorrect });
            else panel.innerHTML = '';
        }
        this._renderQuestionStats();
    },

    /** The bars under the options, inside the answering dialog. */
    _renderQuestionStats() {
        const box = el('quiz-question-stats');
        if (!box) return;
        const question = (this.quiz?.questions || [])[this.qIndex];
        const row = question ? this.statsMap[question.id] : null;
        if (!row) {
            box.innerHTML = '';
            return;
        }
        this._renderStats(box, [row], { showWho: false, showCorrect: this.ended });
    },

    handleEnded(payload) {
        if (payload.run_id !== this.runId) return;
        this.ended = true;
        this._setActiveUI(false);
        el('quiz-live-pill')?.classList.add('hidden');
        if (payload.stats) this.stats = payload;

        // The panel keeps the final numbers (percentages for everyone, names
        // for the host team in a small class) after the question closes.
        this.mergeStats(payload.stats);
        this._paintStats({
            showWho: Boolean(payload.show_who) && (this.privileged || this.authority),
            showCorrect: true,
        });
        const titleEl = el('quiz-active-title');
        if (titleEl && payload.title) titleEl.textContent = `نتایج: ${payload.title}`;
        const progress = el('quiz-progress');
        if (progress) {
            progress.textContent = `${fa(payload.class_size || 0)} نفر در کلاس — `
                + `${fa((payload.stats || []).reduce((sum, q) => sum + Number(q.total || 0), 0))} پاسخ ثبت شد.`;
        }
        el('quiz-active')?.classList.remove('hidden');
        el('quiz-end')?.classList.add('hidden');

        const results = payload.results || [];
        const box = el('quiz-results');
        box.classList.remove('hidden');
        box.innerHTML = '';

        const title = document.createElement('h3');
        title.textContent = `نتایج «${payload.title}»`;
        box.appendChild(title);

        const summary = document.createElement('p');
        summary.className = 'quiz-result-summary muted';
        const classSize = Number(payload.class_size || 0);
        summary.textContent = payload.show_who
            ? `${fa(classSize)} نفر در کلاس — پاسخ‌دهندگان هر گزینه مشخص شده‌اند.`
            : `${fa(classSize)} نفر در کلاس — برای حفظ حریم خصوصی فقط تعداد و درصد نمایش داده می‌شود.`;
        box.appendChild(summary);

        if (payload.stats) {
            const statsBox = document.createElement('div');
            statsBox.className = 'quiz-results-stats';
            this._renderStats(statsBox, payload.stats, {
                showWho: Boolean(payload.show_who) && this.privileged,
                showCorrect: true,
            });
            box.appendChild(statsBox);
        }

        const rows = this.privileged
            ? results
            : results.filter((r) => r.identity === this.identity);
        if (rows.length > 0) {
            const heading = document.createElement('h4');
            heading.className = 'quiz-results-heading';
            heading.textContent = 'کارنامه';
            box.appendChild(heading);
            const list = document.createElement('ul');
            list.className = 'quiz-result-list';
            rows.forEach((r, i) => {
                const li = document.createElement('li');
                const rank = document.createElement('span');
                rank.className = 'quiz-rank';
                rank.textContent = `${fa(i + 1)}.`;
                const name = document.createElement('span');
                name.textContent = r.name;
                const score = document.createElement('strong');
                score.textContent = `${fa(r.score)} از ${fa(r.max)}`;
                li.append(rank, name, score);
                list.appendChild(li);
            });
            box.appendChild(list);
        } else if (this.privileged) {
            const p = document.createElement('p');
            p.className = 'muted';
            p.textContent = 'پاسخی ثبت نشد.';
            box.appendChild(p);
        }

        // Show the results in the dialog — it is the surface nobody can miss,
        // and on a phone the side panel is behind the stage.
        el('quiz-question-body')?.classList.add('hidden');
        el('quiz-dialog-title').textContent = 'نتایج سوال';
        this._openModal();
    },

    // ------------------------------------------------------------ UI pieces
    /** Per-option bars: text, count, percentage and (hosts) the names. */
    _renderStats(container, stats, { showWho = false, showCorrect = false } = {}) {
        container.innerHTML = '';
        stats.forEach((question) => {
            const block = document.createElement('div');
            block.className = 'quiz-stat';

            const head = document.createElement('p');
            head.className = 'quiz-stat-q';
            head.textContent = question.text;
            const total = document.createElement('span');
            total.className = 'muted';
            total.textContent = ` · ${fa(question.total)} پاسخ`;
            head.appendChild(total);
            block.appendChild(head);

            const list = document.createElement('ul');
            list.className = 'quiz-stat-options';
            (question.options || []).forEach((option) => {
                const row = document.createElement('li');
                row.className = 'quiz-stat-row';
                if (showCorrect && option.is_correct) row.classList.add('is-correct');

                const line = document.createElement('div');
                line.className = 'quiz-stat-head';

                const text = document.createElement('span');
                text.className = 'quiz-stat-text';
                text.textContent = option.text;
                if (showCorrect && option.is_correct) {
                    const tick = document.createElement('span');
                    tick.className = 'quiz-correct-tag';
                    tick.textContent = 'صحیح';
                    text.appendChild(tick);
                }

                const num = document.createElement('span');
                num.className = 'quiz-stat-num';
                num.textContent = `${fa(option.percent)}٪ · ${fa(option.count)} نفر`;
                line.append(text, num);
                row.appendChild(line);

                const track = document.createElement('div');
                track.className = 'quiz-stat-track';
                const fill = document.createElement('div');
                fill.className = 'quiz-stat-fill';
                fill.style.width = `${Math.max(0, Math.min(100, Number(option.percent) || 0))}%`;
                track.appendChild(fill);
                row.appendChild(track);

                if (showWho && Array.isArray(option.who) && option.who.length) {
                    const who = document.createElement('p');
                    who.className = 'quiz-stat-who';
                    who.textContent = option.who.join('، ');
                    row.appendChild(who);
                }
                list.appendChild(row);
            });
            block.appendChild(list);
            container.appendChild(block);
        });
    },

    _setActiveUI(active) {
        el('quiz-active')?.classList.toggle('hidden', !active);
        const end = el('quiz-end');
        if (end) {
            end.classList.toggle('hidden', !active || !this.authority);
        }
        // The composer stays available while a question runs: a teacher often
        // follows up immediately, and the server closes the previous run.
        const compose = el('quiz-compose');
        if (compose) compose.classList.toggle('hidden', !this.authority);
        if (active) {
            const t = el('quiz-active-title');
            if (t && this.quiz) t.textContent = `در جریان: ${this.quiz.title}`;
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
        el('quiz-q-index').textContent = `پرسش ${fa(this.qIndex + 1)} از ${fa(qs.length)}`;
        el('quiz-q-points').textContent = q.points ? `${fa(q.points)} نمره` : '';
        el('quiz-question-text').textContent = q.text;
        el('quiz-progress-fill').style.width =
            `${Math.round(((this.qIndex + 1) / qs.length) * 100)}%`;
        const answeredAll = Object.keys(this.answers).length === qs.length;
        const answeredThis = this.answers[q.id] !== undefined;
        el('quiz-hint').textContent =
            answeredAll ? 'به همهٔ پرسش‌ها پاسخ داده‌اید ✓'
                : answeredThis
                    ? 'پاسخ شما ثبت شد ✓ — درصدها پایین همین صفحه به‌روز می‌شود.'
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
        this._renderQuestionStats();
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
        // Stay put: the percentages for the question just answered land right
        // below the options, and jumping away would hide them.  «پرسش بعد»
        // moves on when the reader is done looking.
        this._renderQuestion();
    },
};
