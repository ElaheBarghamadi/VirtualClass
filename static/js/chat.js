/**
 * chat.js — real-time classroom chat client.
 *
 * Flow: browser → WebSocket → Django Channels (chat consumer) → DB + broadcast.
 * The server enforces permissions and message limits; this module only
 * renders and submits.
 */
class ChatClientImpl {
    constructor() {
        this.ws = null;
        this.userId = null;
        this.messagesEl = document.getElementById('chat-messages');
        this.statusEl = document.getElementById('chat-status');
        this.formEl = document.getElementById('chat-form');
        this.inputEl = document.getElementById('chat-input');
        this.retryDelay = 1000;
    }

    connect(roomCode, userId) {
        this.userId = userId;
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${location.host}/ws/classroom/${roomCode}/chat/`);

        this.ws.onopen = () => {
            this.retryDelay = 1000;
            this.statusEl?.classList.add('connected');
        };
        this.ws.onclose = () => {
            this.statusEl?.classList.remove('connected');
            setTimeout(() => this.connect(roomCode, userId), this.retryDelay = Math.min(this.retryDelay * 2, 15000));
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

    handle(data) {
        switch (data.type) {
            case 'chat_history':
                this.messagesEl.innerHTML = '';
                data.messages.forEach((m) => this.renderMessage(m));
                break;
            case 'chat_message':
                this.renderMessage(data.message);
                break;
            case 'error':
                this.addSystemMessage(data.message);
                break;
        }
    }

    renderMessage(m) {
        const div = document.createElement('div');
        div.className = 'chat-msg' + (m.sender_id === this.userId ? ' own' : '');

        const sender = document.createElement('span');
        sender.className = 'chat-sender';
        sender.textContent = m.sender_name;

        const body = document.createElement('span');
        body.textContent = m.message;

        const time = document.createElement('span');
        time.className = 'chat-time';
        time.textContent = new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });

        div.append(sender, body, time);
        this.messagesEl.appendChild(div);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }

    addSystemMessage(text) {
        const div = document.createElement('div');
        div.className = 'chat-msg system';
        div.textContent = text;
        this.messagesEl?.appendChild(div);
        if (this.messagesEl) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
}

export const ChatClient = new ChatClientImpl();
