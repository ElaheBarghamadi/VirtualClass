/**
 * room.js — classroom room controller (vanilla JS, ES modules).
 *
 * Responsibilities:
 *  - presence WebSocket (/ws/classroom/<code>/) → participant list
 *  - wire the control bar (placeholders for WebRTC features)
 *  - switch between video stage and whiteboard stage
 *  - clock
 *
 * Media (audio/video/screen) will be handled by webrtc.js in a later
 * phase; this file intentionally only deals with lightweight events.
 */
import { ChatClient } from './chat.js';
import { Whiteboard } from './whiteboard.js';
import { WebRTCManager } from './webrtc.js';

const root = document.getElementById('classroom-root');
const ROOM_CODE = root.dataset.roomCode;
const CURRENT_USER_ID = Number(root.dataset.userId);
const PERMISSIONS = JSON.parse(document.getElementById('member-permissions').textContent);

// ---------------------------------------------------------------------------
// Presence WebSocket
// ---------------------------------------------------------------------------
class PresenceClient {
    constructor() {
        this.ws = null;
        this.retryDelay = 1000;
        this.listEl = document.getElementById('participant-list');
        this.countEl = document.getElementById('participant-count');
    }

    connect() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${location.host}/ws/classroom/${ROOM_CODE}/`);
        this.ws.onopen = () => { this.retryDelay = 1000; };
        this.ws.onmessage = (evt) => this.handle(JSON.parse(evt.data));
        this.ws.onclose = () => setTimeout(() => this.connect(), this.retryDelay = Math.min(this.retryDelay * 2, 15000));
    }

    handle(data) {
        switch (data.type) {
            case 'participant_list':
                this.renderList(data.participants);
                break;
            case 'user_joined':
                ChatClient.addSystemMessage(`${data.participant.name} به کلاس پیوست.`);
                break;
            case 'user_left':
                this.removeParticipant(data.participant.user_id);
                ChatClient.addSystemMessage(`${data.participant.name} کلاس را ترک کرد.`);
                break;
            case 'pong':
                break;
        }
    }

    renderList(participants) {
        this.listEl.innerHTML = '';
        participants.forEach((p) => this.listEl.appendChild(this.renderRow(p)));
        this.updateCount();
    }

    renderRow(p) {
        const li = document.createElement('li');
        li.className = 'participant';
        li.dataset.userId = String(p.user_id);

        const avatar = document.createElement('span');
        avatar.className = 'participant-avatar';
        avatar.textContent = (p.name || '?').charAt(0);

        const name = document.createElement('span');
        name.className = 'participant-name';
        name.textContent = p.user_id === CURRENT_USER_ID ? `${p.name} (شما)` : p.name;

        const role = document.createElement('span');
        role.className = 'participant-role';
        role.textContent = p.role_label;

        // State icons — driven by future WebRTC events.
        const states = document.createElement('span');
        states.className = 'participant-states';
        states.innerHTML = `
            <i data-state="mic" title="میکروفون">🎤</i>
            <i data-state="camera" title="دوربین">📹</i>
            <i data-state="hand" title="دست بالا">✋</i>`;
        setStates(li, p);

        li.append(avatar, name, role, states);
        return li;
    }

    removeParticipant(userId) {
        const row = this.listEl.querySelector(`[data-user-id="${userId}"]`);
        if (row) row.remove();
        this.updateCount();
    }

    updateCount() {
        this.countEl.textContent = String(this.listEl.children.length);
    }
}

function setStates(rowEl, p) {
    const map = { mic: p.mic_on, camera: p.camera_on, hand: p.hand_raised };
    for (const [state, on] of Object.entries(map)) {
        const icon = rowEl.querySelector(`i[data-state="${state}"]`);
        if (icon) icon.classList.toggle('on', Boolean(on));
    }
}

// ---------------------------------------------------------------------------
// Control bar (UI placeholders — real enforcement is server-side)
// ---------------------------------------------------------------------------
function initControls() {
    const bind = (id, handler) => document.getElementById(id)?.addEventListener('click', handler);

    bind('btn-mic', (e) => {
        if (!PERMISSIONS.can_use_microphone) return notify('شما اجازه استفاده از میکروفون را ندارید.');
        e.currentTarget.classList.toggle('active');
        // Phase 2: webrtc.toggleMicrophone()
    });
    bind('btn-camera', (e) => {
        if (!PERMISSIONS.can_use_camera) return notify('شما اجازه استفاده از دوربین را ندارید.');
        e.currentTarget.classList.toggle('active');
        // Phase 2: webrtc.toggleCamera()
    });
    bind('btn-screen', (e) => {
        if (!PERMISSIONS.can_share_screen) return notify('شما اجازه اشتراک صفحه را ندارید.');
        notify('اشتراک صفحه در فاز بعدی فعال می‌شود.');
    });
    bind('btn-hand', (e) => {
        if (!PERMISSIONS.can_raise_hand) return notify('شما اجازه بالا بردن دست را ندارید.');
        e.currentTarget.classList.toggle('active');
    });
    bind('btn-chat', () => document.getElementById('chat-input')?.focus());
    bind('btn-exit', () => document.getElementById('chat-form')?.closest('.room')
        .querySelector('form[action*="/leave/"]').submit());

    const wbStage = document.getElementById('whiteboard-stage');
    const videoStage = document.getElementById('video-stage');
    bind('btn-whiteboard', (e) => {
        if (!PERMISSIONS.can_use_whiteboard) return notify('شما اجازه استفاده از تخته سفید را ندارید.');
        const showing = !wbStage.classList.contains('hidden');
        wbStage.classList.toggle('hidden', showing);
        videoStage.classList.toggle('hidden', !showing);
        e.currentTarget.classList.toggle('active', !showing);
        if (!showing) Whiteboard.resize();
    });
}

function notify(text) {
    ChatClient.addSystemMessage(text);
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------
function initClock() {
    const el = document.getElementById('room-clock');
    const tick = () => {
        el.textContent = new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
    };
    tick();
    setInterval(tick, 30_000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const presence = new PresenceClient();
presence.connect();
ChatClient.connect(ROOM_CODE, CURRENT_USER_ID);
Whiteboard.init();
WebRTCManager.init({ permissions: PERMISSIONS }); // no-op in this phase
initControls();
initClock();
