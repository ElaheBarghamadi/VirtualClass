/**
 * chat.js — real-time classroom chat client.
 *
 * Flow: browser → WebSocket → Django Channels (chat consumer) → DB + broadcast.
 * The server enforces permissions, who may read what, and message limits; this
 * module renders, submits, tracks unread counts and applies moderator
 * deletions.
 *
 * Who reads a message is the owner's decision (classroom.chat_private):
 *   • off — a student's message is public: every member of the class reads it;
 *   • on  — it is addressed to the host team and its author only, and nobody
 *     else receives the row at all (the server filters both the history and
 *     the live broadcast; this file could not reveal it even if it tried).
 * The switch belongs to the owner, so the panel shows a plain mode statement
 * for everybody and a small toggle only for the owner.
 *
 * Rendering rules (they are what makes a 330px panel readable):
 *   • a bubble belongs to whoever wrote it — others on the inline-start edge,
 *     your own on the inline-end edge (the mirror of a left-to-right app);
 *   • consecutive messages from one person collapse into a group, so a long
 *     back-and-forth does not repeat the name on every line;
 *   • a day divider separates «today» from yesterday's history;
 *   • a reply keeps one quoted line of the message it answers;
 *   • arrivals/leaves are quiet centred lines, never bubbles.
 */
import { toast } from './toast.js';

const MAX_LENGTH = 1000;
const COUNTER_FROM = 800;
const BOTTOM_SLACK = 90;          // px from the end that still counts as "at the bottom"
const GROUP_WINDOW = 5 * 60 * 1000; // same author within 5 min reads as one group

const MODE_TEXT = {
    public: {
        label: 'پیام‌ها برای همهٔ کلاس',
        hint: 'همهٔ اعضای کلاس این پیام‌ها را می‌بینند.',
    },
    private: {
        label: 'پیام‌ها فقط برای معلم',
        hint: 'پیام شما فقط برای معلم دیده می‌شود؛ همکلاسی‌ها آن را نمی‌بینند.',
    },
};
const PRIVATE_PLACEHOLDER = 'پیام شما فقط برای معلم…';

/** Stable, theme-agnostic avatar colour per participant. */
function avatarHue(seed) {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
        hash = (hash * 31 + seed.charCodeAt(i)) % 360;
    }
    return hash;
}

function initials(name) {
    const clean = (name || '?').trim();
    const first = clean.replace(/^(استاد|مهندس|دکتر|آقای|خانم)\s+/u, '');
    return (first[0] || '?').toUpperCase();
}

function faNum(value) {
    return Number(value).toLocaleString('fa-IR');
}

class ChatClientImpl {
    constructor() {
        this.ws = null;
        // Injected by room.js (`ChatClient.api = api`): the same JSON helper the
        // rest of the room uses, so CSRF, errors and toasts behave identically.
        this.api = async () => {};
        this.identity = null;
        this.privileged = false;
        this.messagesEl = document.getElementById('chat-messages');
        this.scrollEl = document.getElementById('chat-scroll');
        this.statusEl = document.getElementById('chat-status');
        this.formEl = document.getElementById('chat-form');
        this.inputEl = document.getElementById('chat-input');
        this.sendEl = document.getElementById('chat-send');
        this.unreadEl = document.getElementById('chat-unread');
        this.emptyEl = document.getElementById('chat-empty');
        this.jumpEl = document.getElementById('chat-jump');
        this.jumpTextEl = document.getElementById('chat-jump-text');
        this.countEl = document.getElementById('chat-count');
        this.offEl = document.getElementById('chat-off');
        this.offTextEl = document.getElementById('chat-off-text');
        this.replyEl = document.getElementById('chat-reply');
        this.replyNameEl = document.getElementById('chat-reply-name');
        this.replyTextEl = document.getElementById('chat-reply-text');
        this.replyCancelEl = document.getElementById('chat-reply-x');
        this.hintEl = document.getElementById('chat-channel-hint');
        this.modeBarEl = document.getElementById('chat-mode-bar');
        this.modeTextEl = document.getElementById('chat-mode-text');
        this.modeToggleEl = document.getElementById('chat-mode-toggle');
        this.retryDelay = 1000;
        this.roomCode = null;
        this.unread = 0;
        this.pendingNew = 0;
        // The server renders the truth into the page; start from it so the
        // first paint does not contradict the HTML.
        this.mode = document.getElementById('classroom-root')?.dataset.chatPrivate === '1'
            ? 'private'
            : 'public';
        this.messages = [];          // every message this member may read
        this.replyTo = null;         // { id, sender_name, message } while composing
        this._lastEntry = null;      // { identity, at } of the previous bubble
        this._lastDay = '';          // «2026-11-07» of the previous entry
        this.onStatusChange = () => {};
        this._canSend = true;        // permission, independent of the draft text
        this._formBound = false;
        this._scrollBound = false;
        // The panel may start on the chat tab with an empty history: show the
        // placeholder straight away instead of a blank white column.
        this.syncEmpty();
        this.syncComposer();
        this.syncMode();
    }

    /** Bring the newest message into view (used when the tab is opened). */
    jumpToLatest() {
        this.pendingNew = 0;
        this._scroll(true);
    }

    connect(roomCode, identity, privileged = false) {
        this.roomCode = roomCode;
        this.identity = identity;
        this.privileged = privileged;
        this.syncMode();
        // Never stack sockets: two open chat sockets would double every message.
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const sock = new WebSocket(`${proto}://${location.host}/ws/classroom/${roomCode}/chat/`);
        this.ws = sock;
        this._openedAt = Date.now();

        this.ws.onopen = () => {
            if (this.ws !== sock) return;
            this.retryDelay = 1000;
            this.statusEl?.classList.add('connected');
            this.onStatusChange('connected');
        };
        this.ws.onclose = (evt) => {
            if (this.ws !== sock) return;   // replaced by a reconnect: ignore
            this.statusEl?.classList.remove('connected');
            if (evt.code === 4401 || evt.code === 4403) {
                // The room/presence socket handles the user-facing redirect.
                // Never retry an authorization failure in a tight reconnect loop.
                this.onStatusChange('disconnected');
                return;
            }
            this.onStatusChange('reconnecting');
            // Current delay first, double afterwards: 1s before the 2s step.
            const delay = this.retryDelay;
            this.retryDelay = Math.min(this.retryDelay * 2, 15000);
            setTimeout(() => this.connect(roomCode, identity, privileged), delay);
        };
        this.ws.onmessage = (evt) => {
            if (this.ws !== sock) return;
            // A single malformed frame must not kill the handler for every
            // message that follows it.
            let data;
            try {
                data = JSON.parse(evt.data);
            } catch (err) {
                console.error('[chat] bad frame', err);
                return;
            }
            this.handle(data);
        };

        this._bindUi();
    }

    _bindUi() {
        if (!this._formBound) {
            this.formEl?.addEventListener('submit', (e) => {
                e.preventDefault();
                this.send(this.inputEl.value);
            });
            this.inputEl?.addEventListener('input', () => this.syncComposer());
            this.formEl?.addEventListener('keydown', (e) => {
                // Escape leaves reply mode without touching the draft.
                if (e.key === 'Escape' && this.replyTo) {
                    e.preventDefault();
                    this.cancelReply();
                    return;
                }
                // Enter sends; Shift+Enter stays available for multi-line input.
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.send(this.inputEl.value);
                }
            });
            this.replyCancelEl?.addEventListener('click', () => this.cancelReply());
            // Only the owner gets the switch; the server enforces the setting
            // anyway (``update_settings`` is owner-only).
            this.modeToggleEl?.addEventListener('click', () => {
                const next = this.mode !== 'private';
                this.modeToggleEl.disabled = true;
                this.api('/settings/', { settings: { chat_private: next } })
                    .catch(() => {})
                    .finally(() => { this.modeToggleEl.disabled = false; });
            });
            this._formBound = true;
        }
        if (!this._scrollBound) {
            this.scrollEl?.addEventListener('scroll', () => this.syncJump(), { passive: true });
            this.jumpEl?.addEventListener('click', () => {
                this.pendingNew = 0;
                this.syncJump();
                this._scroll(true);
                this.inputEl?.focus();
            });
            this._scrollBound = true;
        }
    }

    // ------------------------------------------------------------ chat mode
    /**
     * The owner decides whether student messages are public or staff-only.
     * Everything here is presentation: the consumer reads
     * ``classroom.chat_private`` from the database for every message.
     */
    setMode(isPrivate, { quiet = true } = {}) {
        const next = isPrivate ? 'private' : 'public';
        if (next === this.mode) {
            this.syncMode();
            return;
        }
        this.mode = next;
        // A reply must be re-evaluated: the same quote may now be private.
        if (this.replyTo) this.cancelReply();
        this.syncMode();
        if (!quiet) {
            toast(next === 'private'
                ? 'از این پس پیام دانش‌آموزان فقط برای شما دیده می‌شود.'
                : 'از این پس همهٔ کلاس پیام‌ها را می‌بیند.', 'info');
        }
    }

    syncMode() {
        const privateMode = this.mode === 'private';
        const text = MODE_TEXT[privateMode ? 'private' : 'public'];
        if (this.modeTextEl) this.modeTextEl.textContent = text.label;
        if (this.modeBarEl) this.modeBarEl.classList.toggle('is-private', privateMode);
        document.getElementById('panel-chat')
            ?.classList.toggle('is-private-view', privateMode);
        if (this.modeToggleEl) {
            this.modeToggleEl.setAttribute('aria-checked', String(privateMode));
            this.modeToggleEl.title = privateMode
                ? 'پیام دانش‌آموزان فقط برای میزبان — برای عمومی‌کردن بزنید'
                : 'پیام دانش‌آموزان برای همه — برای خصوصی‌کردن بزنید';
        }
        if (this.hintEl) {
            this.hintEl.textContent = text.hint;
            this.hintEl.classList.toggle('is-private', privateMode);
        }
        if (this.inputEl && !this.inputEl.disabled) {
            this.inputEl.placeholder = privateMode
                ? 'پیام شما فقط برای معلم…'
                : 'پیام خود را بنویسید…';
        }
        this.emptyEl?.classList.toggle('is-private', privateMode);
        const emptyTitle = this.emptyEl?.querySelector('.chat-empty-title');
        const emptyText = this.emptyEl?.querySelector('.chat-empty-text');
        if (emptyTitle) emptyTitle.textContent = 'هنوز پیامی نیست';
        if (emptyText) {
            emptyText.textContent = privateMode
                ? 'اولین پیام را بنویسید؛ فقط معلم آن را می‌بیند.'
                : 'اولین پیام را بفرستید تا گفتگوی کلاس شروع شود.';
        }
    }

    // ---------------------------------------------------------------- send
    send(text) {
        const message = (text || '').trim();
        if (!message) return;
        // Checked first: an offline socket can still claim to be OPEN, and a
        // message written into it disappears without a trace.
        if (navigator.onLine === false) {
            toast('اینترنت قطع است؛ پیام ارسال نشد.', 'warning');
            return;
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            // Swallowing the message silently is the worst option: the text
            // stays in the box so nothing is lost, and the user is told why.
            toast(
                navigator.onLine === false
                    ? 'اینترنت قطع است؛ پیام ارسال نشد.'
                    : 'اتصال گفتگو برقرار نیست؛ پیام ارسال نشد.',
                'warning',
            );
            return;
        }
        const payload = { action: 'send_message', message };
        if (this.replyTo) payload.reply_to = this.replyTo.id;
        this.ws.send(JSON.stringify(payload));
        this.inputEl.value = '';
        this.cancelReply();
        this.syncComposer();
    }

    /**
     * Reconnect now if the socket is not healthy.  Called when the network
     * comes back or the tab is shown again — no reason to sit out a backoff
     * that can be 15s long.
     */
    nudge(force = false) {
        if (!this.roomCode || !this.identity) return;
        const ready = this.ws?.readyState;
        if (!force) {
            // Chat is quiet by nature (no pings), so only the handshake window
            // is protected here — silence proves nothing on this socket.
            if (ready === WebSocket.OPEN) return;
            if (ready === WebSocket.CONNECTING && Date.now() - this._openedAt < 4000) return;
        }
        this.retryDelay = 1000;
        try { this.ws?.close(); } catch (err) { /* already gone */ }
        this.ws = null;
        this.connect(this.roomCode, this.identity, this.privileged);
    }

    deleteMessage(messageId) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ action: 'delete_message', message_id: messageId }));
        }
    }

    // --------------------------------------------------------------- reply
    startReply(message) {
        if (!message || message.is_deleted) return;
        this.replyTo = {
            id: message.id,
            sender_name: message.sender_identity === this.identity ? 'شما' : message.sender_name,
            message: message.message,
        };
        if (this.replyNameEl) this.replyNameEl.textContent = this.replyTo.sender_name;
        if (this.replyTextEl) this.replyTextEl.textContent = message.message.slice(0, 90);
        this.replyEl?.classList.remove('hidden');
        this.inputEl?.focus();
    }

    cancelReply() {
        this.replyTo = null;
        this.replyEl?.classList.add('hidden');
    }

    // -------------------------------------------------------------- events
    handle(data) {
        switch (data.type) {
            case 'chat_history':
                this.messages = Array.isArray(data.messages) ? data.messages.slice() : [];
                this.renderList();
                this.syncEmpty();
                this._scroll(true);
                break;
            case 'chat_message':
                this.receive(data.message);
                break;
            case 'chat_deleted':
                this.markDeleted(data.message_id);
                break;
            case 'reaction_summary':
                // Aggregated digest of quick reactions (ephemeral, no DB row).
                this.addSystemMessage(data.text);
                break;
            case 'error':
                toast(data.message, 'warning');
                break;
            default:
                break;
        }
    }

    /** One incoming message: store it and paint it (the server already
     *  decided this member is allowed to read it). */
    receive(m) {
        if (!m || m.id == null) return;
        if (this.messages.some((x) => x.id === m.id)) return;
        this.messages.push(m);
        this.renderMessage(m);
    }

    /** A fresh list replaces the panel: forget the grouping state with it. */
    renderList() {
        if (this.messagesEl) this.messagesEl.innerHTML = '';
        this._lastEntry = null;
        this._lastDay = '';
        this.messages.forEach((m) => this.renderMessage(m, { silent: true }));
        this.syncEmpty();
    }

    renderMessage(m, { silent = false } = {}) {
        if (!this.messagesEl) return;
        const own = m.sender_identity === this.identity;
        const at = new Date(m.created_at);
        const dayKey = `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;

        if (dayKey !== this._lastDay) {
            this.messagesEl.appendChild(this.buildDayDivider(at));
            this._lastDay = dayKey;
            this._lastEntry = null;
        }

        const grouped = !m.is_deleted && this._lastEntry
            && this._lastEntry.identity === m.sender_identity
            && (at.getTime() - this._lastEntry.at) < GROUP_WINDOW;

        const div = document.createElement('div');
        div.className = 'chat-msg';
        if (own) div.classList.add('own');
        if (grouped) div.classList.add('cont');
        if (m.is_deleted) div.classList.add('deleted');
        if (m.is_private) div.classList.add('private');
        div.dataset.messageId = String(m.id);
        div.dataset.sender = m.sender_identity || '';

        // Avatar: others only.  Own bubbles line up against the panel edge,
        // so an avatar there would just eat 34px of a 330px panel.
        if (!own) {
            const avatar = document.createElement('span');
            avatar.className = 'chat-avatar';
            if (grouped) avatar.classList.add('blank');
            else {
                avatar.textContent = initials(m.sender_name);
                avatar.style.setProperty('--av', `hsl(${avatarHue(m.sender_identity || m.sender_name || '?')} 58% 46%)`);
            }
            avatar.setAttribute('aria-hidden', 'true');
            div.appendChild(avatar);
        }

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';

        const timeText = at.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

        if (!grouped) {
            const head = document.createElement('div');
            head.className = 'chat-head';

            const sender = document.createElement('span');
            sender.className = 'chat-sender';
            sender.textContent = own ? 'شما' : m.sender_name;
            head.appendChild(sender);

            if (m.is_private) {
                const tag = document.createElement('span');
                tag.className = 'chat-priv-tag';
                tag.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
                    + '<rect x="4.5" y="10.5" width="15" height="9" rx="2"/>'
                    + '<path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/></svg>'
                    + '<span>خصوصی</span>';
                head.appendChild(tag);
            }

            const time = document.createElement('span');
            time.className = 'chat-time';
            time.textContent = timeText;
            time.title = at.toLocaleString('fa-IR');
            head.appendChild(time);

            if (!m.is_deleted) {
                const reply = document.createElement('button');
                reply.className = 'chat-action chat-reply-btn';
                reply.type = 'button';
                reply.title = 'پاسخ به این پیام';
                reply.setAttribute('aria-label', `پاسخ به پیام ${m.sender_name}`);
                reply.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
                    + '<path d="M9.6 6 4 11.6l5.6 5.6"/><path d="M4.3 11.6h9.1a6.2 6.2 0 0 1 6.2 6.2v.6"/></svg>';
                reply.addEventListener('click', () => this.startReply(m));
                head.appendChild(reply);
            }

            if (this.privileged && !own && !m.is_deleted) {
                const del = document.createElement('button');
                del.className = 'chat-action chat-delete';
                del.type = 'button';
                del.title = 'حذف پیام (مدیر)';
                del.setAttribute('aria-label', `حذف پیام ${m.sender_name}`);
                del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
                    + '<path d="M4.5 7h15"/><path d="M9.5 7V5.6A1.6 1.6 0 0 1 11.1 4h1.8a1.6 1.6 0 0 1 1.6 1.6V7"/>'
                    + '<path d="M6.6 7l.8 11.4A1.7 1.7 0 0 0 9.1 20h5.8a1.7 1.7 0 0 0 1.7-1.6L17.4 7"/></svg>';
                del.addEventListener('click', () => this.deleteMessage(m.id));
                head.appendChild(del);
            }
            bubble.appendChild(head);
        }

        if (m.reply_to) bubble.appendChild(this.buildQuote(m.reply_to));

        const body = document.createElement('p');
        body.className = 'chat-body';
        if (m.is_deleted) {
            body.textContent = '— پیام حذف شده —';
        } else {
            body.textContent = m.message;
        }
        bubble.appendChild(body);

        if (grouped) {
            // The collapsed line still says when it was sent.
            div.title = timeText;
        }

        div.appendChild(bubble);
        this.messagesEl.appendChild(div);
        this.syncEmpty();
        // Grouping state is bookkeeping, not presentation: history replays
        // need it too, or every replayed line would open a new group.
        this._lastEntry = { identity: m.sender_identity, at: at.getTime() };

        if (!silent) {
            if (!own && !this.isChatVisible()) {
                this.unread += 1;
                this.unreadEl.textContent = faNum(this.unread);
                this.unreadEl.classList.remove('hidden');
                // the tab strip may be collapsed — the control-bar button has
                // to be able to say "there is something to read" on its own
                document.getElementById('btn-chat')?.classList.add('has-unread');
            }
            const atBottom = this._atBottom();
            if (!atBottom && !own) this.pendingNew += 1;
            this._scroll(own || atBottom);
            if (!own) this.syncJump();
        }
    }

    /** The quoted strip inside a reply bubble. */
    buildQuote(quoted) {
        const box = document.createElement('div');
        box.className = 'chat-quote';
        if (quoted.is_deleted) box.classList.add('is-deleted');
        const name = document.createElement('span');
        name.className = 'chat-quote-name';
        name.textContent = quoted.sender_name || '?';
        const text = document.createElement('span');
        text.className = 'chat-quote-text';
        text.textContent = quoted.is_deleted ? 'پیام حذف شده' : (quoted.message || '');
        box.append(name, text);
        box.title = quoted.is_deleted ? 'پیام حذف شده' : (quoted.message || '');
        return box;
    }

    /** A «امروز / دیروز / ۱۵ آبان» divider between two days of history. */
    buildDayDivider(date) {
        const el = document.createElement('div');
        el.className = 'chat-day';
        el.setAttribute('role', 'separator');

        const today = new Date();
        const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const diffDays = Math.round((startOf(today) - startOf(date)) / 86400000);
        let label;
        if (diffDays === 0) label = 'امروز';
        else if (diffDays === 1) label = 'دیروز';
        else label = date.toLocaleDateString('fa-IR', { day: 'numeric', month: 'long' });

        const span = document.createElement('span');
        span.textContent = label;
        el.appendChild(span);
        return el;
    }

    markDeleted(messageId) {
        const id = Number(messageId);
        const stored = this.messages.find((m) => m.id === id);
        if (stored) stored.is_deleted = true;
        const div = this.messagesEl?.querySelector(`[data-message-id="${messageId}"]`);
        if (!div) return;
        if (!div.classList.contains('deleted')) {
            div.classList.add('deleted');
            const body = div.querySelector('.chat-body');
            if (body) body.textContent = '— پیام حذف شده —';
        }
        div.querySelector('.chat-delete')?.remove();
    }

    /** True only when the chat panel is actually on screen right now. */
    isChatVisible() {
        const panel = document.getElementById('panel-chat');
        if (!panel || !panel.classList.contains('active')) return false;
        const side = document.getElementById('room-side');
        if (window.matchMedia('(max-width: 900px)').matches) {
            return side?.classList.contains('drawer-open') ?? false;
        }
        return !document.getElementById('room-body')?.classList.contains('side-closed');
    }

    resetUnread() {
        this.unread = 0;
        this.unreadEl?.classList.add('hidden');
        if (this.unreadEl) this.unreadEl.textContent = faNum(0);
        document.getElementById('btn-chat')?.classList.remove('has-unread');
    }

    addSystemMessage(text) {
        if (!this.messagesEl || !text) return;
        const dayKey = this._dayKey(new Date());
        if (dayKey !== this._lastDay) {
            this.messagesEl.appendChild(this.buildDayDivider(new Date()));
            this._lastDay = dayKey;
            this._lastEntry = null;
        }
        const div = document.createElement('div');
        div.className = 'chat-msg system';
        div.textContent = text;
        this.messagesEl.appendChild(div);
        // A join/leave line ends the current group.
        this._lastEntry = null;
        this.syncEmpty();
        if (!this._atBottom()) this.pendingNew += 1;
        this._scroll(this._atBottom());
    }

    _dayKey(date) {
        return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    }

    /** The friendly placeholder replaces an unexplained white void. */
    syncEmpty() {
        if (!this.emptyEl) return;
        const hasEntries = (this.messagesEl?.childElementCount || 0) > 0;
        this.emptyEl.classList.toggle('hidden', hasEntries);
    }

    /** Composer state: the send button only lights up for a real draft. */
    syncComposer() {
        if (!this.inputEl) return;
        // An always-clickable send button that silently ignores empty input is
        // the classic "dead button"; disable it until there is something to send.
        if (this.sendEl) this.sendEl.disabled = !this._canSend || !this.inputEl.value.trim();
        if (!this.countEl) return;
        const used = this.inputEl.value.length;
        if (used < COUNTER_FROM) {
            this.countEl.classList.add('hidden');
            return;
        }
        this.countEl.classList.remove('hidden');
        this.countEl.textContent = `${faNum(used)}/${faNum(MAX_LENGTH)}`;
        this.countEl.classList.toggle('near-limit', used >= MAX_LENGTH);
    }

    /** "new messages" chip above the composer while the reader is behind. */
    syncJump() {
        if (!this.jumpEl) return;
        const behind = !this._atBottom();
        this.jumpEl.classList.toggle('hidden', !behind);
        if (this.jumpTextEl) {
            this.jumpTextEl.textContent = this.pendingNew > 0
                ? `${faNum(this.pendingNew)} پیام جدید`
                : 'آخرین پیام‌ها';
        }
        this.jumpEl.classList.toggle('has-new', this.pendingNew > 0);
    }

    _atBottom() {
        const el = this.scrollEl;
        if (!el) return true;
        return (el.scrollHeight - el.scrollTop - el.clientHeight) < BOTTOM_SLACK;
    }

    setSendEnabled(enabled, reason = '') {
        this._canSend = enabled;
        if (this.inputEl) {
            this.inputEl.disabled = !enabled;
            this.inputEl.placeholder = enabled
                ? (this.mode === 'private' ? PRIVATE_PLACEHOLDER : 'پیام خود را بنویسید…')
                : (reason || 'ارسال پیام بسته است.');
        }
        this.syncComposer();
        if (this.offEl) {
            this.offEl.classList.toggle('hidden', enabled);
            if (this.offTextEl && reason) this.offTextEl.textContent = reason;
        }
    }

    _scroll(force = true) {
        if (!this.scrollEl || !force) return;
        this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
        this.pendingNew = 0;
        this.syncJump();
    }
}

export const ChatClient = new ChatClientImpl();
