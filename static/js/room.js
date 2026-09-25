/**
 * room.js — classroom orchestrator.
 *
 * Owns: the presence WebSocket (+connection status/reconnection), the
 * roster with search/filters and host controls, tab & drawer UI, the
 * control bar (permission-gated, server remains authoritative), files,
 * presentation, settings modal, sessions, notifications (toasts) and
 * integration with media.js / chat.js / whiteboard.js.
 */
import { ChatClient } from './chat.js';
import { Whiteboard } from './whiteboard.js';
import { Media } from './media.js';
import { toast, confirmAction } from './toast.js';

const root = document.getElementById('classroom-root');
const ROOM_CODE = root.dataset.roomCode;
const USER_ID = Number(root.dataset.userId);
const MEMBER_ID = Number(root.dataset.memberId);
const PRIVILEGED = root.dataset.privileged === '1';
const MEDIA_ENABLED = root.dataset.mediaEnabled === '1';
const MEDIA_URL = root.dataset.mediaUrl;
const PERMISSIONS = JSON.parse(document.getElementById('member-permissions').textContent);

const csrfToken = document.querySelector('[name=csrfmiddlewaretoken]')?.value
    || document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';

// ---------------------------------------------------------------------------
// API helper (CSRF-protected JSON POSTs — server re-checks every action)
// ---------------------------------------------------------------------------
async function api(path, body = {}) {
    const res = await fetch(`/class/${ROOM_CODE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRFToken': csrfToken,
            'X-Requested-With': 'fetch',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        let detail = 'عملیات ناموفق بود.';
        try { detail = (await res.json()).detail || detail; } catch (e) { /* keep default */ }
        toast(detail, 'error');
        throw new Error(detail);
    }
    return res.json();
}

// ---------------------------------------------------------------------------
// Presence WebSocket + connection status
// ---------------------------------------------------------------------------
class PresenceClient {
    constructor() {
        this.ws = null;
        this.retryDelay = 1000;
        this.state = 'connecting';
        this.el = document.getElementById('conn-status');
        this.listEl = document.getElementById('participant-list');
        this.countEl = document.getElementById('participant-count');
        this.waitingEl = document.getElementById('waiting-list');
        this.participants = new Map();  // user_id → participant payload
        this.searchTerm = '';
        this.filter = 'ALL';
    }

    connect() {
        this.setStatus(this.ws ? 'reconnecting' : 'connecting');
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${location.host}/ws/classroom/${ROOM_CODE}/`);
        this.ws.onopen = () => { this.retryDelay = 1000; this.setStatus('connected'); };
        this.ws.onmessage = (evt) => handleEvent(JSON.parse(evt.data));
        this.ws.onclose = (evt) => {
            if (evt.code === 4403) { toast('دسترسی شما به کلاس قطع شده است.', 'error'); return; }
            this.setStatus('reconnecting');
            setTimeout(() => this.connect(), this.retryDelay = Math.min(this.retryDelay * 2, 15000));
        };
    }

    send(payload) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
    }

    setStatus(state) {
        this.state = state;
        const map = {
            connected: ['connected', 'متصل'],
            connecting: ['', 'در حال اتصال…'],
            reconnecting: ['reconnecting', 'در حال اتصال مجدد…'],
            lost: ['lost', 'قطع شده'],
        };
        const [cls, text] = map[state] || map.connecting;
        this.el.className = `conn-pill ${cls}`;
        this.el.querySelector('.conn-text').textContent = text;
    }

    // ------------------------------------------------------------ roster
    upsert(p) {
        this.participants.set(p.user_id, { ...(this.participants.get(p.user_id) || {}), ...p });
        this.render();
    }

    remove(userId) {
        this.participants.delete(userId);
        this.render();
    }

    render() {
        const all = Array.from(this.participants.values());
        const inRoom = all.filter((p) => !p.in_waiting_room);
        const waiting = all.filter((p) => p.in_waiting_room);

        // Sort: hands raised first, then role rank, then join time.
        const roleRank = { OWNER: 0, MODERATOR: 1, PRESENTER: 2, STUDENT: 3 };
        inRoom.sort((a, b) =>
            (b.hand_raised ? 1 : 0) - (a.hand_raised ? 1 : 0)
            || (roleRank[a.role] ?? 9) - (roleRank[b.role] ?? 9)
            || String(a.joined_at).localeCompare(String(b.joined_at)));

        this.listEl.innerHTML = '';
        for (const p of inRoom) {
            if (this._matches(p)) this.listEl.appendChild(this._row(p));
        }
        this.countEl.textContent = String(inRoom.length);

        // Waiting room section (privileged only).
        const section = document.getElementById('waiting-section');
        if (PRIVILEGED && waiting.length) {
            section.classList.remove('hidden');
            document.getElementById('waiting-count').textContent = String(waiting.length);
            this.waitingEl.innerHTML = '';
            for (const p of waiting) this.waitingEl.appendChild(this._waitingRow(p));
        } else {
            section.classList.add('hidden');
        }

        // Raised-hand pill.
        const hands = inRoom.filter((p) => p.hand_raised).length;
        document.getElementById('hand-pill').classList.toggle('hidden', hands === 0);
        document.getElementById('hand-count').textContent = String(hands);
    }

    _matches(p) {
        if (this.searchTerm && !p.name?.toLowerCase().includes(this.searchTerm)) return false;
        switch (this.filter) {
            case 'HAND': return p.hand_raised;
            case 'MUTED': return p.muted;
            case 'ALL': return true;
            default: return p.role === this.filter;
        }
    }

    _row(p) {
        const li = document.createElement('li');
        li.className = 'participant';
        li.dataset.userId = String(p.user_id);

        li.innerHTML = `
            <span class="participant-avatar">${(p.name || '?').charAt(0)}</span>
            <span class="participant-name"></span>
            <span class="participant-role">${p.role_label || ''}</span>
            <span class="participant-states" aria-hidden="true">
                <i class="s-hand ${p.hand_raised ? 'on' : ''}" title="دست بالا">✋</i>
                <i class="s-mic ${p.mic_on === false ? 'off' : ''}" title="میکروفون">🎤</i>
                <i class="s-camera ${p.camera_on === false ? 'off' : ''}" title="دوربین">📹</i>
                <i class="s-muted ${p.muted ? 'on' : ''}" title="بی‌صدا توسط مدیر">🔇</i>
            </span>`;
        li.querySelector('.participant-name').textContent =
            p.user_id === USER_ID ? `${p.name} (شما)` : p.name;

        if (PRIVILEGED && p.user_id !== USER_ID && p.role !== 'OWNER') {
            li.appendChild(this._hostControls(p));
        }
        return li;
    }

    _hostControls(p) {
        const box = document.createElement('div');
        box.className = 'host-controls';

        const btn = (title, label, fn) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'hc-btn';
            b.title = title;
            b.setAttribute('aria-label', `${title} — ${p.name}`);
            b.textContent = label;
            b.addEventListener('click', fn);
            return b;
        };

        box.append(
            btn(p.muted ? 'باصدا کردن' : 'بی‌صدا کردن', p.muted ? '🔊' : '🔇', () =>
                api(`/members/${p.member_id}/mute/`, { muted: !p.muted })),
            btn('درخواست روشن کردن میکروفون', '🎙️', () =>
                api(`/members/${p.member_id}/mute/`, { request_unmute: true })),
            btn('دسترسی دوربین', '📹', () =>
                api(`/members/${p.member_id}/permission/`, { permission: 'can_use_camera', value: false })),
            btn('ارتقا به ارائه‌دهنده', '🧑‍🏫', () =>
                api(`/members/${p.member_id}/role/`, { role: 'PRESENTER' })),
            btn('ارتقا به مدیر', '🛡️', () =>
                api(`/members/${p.member_id}/role/`, { role: 'MODERATOR' })),
        );

        const rm = btn('حذف از کلاس', '🚫', async () => {
            if (!confirmAction(`${p.name} از کلاس حذف شود؟`)) return;
            const ban = confirmAction('ورود مجدد او ۵ دقیقه مسدود شود؟');
            await api(`/members/${p.member_id}/remove/`, { ban_minutes: ban ? 5 : 0 });
        });
        rm.classList.add('danger');
        box.appendChild(rm);
        return box;
    }

    _waitingRow(p) {
        const li = document.createElement('li');
        li.className = 'participant waiting';
        li.innerHTML = `
            <span class="participant-avatar">⏳</span>
            <span class="participant-name"></span>
            <button type="button" class="btn btn-sm btn-primary">تأیید</button>
            <button type="button" class="btn btn-sm btn-ghost">رد</button>`;
        li.querySelector('.participant-name').textContent = p.name;
        const [approve, deny] = li.querySelectorAll('button');
        approve.addEventListener('click', () => api(`/members/${p.member_id}/waiting/`, { approve: true }));
        deny.addEventListener('click', () => {
            if (confirmAction(`درخواست ${p.name} رد شود؟`)) {
                api(`/members/${p.member_id}/waiting/`, { approve: false });
            }
        });
        return li;
    }
}

const presence = new PresenceClient();

// ---------------------------------------------------------------------------
// Event router — one consistent server protocol
// ---------------------------------------------------------------------------
function handleEvent(data) {
    switch (data.type) {
        case 'participant_list':
            presence.participants.clear();
            data.participants.forEach((p) => presence.participants.set(p.user_id, p));
            presence.render();
            applyClassroomState(data.classroom || {});
            break;
        case 'user_joined':
            presence.upsert(data.participant);
            if (data.participant.user_id !== USER_ID) {
                ChatClient.addSystemMessage(`${data.participant.name} به کلاس پیوست.`);
            }
            break;
        case 'user_left':
            presence.remove(data.participant.user_id);
            ChatClient.addSystemMessage(`${data.participant.name} کلاس را ترک کرد.`);
            break;
        case 'raise_hand':
        case 'lower_hand':
            presence.upsert(data.participant);
            if (data.type === 'raise_hand' && data.participant.user_id !== USER_ID) {
                toast(`✋ ${data.participant.name} دست خود را بالا برد.`, 'info', 2500);
            }
            break;
        case 'media_state':
            presence.upsert(data.participant);
            break;
        case 'permission_changed':
            if (data.user_id === USER_ID) {
                PERMISSIONS[data.permission] = data.value;
                Whiteboard.setPermission(PERMISSIONS.can_use_whiteboard);
                refreshControlStates();
            }
            break;
        case 'role_changed':
            if (data.user_id === USER_ID) {
                toast(data.text || 'نقش شما تغییر کرد.', 'success');
                setTimeout(() => location.reload(), 1200); // re-render privileges
            } else {
                presence.upsert({ user_id: data.user_id, role: data.role, role_label: data.role_label });
            }
            break;
        case 'participant_muted':
            presence.upsert({ user_id: data.user_id, muted: data.muted, member_id: data.member_id });
            if (data.user_id === USER_ID && data.muted) {
                toast('میکروفون شما توسط مدیر بی‌صدا شد.', 'warning');
                Media.forceMute();
            }
            break;
        case 'mute_all':
            if (data.except_member_id !== MEMBER_ID) {
                toast('همهٔ شرکت‌کنندگان بی‌صدا شدند.', 'warning');
                Media.forceMute();
                const me = presence.participants.get(USER_ID);
                if (me) presence.upsert({ ...me, muted: true });
            }
            break;
        case 'participant_removed':
            presence.remove(data.user_id);
            if (data.user_id === USER_ID) {
                toast('شما از کلاس حذف شدید.', 'error', 8000);
                setTimeout(() => { location.href = `/dashboard/`; }, 1600);
            }
            break;
        case 'notification':
            handleNotification(data);
            break;
        case 'settings_changed':
            toast('تنظیمات کلاس به‌روزرسانی شد.', 'info', 2200);
            if (data.settings?.chat_disabled !== undefined) {
                ChatClient.setSendEnabled(
                    !data.settings.chat_disabled || PRIVILEGED,
                    'گفتگو توسط میزبان قطع شده است.'
                );
            }
            break;
        case 'classroom_locked':
            showLockBadge(true);
            toast(data.text, 'warning');
            break;
        case 'classroom_unlocked':
            showLockBadge(false);
            toast(data.text, 'success');
            break;
        case 'session_started':
            toast('جلسه شروع شد.', 'success');
            setSessionUI(true);
            break;
        case 'session_ended':
            toast('جلسه پایان یافت.', 'info');
            setSessionUI(false);
            break;
        case 'file_uploaded':
            addFileItem(data.file);
            toast(`فایل «${data.file.name}» بارگذاری شد.`, 'info', 2500);
            break;
        case 'presentation_changed':
            applyPresentation(data);
            break;
        case 'waiting_room_entry':
            // New pending participant (visible to hosts via next snapshot too).
            if (PRIVILEGED) presence.upsert(data.participant);
            break;
        case 'pong':
            break;
        default:
            break;
    }
}

function handleNotification(data) {
    toast(data.text || '', data.level || 'info');
    switch (data.event) {
        case 'removed':
            setTimeout(() => { location.href = '/dashboard/'; }, 1600);
            break;
        case 'waiting_room_approved':
            setTimeout(() => location.reload(), 600);
            break;
        case 'waiting_room_denied':
            setTimeout(() => { location.href = '/dashboard/'; }, 1600);
            break;
        case 'muted':
            Media.forceMute();
            break;
        case 'unmute_requested':
            if (confirmAction('میزبان از شما خواست میکروفون را روشن کنید. روشن شود؟')) {
                Media.toggleMicrophone();
            }
            break;
        default:
            break;
    }
}

function applyClassroomState(state) {
    if (state.is_locked !== undefined) showLockBadge(state.is_locked);
    ChatClient.setSendEnabled(!state.chat_disabled || PRIVILEGED, 'گفتگو توسط میزبان قطع شده است.');
    if (state.current_file_id) {
        applyPresentation({
            file_id: state.current_file_id,
            file_name: state.current_file_name,
            page: state.current_page,
        });
    }
}

function showLockBadge(locked) {
    let badge = document.getElementById('lock-badge');
    if (locked && !badge) {
        badge = document.createElement('span');
        badge.id = 'lock-badge';
        badge.className = 'badge badge-warn';
        badge.textContent = '🔒 قفل';
        document.querySelector('.room-title').appendChild(badge);
    } else if (!locked && badge) {
        badge.remove();
    }
}

function setSessionUI(live) {
    const btn = document.getElementById('btn-session');
    if (btn) {
        btn.classList.toggle('active', live);
        btn.title = live ? 'پایان جلسه' : 'شروع جلسه';
    }
    let dot = document.querySelector('.live-dot');
    if (live && !dot) {
        dot = document.createElement('span');
        dot.className = 'live-dot';
        dot.textContent = '● LIVE';
        document.querySelector('.room-title').appendChild(dot);
    } else if (!live && dot) {
        dot.remove();
    }
}

// ---------------------------------------------------------------------------
// Tabs, drawers, controls
// ---------------------------------------------------------------------------
function initTabs() {
    document.querySelectorAll('.side-tab').forEach((tab) => {
        tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    });
}

function activateTab(name) {
    document.querySelectorAll('.side-tab').forEach((t) => {
        const on = t.dataset.tab === name;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.side-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `panel-${name}`);
    });
    if (name === 'chat') ChatClient.resetUnread();
}

function initControls() {
    const bind = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

    bind('btn-mic', async () => { await Media.toggleMicrophone(); });
    bind('btn-camera', async () => { await Media.toggleCamera(); });
    bind('btn-screen', async () => { await Media.toggleScreenShare(); });
    bind('btn-hand', () => {
        if (!PERMISSIONS.can_raise_hand) return toast('شما اجازهٔ بالا بردن دست را ندارید.', 'warning');
        const btn = document.getElementById('btn-hand');
        const raised = !btn.classList.contains('active');
        btn.classList.toggle('active', raised);
        btn.setAttribute('aria-pressed', String(raised));
        presence.send({ action: 'raise_hand', raised });
    });
    bind('btn-whiteboard', () => {
        if (!PERMISSIONS.can_use_whiteboard) return toast('شما اجازهٔ استفاده از تخته را ندارید.', 'warning');
        const showing = !document.getElementById('view-whiteboard').classList.contains('hidden');
        switchView(showing ? 'media' : 'whiteboard');
        document.getElementById('btn-whiteboard').classList.toggle('active', !showing);
        if (!showing) setTimeout(() => Whiteboard.resize(), 60);
    });
    bind('btn-chat', () => {
        activateTab('chat');
        document.getElementById('room-side').classList.toggle('drawer-open');
        document.getElementById('chat-input').focus();
    });
    bind('btn-people', () => {
        activateTab('participants');
        document.getElementById('room-side').classList.toggle('drawer-open');
    });
    bind('btn-exit-screen', () => switchView('media'));
    bind('btn-exit-presentation', () => switchView('media'));
    bind('btn-exit', () => {
        if (confirmAction('از کلاس خارج شوید؟')) {
            root.querySelector('form[action*="/leave/"]').submit();
        }
    });

    if (PRIVILEGED) {
        bind('btn-mute-all', async () => {
            if (!confirmAction('همهٔ شرکت‌کنندگان بی‌صدا شوند؟')) return;
            await api('/mute-all/');
        });
        bind('btn-lock', async () => {
            const badge = document.getElementById('lock-badge');
            const willLock = !badge;
            if (willLock && !confirmAction('کلاس قفل شود؟ ورود اعضای جدید مسدود می‌شود.')) return;
            await api('/lock/', { locked: willLock });
        });
        bind('btn-session', async () => {
            const active = document.getElementById('btn-session').classList.contains('active');
            if (!active) {
                await api('/sessions/start/');
            } else {
                const sid = root.dataset.liveSession;
                if (sid) await api(`/sessions/${sid}/end/`);
                else toast('شناسهٔ جلسه یافت نشد؛ صفحه را تازه کنید.', 'warning');
            }
        });
        initSettingsModal();
    }
}

function switchView(view) {
    for (const id of ['media', 'screen', 'whiteboard', 'presentation']) {
        document.getElementById(`view-${id}`).classList.toggle('hidden', id !== view);
    }
    if (view === 'whiteboard') setTimeout(() => Whiteboard.resize(), 60);
}
window.__switchView = switchView; // used by presentation module below

function refreshControlStates() {
    const micBtn = document.getElementById('btn-mic');
    micBtn?.classList.toggle('off', !PERMISSIONS.can_use_microphone);
    document.getElementById('btn-screen')?.classList.toggle('off', !PERMISSIONS.can_share_screen);
}

// ---------------------------------------------------------------------------
// Settings modal (host)
// ---------------------------------------------------------------------------
function initSettingsModal() {
    const dialog = document.getElementById('settings-dialog');
    document.getElementById('btn-settings')?.addEventListener('click', () => dialog.showModal());
    document.getElementById('settings-cancel').addEventListener('click', () => dialog.close());
    document.getElementById('settings-save').addEventListener('click', async () => {
        const form = document.getElementById('settings-form');
        const settingsObj = {};
        let locked = false;
        form.querySelectorAll('input[type=checkbox]').forEach((cb) => {
            if (cb.name === 'is_locked') locked = cb.checked;
            else settingsObj[cb.name] = cb.checked;
        });
        await api('/settings/', { settings: settingsObj });
        await api('/lock/', { locked });
        dialog.close();
        toast('تنظیمات ذخیره شد.', 'success');
    });
}

// ---------------------------------------------------------------------------
// Files + presentation
// ---------------------------------------------------------------------------
function initFiles() {
    if (PERMISSIONS.can_upload_files) {
        document.getElementById('upload-form').classList.remove('hidden');
        document.getElementById('file-input').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const progress = document.getElementById('upload-progress');
            progress.classList.remove('hidden');
            progress.textContent = `در حال بارگذاری «${file.name}»…`;
            const fd = new FormData();
            fd.append('file', file);
            try {
                const res = await fetch(`/class/${ROOM_CODE}/files/upload/`, {
                    method: 'POST',
                    headers: { 'X-CSRFToken': csrfToken },
                    body: fd,
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || 'بارگذاری ناموفق بود.');
                addFileItem({
                    id: data.id, name: data.name,
                    url: `/class/${ROOM_CODE}/files/${data.id}/download/`,
                });
                toast('فایل بارگذاری شد.', 'success');
            } catch (err) {
                toast(err.message, 'error');
            } finally {
                progress.classList.add('hidden');
                e.target.value = '';
            }
        });
    }
    if (PERMISSIONS.can_present) {
        document.querySelectorAll('.present-btn').forEach((b) => b.classList.remove('hidden'));
    }
    document.getElementById('file-list').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-present]');
        if (!btn) return;
        api('/presentation/', { file_id: Number(btn.dataset.present), page: 1 });
    });
}

function addFileItem(file) {
    const list = document.getElementById('file-list');
    if (list.querySelector(`[data-file-id="${file.id}"]`)) return;
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.fileId = String(file.id);
    li.innerHTML = `
        <div class="file-info">
            <span class="file-name"></span>
            <small class="muted">${file.uploader || ''}${file.size ? ' · ' + file.size : ''}</small>
        </div>
        <div class="file-actions">
            <a class="btn btn-sm btn-ghost" href="${file.url}" download aria-label="دانلود">⬇</a>
            ${PERMISSIONS.can_present ? `<button type="button" class="btn btn-sm btn-ghost present-btn" data-present="${file.id}" title="ارائه این فایل">📽</button>` : ''}
        </div>`;
    li.querySelector('.file-name').textContent = file.name;
    list.prepend(li);
}

let presentationState = { fileId: null, page: 1 };
function applyPresentation(data) {
    presentationState = { fileId: data.file_id, page: data.page || 1 };
    const holder = document.getElementById('presentation-holder');
    const title = document.getElementById('presentation-title');
    if (!data.file_id) {
        holder.innerHTML = '';
        switchView('media');
        return;
    }
    title.textContent = `ارائه: ${data.file_name || ''} — صفحهٔ ${presentationState.page}`;
    const url = `/class/${ROOM_CODE}/files/${data.file_id}/download/`;
    holder.innerHTML = `
        <div class="presentation-nav">
            <button type="button" class="btn btn-sm btn-ghost" id="pres-prev">صفحهٔ قبل</button>
            <span>صفحهٔ <input type="number" id="pres-page" min="1" value="${presentationState.page}" style="width:4rem">
            <button type="button" class="btn btn-sm btn-ghost" id="pres-go">برو</button></span>
            <button type="button" class="btn btn-sm btn-ghost" id="pres-next">صفحهٔ بعد</button>
            <a class="btn btn-sm btn-ghost" href="${url}" target="_blank" rel="noopener">باز کردن فایل</a>
        </div>
        <embed class="presentation-frame" src="${url}#page=${presentationState.page}" type="application/pdf">`;
    if (PERMISSIONS.can_present) {
        const go = (page) => api('/presentation/', { file_id: presentationState.fileId, page });
        holder.querySelector('#pres-prev').addEventListener('click', () => go(Math.max(1, presentationState.page - 1)));
        holder.querySelector('#pres-next').addEventListener('click', () => go(presentationState.page + 1));
        holder.querySelector('#pres-go').addEventListener('click', () => go(Number(holder.querySelector('#pres-page').value) || 1));
    } else {
        holder.querySelector('.presentation-nav').querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
    }
    switchView('presentation');
}

// ---------------------------------------------------------------------------
// Roster search/filter
// ---------------------------------------------------------------------------
function initRosterTools() {
    document.getElementById('participant-search').addEventListener('input', (e) => {
        presence.searchTerm = e.target.value.trim().toLowerCase();
        presence.render();
    });
    document.querySelectorAll('.filter-chips .chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.filter-chips .chip').forEach((c) => c.classList.remove('active'));
            chip.classList.add('active');
            presence.filter = chip.dataset.filter;
            presence.render();
        });
    });
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
presence.connect();
ChatClient.connect(ROOM_CODE, USER_ID, PRIVILEGED);
Whiteboard.init({ roomCode: ROOM_CODE, userId: USER_ID, canDraw: PERMISSIONS.can_use_whiteboard });
await Media.init({
    roomCode: ROOM_CODE,
    currentUserId: USER_ID,
    permissions: PERMISSIONS,
    mediaUrl: MEDIA_URL,
    mediaEnabled: MEDIA_ENABLED,
    onStateChange: (state) => presence.send({ action: 'media_state', ...state }),
});
initTabs();
initControls();
initFiles();
initRosterTools();
initClock();
refreshControlStates();
if (!PERMISSIONS.can_send_messages) {
    ChatClient.setSendEnabled(false, 'شما اجازهٔ ارسال پیام ندارید.');
}

// Periodic keepalive so idle proxies don't drop the presence socket.
setInterval(() => presence.send({ action: 'ping' }), 25_000);
