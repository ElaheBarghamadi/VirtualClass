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
    }

    connect(roomCode, identity, privileged = false) {
        this.roomCode = roomCode;
        this.identity = identity;
        this.privileged = privileged;
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${location.host}/ws/classroom/${roomCode}/chat/`);

        this.ws.onopen = () => {
            this.retryDelay = 1000;
            this.statusEl?.classList.add('connected');
            this.onStatusChange('connected');
        };
        this.ws.onclose = () => {
            this.statusEl?.classList.remove('connected');
            this.onStatusChange('reconnecting');
            setTimeout(() => this.connect(roomCode, identity, privileged), this.retryDelay = Math.min(this.retryDelay * 2, 15000));
        };
        this.ws.onmessage = (evt) => this.handle(JSON.parse(evt.data));

        this.formEl?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.send(this.inputEl.value);
        });
    }

    send(text) {
        const message = (text || '').trim();
        if (!message || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ action: 'send_message', message }));
        this.inputEl.value = '';
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
                del.textContent = '🗑';
                del.addEventListener('click', () => this.deleteMessage(m.id));
                head.appendChild(del);
            }
        }

        div.append(head, body);
        this.messagesEl.appendChild(div);

        if (!silent && !own) {
            const chatTab = document.querySelector('[data-tab="chat"]');
            const panelVisible = document.getElementById('panel-chat')?.classList.contains('active');
            if (!panelVisible || document.hidden) {
                this.unread += 1;
                this.unreadEl.textContent = String(this.unread);
                this.unreadEl.classList.remove('hidden');
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

    resetUnread() {
        this.unread = 0;
        this.unreadEl?.classList.add('hidden');
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
