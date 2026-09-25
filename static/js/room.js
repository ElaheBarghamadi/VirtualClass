/**
 * room.js — classroom orchestrator.
 *
 * Owns: the presence WebSocket (+connection status/reconnection), the
 * roster with search/filters and host controls, tab & drawer UI, the
 * control bar (permission-gated, server remains authoritative), stage
 * layouts, the "more" menu (devices/settings/shortcuts/help/report),
 * keyboard shortcuts, files, presentation, sessions, notifications and
 * integration with media.js / chat.js / whiteboard.js / modal.js.
 *
 * Participants are keyed by their public identity (`u:<id>` / `g:<uid>`)
 * — registered users and guests share one pipeline.
 */
import { ChatClient } from './chat.js';
import { Whiteboard } from './whiteboard.js';
import { Media } from './media.js';
import { toast } from './toast.js';
import { confirmDialog, infoDialog } from './modal.js';

const root = document.getElementById('classroom-root');
const ROOM_CODE = root.dataset.roomCode;
const IDENTITY = root.dataset.identity;
const MEMBER_ID = Number(root.dataset.memberId);
const PRIVILEGED = root.dataset.privileged === '1';
const MEDIA_ENABLED = root.dataset.mediaEnabled === '1';
const MEDIA_URL = root.dataset.mediaUrl;
const SHOW_CHAT = root.dataset.showChat === '1';
const PERMISSIONS = JSON.parse(document.getElementById('member-permissions').textContent);
const EXIT_URL = root.dataset.isGuest === '1' ? '/' : '/dashboard/';

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
// Presence WebSocket + connection status + real RTT
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
        this.participants = new Map();  // identity → participant payload
        this.searchTerm = '';
        this.filter = 'ALL';
        this._pingAt = 0;
        this.rtt = null;
    }

    connect() {
        this.setStatus(this.ws ? 'reconnecting' : 'connecting');
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${location.host}/ws/classroom/${ROOM_CODE}/`);
        this.ws.onopen = () => {
            this.retryDelay = 1000;
            this.setStatus('connected');
            // real round-trip measurement, repeated every 10s
            this._measureRtt();
            this._rttTimer = setInterval(() => this._measureRtt(), 10_000);
        };
        this.ws.onmessage = (evt) => handleEvent(JSON.parse(evt.data));
        this.ws.onclose = (evt) => {
            clearInterval(this._rttTimer);
            if (evt.code === 4401 || evt.code === 4403) {
                toast('دسترسی شما به کلاس قطع شده است.', 'error');
                setTimeout(() => { location.href = `/class/${ROOM_CODE}/lobby/`; }, 1800);
                return;
            }
            this.setStatus('reconnecting');
            setTimeout(() => this.connect(), this.retryDelay = Math.min(this.retryDelay * 2, 15000));
        };
    }

    _measureRtt() {
        this._pingAt = performance.now();
        this.send({ action: 'ping' });
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
        this._updateTitle();
    }

    _updateTitle() {
        const bits = [`وضعیت: ${this.el.querySelector('.conn-text').textContent}`];
        if (this.rtt !== null) bits.push(`تأخیر سیگنالینگ: ${this.rtt}ms`);
        if (Media.quality && Media.quality !== 'unknown') bits.push(`کیفیت رسانه: ${qualityLabel(Media.quality)}`);
        this.el.title = bits.join(' · ');
    }

    // ------------------------------------------------------------ roster
    upsert(p) {
        if (!p || !p.identity) return;
        this.participants.set(p.identity, { ...(this.participants.get(p.identity) || {}), ...p });
        this.scheduleRender();
    }

    remove(identity) {
        this.participants.delete(identity);
        this.scheduleRender();
    }

    /** Coalesce burst updates (join + media_state + …) into one paint. */
    scheduleRender() {
        if (this._renderQueued) return;
        this._renderQueued = true;
        requestAnimationFrame(() => {
            this._renderQueued = false;
            this.render();
        });
    }

    render() {
        const skeleton = document.getElementById('roster-skeleton');
        if (skeleton) skeleton.classList.add('hidden');

        const all = Array.from(this.participants.values());
        const inRoom = all.filter((p) => !p.in_waiting_room);
        const waiting = all.filter((p) => p.in_waiting_room);

        // Sort: hands raised first, then role rank, then join time.
        const roleRank = { OWNER: 0, MODERATOR: 1, PRESENTER: 2, STUDENT: 3, GUEST: 4 };
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

        // Keep the P2P mesh engine's peer set in sync (LiveKit ignores this).
        Media.syncPeers(inRoom.map((p) => ({
            identity: p.identity, member_id: p.member_id, name: p.name,
        })));
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
        li.dataset.identity = String(p.identity);

        li.innerHTML = `
            <span class="participant-avatar"></span>
            <span class="participant-name"></span>
            <span class="participant-role"></span>
            <span class="participant-states" aria-hidden="true">
                <i class="s-hand ${p.hand_raised ? 'on' : ''}" title="دست بالا">✋</i>
                <i class="s-mic ${p.mic_on === false ? 'off' : ''}" title="میکروفون">🎤</i>
                <i class="s-camera ${p.camera_on === false ? 'off' : ''}" title="دوربین">📹</i>
                <i class="s-muted ${p.muted ? 'on' : ''}" title="بی‌صدا توسط مدیر">🔇</i>
            </span>`;
        li.querySelector('.participant-avatar').textContent = (p.name || '?').charAt(0);
        li.querySelector('.participant-name').textContent =
            p.identity === IDENTITY ? `${p.name} (شما)` : p.name;
        li.querySelector('.participant-role').textContent = p.role_label || '';

        if (PRIVILEGED && p.identity !== IDENTITY && p.role !== 'OWNER') {
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
            if (!await confirmDialog('حذف شرکت‌کننده', `${p.name} از کلاس حذف شود؟`, { danger: true, okLabel: 'حذف' })) return;
            const ban = await confirmDialog('مسدودسازی موقت', 'ورود مجدد او ۵ دقیقه مسدود شود؟', { okLabel: 'بله، مسدود شود' });
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
        deny.addEventListener('click', async () => {
            if (await confirmDialog('رد درخواست', `درخواست ${p.name} رد شود؟`, { danger: true, okLabel: 'رد' })) {
                api(`/members/${p.member_id}/waiting/`, { approve: false });
            }
        });
        return li;
    }
}

const presence = new PresenceClient();

function qualityLabel(q) {
    return { excellent: 'عالی', good: 'خوب', poor: 'ضعیف', lost: 'قطع', unknown: 'نامشخص' }[q] || q;
}

// ---------------------------------------------------------------------------
// Event router — one consistent server protocol
// ---------------------------------------------------------------------------
function handleEvent(data) {
    switch (data.type) {
        case 'participant_list':
            presence.participants.clear();
            data.participants.forEach((p) => { if (p.identity) presence.participants.set(p.identity, p); });
            presence.render();
            applyClassroomState(data.classroom || {});
            break;
        case 'user_joined':
            presence.upsert(data.participant);
            if (data.participant.identity !== IDENTITY) {
                ChatClient.addSystemMessage(`${data.participant.name} به کلاس پیوست.`);
            }
            break;
        case 'user_left':
            presence.remove(data.participant.identity);
            ChatClient.addSystemMessage(`${data.participant.name} کلاس را ترک کرد.`);
            break;
        case 'raise_hand':
        case 'lower_hand':
            presence.upsert(data.participant);
            if (data.type === 'raise_hand' && data.participant.identity !== IDENTITY) {
                toast(`✋ ${data.participant.name} دست خود را بالا برد.`, 'info', 2500);
            }
            break;
        case 'media_state':
            presence.upsert(data.participant);
            break;
        case 'permission_changed':
            if (data.identity === IDENTITY) {
                PERMISSIONS[data.permission] = data.value;
                Whiteboard.setPermission(PERMISSIONS.can_use_whiteboard);
                refreshControlStates();
            }
            break;
        case 'role_changed':
            if (data.identity === IDENTITY) {
                toast(data.text || 'نقش شما تغییر کرد.', 'success');
                setTimeout(() => location.reload(), 1200); // re-render privileges
            } else {
                presence.upsert({ identity: data.identity, role: data.role, role_label: data.role_label });
            }
            break;
        case 'participant_muted':
            presence.upsert({ identity: data.identity, muted: data.muted, member_id: data.member_id });
            if (data.identity === IDENTITY && data.muted) {
                toast('میکروفون شما توسط مدیر بی‌صدا شد.', 'warning');
                Media.forceMute();
            }
            break;
        case 'mute_all':
            if (data.except_member_id !== MEMBER_ID) {
                toast('همهٔ شرکت‌کنندگان بی‌صدا شدند.', 'warning');
                Media.forceMute();
                const me = presence.participants.get(IDENTITY);
                if (me) presence.upsert({ ...me, muted: true });
            }
            break;
        case 'participant_removed':
            presence.remove(data.identity);
            if (data.identity === IDENTITY) {
                toast('شما از کلاس حذف شدید.', 'error', 8000);
                setTimeout(() => { location.href = EXIT_URL; }, 1600);
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
        case 'classroom_updated':
            if (data.title) document.querySelector('.room-title h1').textContent = data.title;
            toast('اطلاعات کلاس به‌روزرسانی شد.', 'info', 2200);
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
        case 'waiting_room_approved':
            // The pending entry becomes a normal roster row (until the
            // guest's own user_joined arrives it stays flagged as waiting).
            if (PRIVILEGED && data.participant) presence.upsert(data.participant);
            break;
        case 'waiting_room_denied':
            if (PRIVILEGED) presence.remove(data.identity);
            break;
        case 'whiteboard_state':
            applyWhiteboardState(data.open);
            if (data.open && data.by) toast(`${data.by} تختهٔ سفید را باز کرد.`, 'info', 2500);
            break;
        case 'rtc_signal':
            Media.handleSignal(data);
            break;
        case 'pong':
            if (presence._pingAt) {
                presence.rtt = Math.round(performance.now() - presence._pingAt);
                presence._pingAt = 0;
                presence._updateTitle();
            }
            break;
        default:
            break;
    }
}

function handleNotification(data) {
    toast(data.text || '', data.level || 'info');
    switch (data.event) {
        case 'removed':
            setTimeout(() => { location.href = EXIT_URL; }, 1600);
            break;
        case 'waiting_room_approved':
            setTimeout(() => location.reload(), 600);
            break;
        case 'waiting_room_denied':
            setTimeout(() => { location.href = EXIT_URL; }, 1600);
            break;
        case 'muted':
            Media.forceMute();
            break;
        case 'unmute_requested':
            confirmDialog('درخواست میزبان', 'میزبان از شما خواست میکروفون را روشن کنید. روشن شود؟', { okLabel: 'روشن کردن' })
                .then((ok) => { if (ok) Media.toggleMicrophone(); });
            break;
        default:
            break;
    }
}

function applyClassroomState(state) {
    if (state.is_locked !== undefined) showLockBadge(state.is_locked);
    ChatClient.setSendEnabled(!state.chat_disabled || PRIVILEGED, 'گفتگو توسط میزبان قطع شده است.');
    if (state.whiteboard_open) applyWhiteboardState(true);
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
// Shared whiteboard view state (broadcast by the server to everyone)
// ---------------------------------------------------------------------------
function applyWhiteboardState(open) {
    switchView(open ? 'whiteboard' : 'media');
    document.getElementById('btn-whiteboard')?.classList.toggle('active', Boolean(open));
    if (open) setTimeout(() => Whiteboard.resize(), 60);
}

// ---------------------------------------------------------------------------
// Stage fullscreen — works for every view (media / screen / whiteboard /
// presentation).  Any element with [data-action="fullscreen-stage"] toggles.
// ---------------------------------------------------------------------------
function initFullscreen() {
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="fullscreen-stage"]');
        if (!btn) return;
        if (document.fullscreenElement) {
            document.exitFullscreen?.();
        } else {
            document.getElementById('stage')?.requestFullscreen?.()
                .catch(() => toast('حالت تمام‌صفحه در این مرورگر در دسترس نیست.', 'warning'));
        }
    });
    document.addEventListener('fullscreenchange', () => {
        const on = Boolean(document.fullscreenElement);
        document.querySelectorAll('[data-action="fullscreen-stage"]').forEach((b) => {
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        setTimeout(() => Whiteboard.resize(), 80); // canvas follows the new size
    });
}

// ---------------------------------------------------------------------------
// Tabs, drawers, layouts
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

function initLayouts() {
    const buttons = document.querySelectorAll('.layout-btn');
    const apply = (mode, persist = true) => {
        buttons.forEach((b) => {
            const on = b.dataset.layout === mode;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        Media.setLayout(mode);
        void persist;
    };
    buttons.forEach((b) => b.addEventListener('click', () => apply(b.dataset.layout)));
    apply(Media.layout, false); // restore persisted choice
}

// ---------------------------------------------------------------------------
// Control bar
// ---------------------------------------------------------------------------
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
        if (Whiteboard.unavailable) return toast('کتابخانهٔ تخته بارگذاری نشد؛ صفحه را تازه کنید.', 'error');
        // Ask the server to broadcast the state so EVERYONE sees the board.
        const showing = !document.getElementById('view-whiteboard').classList.contains('hidden');
        presence.send({ action: 'whiteboard_state', open: !showing });
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
    bind('btn-exit', async () => {
        if (await confirmDialog('خروج از کلاس', 'از کلاس خارج شوید؟ برای ورود مجدد باید دوباره به کلاس بپیوندید.', { danger: true, okLabel: 'خروج' })) {
            document.getElementById('leave-submit').form.submit();
        }
    });
    bind('btn-more', () => toggleMoreMenu());

    if (PRIVILEGED) {
        bind('btn-mute-all', async () => {
            if (!await confirmDialog('بی‌صدا کردن همه', 'همهٔ شرکت‌کنندگان بی‌صدا شوند؟', { okLabel: 'بی‌صدا کن' })) return;
            await api('/mute-all/');
        });
        bind('btn-lock', async () => {
            const badge = document.getElementById('lock-badge');
            const willLock = !badge;
            if (willLock && !await confirmDialog('قفل کردن کلاس', 'کلاس قفل شود؟ ورود اعضای جدید مسدود می‌شود.', { okLabel: 'قفل کن' })) return;
            await api('/lock/', { locked: willLock });
        });
        bind('btn-session', async () => {
            const active = document.getElementById('btn-session').classList.contains('active');
            if (!active) {
                await api('/sessions/start/');
            } else {
                const sid = root.dataset.liveSession;
                if (!sid) return toast('شناسهٔ جلسه یافت نشد؛ صفحه را تازه کنید.', 'warning');
                if (!await confirmDialog('پایان جلسه', 'جلسهٔ جاری پایان یابد؟ گزارش حضور ثبت می‌شود.', { danger: true, okLabel: 'پایان جلسه' })) return;
                await api(`/sessions/${sid}/end/`);
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
// "More" menu — permission-filtered
// ---------------------------------------------------------------------------
function toggleMoreMenu(force) {
    const menu = document.getElementById('more-menu');
    const btn = document.getElementById('btn-more');
    const show = force !== undefined ? force : menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !show);
    btn.setAttribute('aria-expanded', String(show));
    if (show) menu.querySelector('button')?.focus();
}

function initMoreMenu() {
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('more-menu');
        if (!menu.classList.contains('hidden') &&
            !menu.contains(e.target) && e.target.closest('#btn-more') === null) {
            toggleMoreMenu(false);
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') toggleMoreMenu(false);
    });

    const bind = (id, fn) => document.getElementById(id)?.addEventListener('click', () => { toggleMoreMenu(false); fn(); });
    bind('menu-devices', openDevicesDialog);
    bind('menu-theme', () => {
        const order = ['system', 'light', 'dark'];
        const next = order[(order.indexOf(window.UITheme.preference) + 1) % order.length];
        window.UITheme.set(next);
        toast(`پوسته: ${{ system: 'خودکار', light: 'روشن', dark: 'تیره' }[next]}`, 'info', 1800);
    });
    bind('menu-settings', () => document.getElementById('settings-dialog')?.showModal());
    bind('menu-shortcuts', showShortcuts);
    bind('menu-help', showHelp);
    bind('menu-report', showReport);
    document.getElementById('menu-manage')?.addEventListener('click', (e) => {
        window.open(e.currentTarget.dataset.href, '_blank', 'noopener');
        toggleMoreMenu(false);
    });
}

function showShortcuts() {
    infoDialog('کلیدهای میان‌بر', `
        <ul class="shortcut-list">
            <li><kbd>M</kbd> قطع/وصل میکروفون</li>
            <li><kbd>V</kbd> قطع/وصل دوربین</li>
            <li><kbd>C</kbd> باز/بستن گفتگو</li>
            <li><kbd>P</kbd> باز/بستن شرکت‌کنندگان</li>
            <li><kbd>S</kbd> شروع/پایان اشتراک صفحه</li>
        </ul>
        <p class="muted small">هنگام تایپ در فیلدهای متنی، میان‌برها غیرفعال‌اند.</p>`);
}

function showHelp() {
    infoDialog('راهنمای کلاس', `
        <ul class="shortcut-list">
            <li>🎤📹 از نوار پایین میکروفون و دوربین را کنترل کنید.</li>
            <li>✋ با «دست بالا» از میزبان اجازهٔ صحبت بگیرید.</li>
            <li>▦ چیدمان صحنه را از دکمه‌های بالای ویدیوها تغییر دهید؛ انتخاب شما ذخیره می‌شود.</li>
            <li>⋯ منوی «بیشتر»: دستگاه‌ها، پوسته، تنظیمات و گزارش مشکل.</li>
            <li>🔒 دسترسی‌ها (میکروفون، دوربین، تخته، گفتگو) توسط میزبان مدیریت می‌شود.</li>
        </ul>`);
}

function showReport() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
        <p class="muted">مشکل را کوتاه توضیح دهید تا میزبان در جریان قرار گیرد.</p>
        <div class="field"><textarea id="report-text" rows="4" maxlength="500" placeholder="مثلاً: صدای من قطع می‌شود…"></textarea></div>`;
    infoDialog('گزارش مشکل', wrap, 'ارسال').then(() => {
        const text = (wrap.querySelector('#report-text')?.value || '').trim();
        if (text) {
            ChatClient.send(`🚩 گزارش مشکل: ${text.slice(0, 300)}`);
            toast('گزارش شما ارسال شد.', 'success');
        }
    });
}

// ---------------------------------------------------------------------------
// Devices dialog — change devices mid-class, no rejoin
// ---------------------------------------------------------------------------
async function openDevicesDialog() {
    const dialog = document.getElementById('devices-dialog');
    const camSel = document.getElementById('dev-camera');
    const micSel = document.getElementById('dev-mic');
    const spkSel = document.getElementById('dev-speaker');
    const feedback = document.getElementById('dev-feedback');

    const devices = await Media.listDevices();
    const fill = (sel, kind, fallback) => {
        const current = sel.value;
        sel.innerHTML = '';
        const items = devices.filter((d) => d.kind === kind);
        items.forEach((d, i) => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `${fallback} ${i + 1}`;
            sel.appendChild(opt);
        });
        if (!items.length) {
            const opt = document.createElement('option');
            opt.textContent = `بدون ${fallback}`;
            sel.appendChild(opt);
        }
        if (current) sel.value = current;
    };
    fill(camSel, 'videoinput', 'دوربین');
    fill(micSel, 'audioinput', 'میکروفون');
    fill(spkSel, 'audiooutput', 'بلندگو');
    if (!('setSinkId' in HTMLAudioElement.prototype)) {
        spkSel.disabled = true;
        spkSel.title = 'انتخاب بلندگو در این مرورگر پشتیبانی نمی‌شود';
    }
    feedback.textContent = '';
    dialog.showModal();
}

function initDevicesDialog() {
    const dialog = document.getElementById('devices-dialog');
    document.getElementById('devices-close').addEventListener('click', () => dialog.close());
    document.getElementById('devices-apply').addEventListener('click', async () => {
        const feedback = document.getElementById('dev-feedback');
        feedback.textContent = 'در حال اعمال…';
        try {
            const cam = document.getElementById('dev-camera').value;
            const mic = document.getElementById('dev-mic').value;
            const spk = document.getElementById('dev-speaker').value;
            if (cam) await Media.setCameraDevice(cam);
            if (mic) await Media.setMicDevice(mic);
            if (spk) await Media.setOutputDevice(spk);
            feedback.textContent = '✅ دستگاه‌ها اعمال شد.';
            setTimeout(() => dialog.close(), 700);
        } catch (err) {
            feedback.textContent = `اعمال ناموفق بود: ${err.message || ''}`;
        }
    });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts — disabled while typing
// ---------------------------------------------------------------------------
function initShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        const key = e.key.toLowerCase();
        if (key === 'm') { e.preventDefault(); Media.toggleMicrophone(); }
        else if (key === 'v') { e.preventDefault(); Media.toggleCamera(); }
        else if (key === 'c') { e.preventDefault(); document.getElementById('btn-chat')?.click(); }
        else if (key === 'p') { e.preventDefault(); document.getElementById('btn-people')?.click(); }
        else if (key === 's') { e.preventDefault(); Media.toggleScreenShare(); }
    });
}

// ---------------------------------------------------------------------------
// Connection quality pill (real metrics: LiveKit stats + WS RTT)
// ---------------------------------------------------------------------------
function onQualityChange(quality) {
    const el = document.getElementById('conn-quality');
    if (!el) return;
    if (!quality || quality === 'unknown') {
        el.classList.add('hidden');
        return;
    }
    el.classList.remove('hidden');
    const icons = { excellent: '📶', good: '📶', poor: '📵', lost: '❌', reconnecting: '🔄' };
    el.textContent = `${icons[quality] || '📶'} ${qualityLabel(quality)}`;
    el.className = `conn-quality q-${quality}`;
    presence._updateTitle();
}

// ---------------------------------------------------------------------------
// Settings modal (host)
// ---------------------------------------------------------------------------
function initSettingsModal() {
    const dialog = document.getElementById('settings-dialog');
    document.getElementById('settings-x')?.addEventListener('click', () => dialog.close());
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
//
// Order matters: every UI binding happens FIRST, so a failure in any
// optional subsystem (media libs, whiteboard canvas, sockets) can never
// leave the page with dead controls.  Each risky init is isolated.
// ---------------------------------------------------------------------------
initTabs();
initLayouts();
initControls();
initFullscreen();
initMoreMenu();
initDevicesDialog();
initShortcuts();
initFiles();
initRosterTools();
initClock();
refreshControlStates();
if (!PERMISSIONS.can_send_messages) {
    ChatClient.setSendEnabled(false, 'شما اجازهٔ ارسال پیام ندارید.');
}
if (SHOW_CHAT) {
    activateTab('chat');
}

presence.connect();
try {
    ChatClient.connect(ROOM_CODE, IDENTITY, PRIVILEGED);
} catch (err) {
    console.warn('[chat] init failed:', err);
}
try {
    Whiteboard.init({ roomCode: ROOM_CODE, identity: IDENTITY, canDraw: PERMISSIONS.can_use_whiteboard });
} catch (err) {
    console.warn('[whiteboard] init failed:', err);
    Whiteboard.unavailable = true;
}
try {
    await Media.init({
        roomCode: ROOM_CODE,
        currentIdentity: IDENTITY,
        permissions: PERMISSIONS,
        mediaUrl: MEDIA_URL,
        mediaEnabled: MEDIA_ENABLED,
        self: { identity: IDENTITY, memberId: MEMBER_ID, name: root.dataset.participantName },
        signal: (payload) => presence.send(payload),
        onStateChange: (state) => presence.send({ action: 'media_state', ...state }),
        onQualityChange,
    });
    // re-sync the mesh once media is up (the first snapshot may predate it)
    Media.syncPeers(Array.from(presence.participants.values())
        .filter((p) => !p.in_waiting_room)
        .map((p) => ({ identity: p.identity, member_id: p.member_id, name: p.name })));
} catch (err) {
    console.warn('[media] init failed:', err);
}

// Periodic keepalive so idle proxies don't drop the presence socket.
setInterval(() => presence.send({ action: 'ping' }), 25_000);
