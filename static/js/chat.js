/**
 * chat.js — real-time classroom chat client.
 *
 * Flow: browser → WebSocket → Django Channels (chat consumer) → DB + broadcast.
 * The server enforces permissions and message limits; this module renders,
 * submits, tracks unread counts and applies moderator deletions.
 */
import { toast } from './toast.js';

class ChatClientImpl {
    constructor() {
        this.ws = null;
        this.identity = null;
        this.privileged = false;
        this.messagesEl = document.getElementById('chat-messages');
        this.statusEl = document.getElementById('chat-status');
        this.formEl = document.getElementById('chat-form');
        this.inputEl = document.getElementById('chat-input');
        this.unreadEl = document.getElementById('chat-unread');
        this.retryDelay = 1000;
        this.roomCode = null;
        this.unread = 0;
        this.onStatusChange = () => {};
        this._formBound = false;
    }

    connect(roomCode, identity, privileged = false) {
        this.roomCode = roomCode;
        this.identity = identity;
        this.privileged = privileged;
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

        if (!this._formBound) {
            this.formEl?.addEventListener('submit', (e) => {
                e.preventDefault();
                this.send(this.inputEl.value);
            });
            this._formBound = true;
        }
    }

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
        this.ws.send(JSON.stringify({ action: 'send_message', message }));
        this.inputEl.value = '';
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

    handle(data) {
        switch (data.type) {
            case 'chat_history':
                this.messagesEl.innerHTML = '';
                data.messages.forEach((m) => this.renderMessage(m, { silent: true }));
                this._scroll();
                break;
            case 'chat_message':
                this.renderMessage(data.message);
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
        }
    }

    renderMessage(m, { silent = false } = {}) {
        const own = m.sender_identity === this.identity;
        const div = document.createElement('div');
        div.className = 'chat-msg' + (own ? ' own' : '');
        div.dataset.messageId = String(m.id);

        const head = document.createElement('div');
        head.className = 'chat-head';

        const sender = document.createElement('span');
        sender.className = 'chat-sender';
        sender.textContent = m.sender_name;

        const time = document.createElement('span');
        time.className = 'chat-time';
        time.textContent = new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

        head.append(sender, time);

        const body = document.createElement('p');
        body.className = 'chat-body';
        if (m.is_deleted) {
            div.classList.add('deleted');
            body.textContent = '— پیام حذف شده —';
        } else {
            body.textContent = m.message;
            if (this.privileged && !own) {
                const del = document.createElement('button');
                del.className = 'chat-delete';
                del.title = 'حذف پیام (مدیر)';
                del.setAttribute('aria-label', 'حذف پیام');
                del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
                    + '<path d="M4.5 7h15"/><path d="M9.5 7V5.6A1.6 1.6 0 0 1 11.1 4h1.8a1.6 1.6 0 0 1 1.6 1.6V7"/>'
                    + '<path d="M6.6 7l.8 11.4A1.7 1.7 0 0 0 9.1 20h5.8a1.7 1.7 0 0 0 1.7-1.6L17.4 7"/></svg>';
                del.addEventListener('click', () => this.deleteMessage(m.id));
                head.appendChild(del);
            }
        }

        div.append(head, body);
        this.messagesEl.appendChild(div);

        if (!silent && !own) {
            // The panel can be "active" yet out of sight: the docked rail may be
            // collapsed or the phone drawer closed. Ask for real visibility.
            const panelVisible = this.isChatVisible();
            if (!panelVisible || document.hidden) {
                this.unread += 1;
                this.unreadEl.textContent = String(this.unread);
                this.unreadEl.classList.remove('hidden');
                // the tab strip may be collapsed — the control-bar button has
                // to be able to say "there is something to read" on its own
                document.getElementById('btn-chat')?.classList.add('has-unread');
            }
        }
        this._scroll();
    }

    markDeleted(messageId) {
        const div = this.messagesEl.querySelector(`[data-message-id="${messageId}"]`);
        if (!div || div.classList.contains('deleted')) return;
        div.classList.add('deleted');
        const body = div.querySelector('.chat-body');
        if (body) body.textContent = '— پیام حذف شده —';
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
        document.getElementById('btn-chat')?.classList.remove('has-unread');
    }

    addSystemMessage(text) {
        const div = document.createElement('div');
        div.className = 'chat-msg system';
        div.textContent = text;
        this.messagesEl?.appendChild(div);
        this._scroll();
    }

    setSendEnabled(enabled, reason = '') {
        if (this.inputEl) this.inputEl.disabled = !enabled;
        if (this.inputEl) this.inputEl.placeholder = enabled ? 'پیام خود را بنویسید…' : reason;
    }

    _scroll() {
        if (this.messagesEl) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
}

export const ChatClient = new ChatClientImpl();
