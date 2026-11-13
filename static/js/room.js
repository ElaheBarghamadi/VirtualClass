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
import { Presentation } from './presentation.js';
import { Media } from './media.js';
import { QuizClient } from './quiz.js';
import { toast } from './toast.js';
import { choiceDialog, confirmDialog, infoDialog } from './modal.js';
import { Recorder } from './recorder.js';
import { Captions } from './captions.js';
import { initDeviceTest } from './device-test.js';

// Persian digits for anything JS renders that the server also renders
// (participant counts), so the two never disagree.
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const faDigits = (value) => String(value).replace(/[0-9]/g, (d) => FA_DIGITS[d]);

const root = document.getElementById('classroom-root');
const ROOM_CODE = root.dataset.roomCode;
const IDENTITY = root.dataset.identity;
const SELF_USER_ID = IDENTITY.startsWith('u:') ? Number(IDENTITY.slice(2)) : null;
const MEMBER_ID = Number(root.dataset.memberId);
const SELF_ROLE = root.dataset.role || '';
const PRIVILEGED = root.dataset.privileged === '1';
const IS_OWNER = root.dataset.owner === '1';
// OWNER/MODERATOR/PRESENTER: the roles that own the shared surface (open the
// board for the room, add/switch its pages, drive the slide deck).
const CAN_CONTROL_BOARD = root.dataset.canControlBoard === '1';
const MEDIA_ENABLED = root.dataset.mediaEnabled === '1';
const MEDIA_URL = root.dataset.mediaUrl;
const MESH_ENABLED = root.dataset.meshEnabled === '1';
const MESH_MAX = Number(root.dataset.meshMax || 0) || 12;
let ICE_SERVERS = [];
try { ICE_SERVERS = JSON.parse(root.dataset.iceServers || '[]'); } catch { ICE_SERVERS = []; }
const SHOW_CHAT = root.dataset.showChat === '1';
const PERMISSIONS = JSON.parse(document.getElementById('member-permissions').textContent);
const EXIT_URL = root.dataset.isGuest === '1' ? '/' : '/dashboard/';

// Single source for the per-member permissions panel (order + labels).
const PERM_ORDER = [
    'can_use_microphone', 'can_use_camera', 'can_share_screen', 'can_use_whiteboard',
    'can_send_messages', 'can_upload_files', 'can_raise_hand', 'can_present',
];
/** Inline SVG state icons (sprite lives in room.html) — emoji rendered as
 *  tofu on systems without an emoji font and looked inconsistent anyway. */
const svgUse = (id, cls = 'ic') => `<svg class="${cls}"><use href="#${id}"/></svg>`;
const STATE_ICONS = {
    mic: svgUse('i-mic', 'ic state-ic'),
    micOff: svgUse('i-mic-off', 'ic state-ic'),
    cam: svgUse('i-cam', 'ic state-ic'),
    camOff: svgUse('i-cam-off', 'ic state-ic'),
};

const PERM_LABELS = {
    can_use_microphone: 'میکروفون',
    can_use_camera: 'دوربین',
    can_share_screen: 'اشتراک صفحه',
    can_use_whiteboard: 'تختهٔ اشتراکی',
    can_send_messages: 'ارسال پیام',
    can_upload_files: 'بارگذاری فایل',
    can_raise_hand: 'بالا بردن دست و واکنش',
    can_present: 'ارائهٔ فایل',
};

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
        // Last media announcement we made, replayed after every reconnect.
        this._lastMedia = null;
        this._connectAt = 0;
        // When did this socket last say anything?  A socket can report OPEN
        // long after the network under it died (Wi-Fi switch, sleep), so
        // silence is the only honest health signal we have.
        this._lastInbound = 0;
    }

    connect() {
        // Never stack sockets: a duplicate connect would leave two open and
        // double every roster event.
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
        this.setStatus(this.ws ? 'reconnecting' : 'connecting');
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${proto}://${location.host}/ws/classroom/${ROOM_CODE}/`;
        this.url = url;
        let ws;
        try {
            ws = new WebSocket(url);
        } catch (err) {
            console.error('[presence] could not create socket', url, err);
            this.setStatus('lost');
            this._scheduleRetry();
            return;
        }
        this.ws = ws;
        this._connectAt = Date.now();
        // A blocked proxy/firewall can leave the handshake pending forever,
        // which used to show «در حال اتصال…» indefinitely.  Fail loudly and
        // retry instead of hanging.
        clearTimeout(this._handshakeTimer);
        this._handshakeTimer = setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                console.error('[presence] handshake timed out (no answer from the server) —', url);
                this.setStatus('lost');
                try { ws.close(); } catch (err) { /* already closed */ }
            }
        }, 12_000);
        ws.onopen = () => {
            // A replaced socket (manual retry, forced reconnect) must never
            // drive the UI again: only the current one counts.
            if (this.ws !== ws) return;
            clearTimeout(this._handshakeTimer);
            this.retryDelay = 1000;
            this._lastInbound = Date.now();
            this.setStatus('connected');
            // The server forgets a socket's media state when it closes, so a
            // reconnect without this leaves every peer with a stale roster —
            // «camera off» for someone who is very much on camera.  Push the
            // current local state again as soon as the link is back.
            this._replayMediaState();
            Network.sync();
            // real round-trip measurement, repeated every 10s
            this._measureRtt();
            this._rttTimer = setInterval(() => this._measureRtt(), 10_000);
        };
        ws.onmessage = (evt) => {
            if (this.ws !== ws) return;
            clearTimeout(this._handshakeTimer);
            this._lastInbound = Date.now();
            let data;
            try {
                data = JSON.parse(evt.data);
            } catch (err) {
                console.error('[presence] bad frame', err);
                return;
            }
            handleEvent(data);
        };
        ws.onerror = () => {
            if (this.ws !== ws) return;
            // The browser gives no detail here on purpose; the close code just
            // after it is the useful signal.  Log the URL so a failed route is
            // obvious in the console.
            console.error('[presence] socket error —', url);
        };
        ws.onclose = (evt) => {
            // Stale socket: the retry/reconnect path already replaced it, so
            // it must not schedule another connect or repaint the pill.
            if (this.ws !== ws) return;
            clearTimeout(this._handshakeTimer);
            clearInterval(this._rttTimer);
            if (evt.code === 4401 || evt.code === 4403) {
                toast('دسترسی شما به کلاس قطع شده است.', 'error');
                setTimeout(() => { location.href = `/class/${ROOM_CODE}/lobby/`; }, 1800);
                return;
            }
            if (evt.code === 1000 && this._closing) { this._closing = false; return; }
            console.warn('[presence] socket closed', evt.code, evt.reason || '(no reason)');
            this.setStatus('reconnecting');
            this._scheduleRetry();
        };
    }

    _scheduleRetry() {
        clearTimeout(this._retryTimer);
        // Schedule with the CURRENT delay and only then double: the old order
        // made even the first retry wait 2s, which is a long dead screen right
        // after a network hiccup.  1s → 2s → 4s … capped at 15s.
        const delay = this.retryDelay;
        this.retryDelay = Math.min(this.retryDelay * 2, 15000);
        this._retryTimer = setTimeout(() => this.connect(), delay);
    }

    /** Manual retry: drop whatever is pending and try again right now. */
    reconnect() {
        clearTimeout(this._retryTimer);
        clearTimeout(this._handshakeTimer);
        this.retryDelay = 1000;
        if (this.ws) {
            this._closing = true;
            const old = this.ws;
            this.ws = null;   // stale from here on: its events are ignored
            try { old.close(); } catch (err) { /* ignore */ }
        }
        this._lastInbound = 0;
        this.connect();
    }

    _measureRtt() {
        this._pingAt = performance.now();
        this.send({ action: 'ping' });
    }

    send(payload) {
        // Remember the latest media announcement even while offline: the
        // socket reopening is exactly when it is needed again.
        if (payload && payload.action === 'media_state') this._lastMedia = payload;
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
            return true;
        }
        return false;
    }

    /** Re-announce mic/camera/screen after the socket came back. */
    _replayMediaState() {
        if (this._lastMedia) {
            this.send(this._lastMedia);
            return;
        }
        try {
            Media.pushMediaState?.();
        } catch (err) {
            console.error('[presence] could not replay media state', err);
        }
    }

    /**
     * Reconnect now if the socket is not healthy — used when the browser says
     * the network is back or the tab becomes visible again.
     *
     * ``force`` is for the online event: a socket opened before the network
     * switch still claims to be OPEN while every frame it sends is swallowed.
     * Otherwise a socket that has said nothing for 30s (three missed pings) is
     * treated as dead too — that is what a sleeping laptop looks like.
     */
    nudge(force = false) {
        const ready = this.ws?.readyState;
        const silent = Date.now() - (this._lastInbound || this._connectAt);
        if (!force) {
            if (ready === WebSocket.OPEN && silent < 30_000) return;
            if (ready === WebSocket.CONNECTING && silent < 4000) return;
        }
        this.reconnect();
    }

    /** Repaint the pill after the browser's own network state changed. */
    refreshStatus() {
        this.setStatus(this.state);
    }

    setStatus(state) {
        this.state = state;
        const map = {
            connected: ['connected', 'متصل'],
            connecting: ['', 'در حال اتصال…'],
            reconnecting: ['reconnecting', 'در حال اتصال مجدد…'],
            lost: ['lost', 'قطع شد — برای تلاش دوباره کلیک کنید'],
        };
        let [cls, text] = map[state] || map.connecting;
        // «در حال اتصال مجدد» while the browser has no network is a lie: there
        // is nothing to retry until the link is back, so say that instead.
        // This outranks the socket's own idea of its health — an OPEN socket
        // proves nothing once the link under it is gone.
        if (navigator.onLine === false) {
            cls = 'lost';
            text = 'اینترنت قطع';
        }
        this.el.className = `conn-pill ${cls}`;
        this.el.querySelector('.conn-text').textContent = text;
        this._updateTitle();
    }

    _updateTitle() {
        const bits = [`وضعیت: ${this.el.querySelector('.conn-text').textContent}`];
        if (this.url && this.state !== 'connected') bits.push(this.url);
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
        // Persian digits here too: the server renders the same count in ۱۲ form.
        this.countEl.textContent = faDigits(inRoom.length);

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

        // Who is actually on stage: a participant with no camera and no
        // microphone has nothing to show, so their tile stays out of the grid
        // (they remain in this list, and their media resumes instantly).
        Media.syncStagePresence?.(inRoom.map((p) => ({
            identity: p.identity,
            mic_on: p.mic_on,
            camera_on: p.camera_on,
        })));

        // Keep the P2P mesh engine's peer set in sync (LiveKit ignores this).
        Media.syncPeers(inRoom.map((p) => ({
            identity: p.identity,
            member_id: p.member_id,
            name: p.name,
            permissions: p.permissions || {},
            muted: Boolean(p.muted),
            camera_disabled: Boolean(p.camera_disabled),
            screen_sharing: p.screen_sharing,
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

        // One icon per fact.  Both «میکروفون خاموش» and «بی‌صدا شده» used to
        // render the same crossed mic in red, so a muted student showed the
        // icon twice and the row looked broken.  Muted-by-host wins.
        const muted = Boolean(p.muted);
        const micOff = !muted && p.mic_on === false;
        const camOff = p.camera_on === false;
        li.innerHTML = `
            <span class="participant-avatar"></span>
            <span class="participant-name-wrap">
                <span class="participant-name"></span>
                <span class="participant-role"></span>
            </span>
            <span class="participant-states" aria-hidden="true">
                <i class="s-hand ${p.hand_raised ? 'on' : ''}" title="دست بالا"><svg class="ic"><use href="#i-hand"/></svg></i>
                <i class="s-mic ${micOff ? 'off' : ''}" title="میکروفون">${STATE_ICONS.micOff}</i>
                <i class="s-muted ${muted ? 'on' : ''}" title="بی‌صدا توسط مدیر">${STATE_ICONS.micOff}</i>
                <i class="s-camera ${camOff ? 'off' : ''}" title="دوربین">${STATE_ICONS.camOff}</i>
            </span>`;
        li.querySelector('.participant-avatar').textContent = (p.name || '?').charAt(0);
        li.querySelector('.participant-name').textContent =
            p.identity === IDENTITY ? `${p.name} (شما)` : p.name;
        li.querySelector('.participant-role').textContent = p.role_label || '';

        if (PRIVILEGED && p.identity !== IDENTITY && p.role !== 'OWNER') {
            li.appendChild(this._hostControls(p));
        } else if (PRIVILEGED) {
            // Rows without a «⋯» keep the same width so the mic/camera badges
            // line up in one column instead of drifting row to row.
            const spacer = document.createElement('div');
            spacer.className = 'host-controls host-controls-empty';
            spacer.setAttribute('aria-hidden', 'true');
            li.appendChild(spacer);
        }
        return li;
    }

    _hostControls(p) {
        // One quiet «⋯» per row instead of a row full of buttons: the roster
        // stays calm and every management action lives in one menu.
        const box = document.createElement('div');
        box.className = 'host-controls';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hc-btn hc-more';
        btn.title = `مدیریت ${p.name}`;
        btn.setAttribute('aria-label', `مدیریت ${p.name}`);
        btn.setAttribute('aria-haspopup', 'menu');
        btn.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#i-more"/></svg>`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openRowMenu(btn, p);
        });
        box.appendChild(btn);
        return box;
    }

    _waitingRow(p) {
        const li = document.createElement('li');
        li.className = 'participant waiting';
        li.innerHTML = `
            <span class="participant-avatar is-waiting"><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg></span>
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

// ---------------------------------------------------------------------------
// Per-participant «⋯» menu (roster)
//
// Every management action for one member lives here so the participant row
// stays a single line.  Two distinct moderation actions, as requested:
//   • حذف از کلاس  → the member is disconnected but may join again
//   • اخراج         → removed *and* blocked for a chosen period (server-side
//                     `banned_until`, re-checked on every join attempt)
// ---------------------------------------------------------------------------
let rowMenu = null;
let rowMenuAnchor = null;
let rowMenuPlace = null;

const BAN_CHOICES = [
    { id: 5, label: '۵ دقیقه' },
    { id: 60, label: '۱ ساعت' },
    { id: 1440, label: '۱ روز' },
    { id: 10080, label: '۷ روز' },
];

function closeRowMenu() {
    if (!rowMenu) return;
    rowMenu.remove();
    rowMenu = null;
    rowMenuAnchor?.setAttribute('aria-expanded', 'false');
    rowMenuAnchor = null;
    rowMenuPlace = null;
    document.removeEventListener('click', onRowMenuOutside, true);
    document.removeEventListener('keydown', onRowMenuKey, true);
    window.removeEventListener('resize', repositionRowMenu);
}

function onRowMenuOutside(e) {
    if (rowMenu && !rowMenu.contains(e.target) && !rowMenuAnchor?.contains(e.target)) closeRowMenu();
}
function onRowMenuKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeRowMenu(); }
}
function repositionRowMenu() {
    if (rowMenu && rowMenuAnchor) rowMenuPlace?.();
}

function placeRowMenu(anchor, menu) {
    const place = () => {
        const r = anchor.getBoundingClientRect();
        const w = menu.offsetWidth;
        const h = menu.offsetHeight;
        const margin = 8;
        // centre on the «⋯» and clamp inside the viewport: the roster lives in a
        // narrow rail, so a one-sided dropdown would hang off the screen edge.
        let left = r.left + r.width / 2 - w / 2;
        left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
        let top = r.bottom + 6;
        const viewH = window.visualViewport
            ? Math.min(window.innerHeight, window.visualViewport.height)
            : window.innerHeight;
        if (top + h > viewH - margin) top = Math.max(margin, r.top - h - 6);
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    };
    place();
    return place;
}

async function kickMember(p) {
    const ok = await confirmDialog(
        'حذف از کلاس',
        `${p.name} از کلاس بیرون انداخته شود؟ می‌تواند دوباره از لینک کلاس وارد شود.`,
        { danger: true, okLabel: 'حذف از کلاس' },
    );
    if (!ok) return;
    try {
        await api(`/members/${p.member_id}/remove/`, { ban_minutes: 0 });
        toast(`${p.name} از کلاس حذف شد.`, 'info', 2500);
    } catch (err) { /* api() already surfaced the reason */ }
}

async function banMember(p) {
    const minutes = await choiceDialog(
        'اخراج و مسدودسازی',
        `«${p.name}» از کلاس اخراج و برای مدت انتخاب‌شده از ورود مجدد منع می‌شود.`,
        [...BAN_CHOICES.map((c) => ({ id: c.id, label: c.label, tone: 'ghost' })),
         { id: null, label: 'انصراف', tone: 'ghost' }],
    );
    if (!minutes) return;
    try {
        await api(`/members/${p.member_id}/remove/`, { ban_minutes: minutes });
        toast(`${p.name} اخراج و مسدود شد.`, 'info', 3000);
    } catch (err) { /* api() already surfaced the reason */ }
}

function openRowMenu(anchor, p) {
    const same = rowMenu && rowMenuAnchor === anchor;
    closeRowMenu();
    if (same) return; // second press closes

    const menu = document.createElement('div');
    menu.className = 'row-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `مدیریت ${p.name}`);

    const item = (icon, label, fn, tone = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.className = `row-menu-item ${tone}`.trim();
        b.innerHTML = `<svg class="mi" aria-hidden="true"><use href="${icon}"/></svg><span></span>`;
        b.querySelector('span').textContent = label;
        b.addEventListener('click', async () => { closeRowMenu(); await fn(); });
        menu.appendChild(b);
    };

    menu.appendChild(Object.assign(document.createElement('div'), {
        className: 'row-menu-head', textContent: p.name,
    }));
    item(p.muted ? '#i-mic' : '#i-mic-off', p.muted ? 'باصدا کردن' : 'بی‌صدا کردن', () =>
        api(`/members/${p.member_id}/mute/`, { muted: !p.muted }));
    item('#i-hand', 'درخواست روشن کردن میکروفون', () =>
        api(`/members/${p.member_id}/mute/`, { request_unmute: true }));
    item('#i-shield', 'دسترسی‌ها و نقش', () => openPermsDialog(p.identity));

    if (SELF_ROLE === 'OWNER' && p.role !== 'OWNER') {
        const sep = document.createElement('div');
        sep.className = 'row-menu-sep';
        menu.appendChild(sep);
        if (p.role !== 'PRESENTER') {
            item('#i-screen', 'ارتقا به ارائه‌دهنده', () =>
                api(`/members/${p.member_id}/role/`, { role: 'PRESENTER' }));
        }
        if (p.role !== 'MODERATOR') {
            item('#i-users', 'ارتقا به مدیر', () =>
                api(`/members/${p.member_id}/role/`, { role: 'MODERATOR' }));
        }
        if (p.role !== 'STUDENT') {
            item('#i-back', 'تبدیل به دانش‌آموز', () =>
                api(`/members/${p.member_id}/role/`, { role: 'STUDENT' }));
        }
    }

    const dangerSep = document.createElement('div');
    dangerSep.className = 'row-menu-sep';
    menu.appendChild(dangerSep);
    item('#i-leave', 'حذف از کلاس', () => kickMember(p), 'danger');
    item('#i-lock', 'اخراج و مسدودسازی', () => banMember(p), 'danger');

    document.body.appendChild(menu);
    rowMenu = menu;
    rowMenuAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    rowMenuPlace = placeRowMenu(anchor, menu);
    document.addEventListener('click', onRowMenuOutside, true);
    document.addEventListener('keydown', onRowMenuKey, true);
    window.addEventListener('resize', repositionRowMenu);
    menu.querySelector('.row-menu-item')?.focus();
}

// ---------------------------------------------------------------------------
// Member permissions dialog — the owner's (and moderator's) control center.
// Shows every capability flag with a live toggle, plus role + mute + remove.
// State comes from the roster payload (server-computed effective grants).
// ---------------------------------------------------------------------------
let permsTargetIdentity = null;

function openPermsDialog(identity) {
    const p = presence.participants.get(identity);
    if (!p) return;
    permsTargetIdentity = identity;
    document.getElementById('perms-name').textContent = p.name || '';
    fillPermsDialog(p);
    document.getElementById('perms-dialog').showModal();
}

function fillPermsDialog(p) {
    const list = document.getElementById('perms-list');
    list.innerHTML = '';
    const perms = p.permissions || {};
    const wbPolicyNote = document.getElementById('perms-whiteboard-policy-note');
    const studentLike = ['STUDENT', 'GUEST'].includes(p.role);
    const studentBoardEnabled = !!document.querySelector('#settings-form [name="allow_student_whiteboard"]')?.checked;
    if (wbPolicyNote) {
        wbPolicyNote.classList.toggle('hidden', !studentLike);
        wbPolicyNote.textContent = studentBoardEnabled
            ? 'برای دانش‌آموزان، نوشتن روی تخته به مجوز «تختهٔ اشتراکی» همین عضو وابسته است.'
            : 'تنظیم «تختهٔ دانش‌آموزان» در کلاس خاموش است؛ تا روشن نشود، دادن مجوز فردی به دانش‌آموز برای نوشتن کافی نیست.';
    }
    for (const key of PERM_ORDER) {
        if (key === 'can_upload_files' && p.is_guest) continue; // guests never upload
        const row = document.createElement('label');
        row.className = 'switch-row perm-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.perm = key;
        cb.checked = !!perms[key];
        cb.addEventListener('change', async () => {
            const want = cb.checked;
            try {
                // The server's permission_changed event carries the effective
                // value (including class-wide policy). Do not optimistically
                // overwrite the roster with the requested value: a room policy
                // may correctly keep an individual grant ineffective.
                const result = await api(`/members/${p.member_id}/permission/`, { permission: key, value: want });
                const cached = presence.participants.get(p.identity);
                if (cached && result?.permissions) {
                    // Reconcile from the server's effective capability map,
                    // not the requested checkbox value (class-wide policy or
                    // moderation can legitimately keep this grant off).
                    presence.upsert({ ...cached, permissions: result.permissions });
                    refreshPermsDialog(p.identity);
                }
            } catch (err) {
                cb.checked = !want; // server refused — roll the switch back
            }
        });
        const txt = document.createElement('span');
        txt.textContent = PERM_LABELS[key] || key;
        row.append(cb, txt);
        list.appendChild(row);
    }

    const muteBtn = document.getElementById('perms-mute');
    muteBtn.textContent = p.muted ? 'باز کردن بی‌صدا' : 'بی‌صدا کردن';
    muteBtn.onclick = () => api(`/members/${p.member_id}/mute/`, { muted: !p.muted });

    // Role select — owner only (the server rejects role changes by anyone else).
    const roleWrap = document.getElementById('perms-role-wrap');
    const roleSel = document.getElementById('perms-role');
    const canRole = SELF_ROLE === 'OWNER' && p.role !== 'OWNER';
    roleWrap.classList.toggle('hidden', !canRole);
    if (canRole) {
        roleSel.value = ['MODERATOR', 'PRESENTER', 'STUDENT'].includes(p.role) ? p.role : 'STUDENT';
        roleSel.onchange = async () => {
            const role = roleSel.value;
            const label = roleSel.options[roleSel.selectedIndex].text;
            const ok = await confirmDialog(
                'تغییر نقش',
                `نقش «${p.name}» به «${label}» تغییر کند؟ عضو نقش‌های پیش‌فرض تازه می‌گیرد.`,
                { okLabel: 'تغییر نقش' });
            if (!ok) { roleSel.value = p.role; return; }
            try {
                await api(`/members/${p.member_id}/role/`, { role });
                document.getElementById('perms-dialog').close();
            } catch (err) {
                roleSel.value = p.role;
            }
        };
    }

    const rmBtn = document.getElementById('perms-remove');
    rmBtn.onclick = () => {
        document.getElementById('perms-dialog').close();
        kickMember(p);
    };
    const banBtn = document.getElementById('perms-ban');
    if (banBtn) banBtn.onclick = () => {
        document.getElementById('perms-dialog').close();
        banMember(p);
    };
}

/** Patch the open dialog in place when roster/permission events arrive. */
function refreshPermsDialog(identity) {
    if (permsTargetIdentity !== identity) return;
    const dialog = document.getElementById('perms-dialog');
    if (!dialog?.open) { permsTargetIdentity = null; return; }
    const p = presence.participants.get(identity);
    if (!p) { dialog.close(); permsTargetIdentity = null; return; }
    const perms = p.permissions || {};
    document.querySelectorAll('#perms-list input[type=checkbox]').forEach((cb) => {
        const key = cb.dataset.perm;
        if (key && cb.checked !== !!perms[key]) cb.checked = !!perms[key];
    });
    const muteBtn = document.getElementById('perms-mute');
    muteBtn.textContent = p.muted ? 'باز کردن بی‌صدا' : 'بی‌صدا کردن';
    const roleSel = document.getElementById('perms-role');
    if (document.activeElement !== roleSel && ['MODERATOR', 'PRESENTER', 'STUDENT'].includes(p.role)) {
        roleSel.value = p.role;
    }
}

function initPermsDialog() {
    const dialog = document.getElementById('perms-dialog');
    if (!dialog) return;
    document.getElementById('perms-x')?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { permsTargetIdentity = null; });
}


const presence = new PresenceClient();

// ---------------------------------------------------------------------------
// Network awareness
// ---------------------------------------------------------------------------
// Two failures this exists to fix, both invisible until it is too late:
//   * a laptop wakes from sleep or changes network, the socket is already dead
//     but nothing notices until the retry timer fires (up to 15s later);
//   * the user is offline and the room looks merely «slow» instead of saying
//     the internet is gone.
// ``online``/``visibilitychange``/``pageshow`` are the only cheap signals the
// browser offers, so every socket registers here and gets kicked on them.
const Network = {
    banner: null,
    _connectors: [],

    init() {
        this.banner = document.getElementById('net-banner');
        window.addEventListener('online', () => {
            this.sync();
            presence.refreshStatus();
            // A socket that survived the outage is a zombie: force a new one.
            this._kick(true);
        });
        window.addEventListener('offline', () => {
            this.sync();
            presence.refreshStatus();
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.sync();
                this._kick();
            }
        });
        // Restored from the back/forward cache: the socket may be gone.
        window.addEventListener('pageshow', (evt) => {
            if (!evt.persisted) return;
            this.sync();
            this._kick(true);
        });
        this.sync();
    },

    /** A connector is a zero-arg function that reconnects *if* unhealthy. */
    register(fn) {
        if (typeof fn === 'function') this._connectors.push(fn);
    },

    /** Reflect the browser's view of the network in the UI. */
    sync() {
        const offline = navigator.onLine === false;
        document.body.classList.toggle('is-offline', offline);
        if (!this.banner) return;
        this.banner.hidden = !offline;
        this.banner.classList.toggle('show', offline);
    },

    _kick(force = false) {
        if (navigator.onLine === false) return;
        this._connectors.forEach((fn) => {
            try {
                fn(force);
            } catch (err) {
                console.error('[net] reconnect failed', err);
            }
        });
    },
};

// ---------------------------------------------------------------------------
// Boot diagnostics
//
// If any subsystem fails to initialise the room keeps working, the failure is
// logged with its name, and it is collected on window.__vcBoot so a support
// report can just paste it.  Silence was the real bug: a dead init used to
// leave «در حال اتصال…» spinning with nothing in the console.
// ---------------------------------------------------------------------------
window.__vcBoot = { errors: [], bootedAt: new Date().toISOString() };
const _reportedBootErrors = new Set();
function reportBootError(label, err) {
    const message = String((err && (err.message || err)) || 'unknown error');
    window.__vcBoot.errors.push({ label, message });
    if (_reportedBootErrors.has(label)) return;
    _reportedBootErrors.add(label);
    try {
        toast(`بخشی از صفحه («${label}») بالا نیامد. برای جزئیات کنسول مرورگر را ببینید.`, 'error', 7000);
    } catch (toastErr) {
        /* toast is itself optional */
    }
}
window.__vcBoot.report = reportBootError;

function qualityLabel(q) {
    return { excellent: 'عالی', good: 'خوب', poor: 'ضعیف', lost: 'قطع', unknown: 'نامشخص' }[q] || q;
}

// The P2P mesh is O(n²) in connections; past MESH_MAX the host should
// configure the LiveKit media server.  Warn once, host only.
let meshCapacityWarned = false;
function checkMeshCapacity() {
    if (MEDIA_ENABLED || meshCapacityWarned || !PRIVILEGED) return;
    const active = [...presence.participants.values()].filter((p) => !p.in_waiting_room).length;
    if (active > MESH_MAX) {
        meshCapacityWarned = true;
        toast(`اکنون ${active.toLocaleString('fa-IR')} شرکت‌کنندهٔ فعال در حالت شبکهٔ همتا (بدون سرور رسانه) هستید — کیفیت صدا/تصویر افت می‌کند. برای کلاس‌های بزرگ LiveKit را پیکربندی کنید (README).`, 'warning', 9000);
    }
}

function applyOwnPermissionUpdate(permissions, moderation = {}) {
    if (permissions && typeof permissions === 'object') Object.assign(PERMISSIONS, permissions);
    Whiteboard.setPermission(Boolean(PERMISSIONS.can_use_whiteboard));
    Presentation.setPermission(Boolean(PERMISSIONS.can_use_whiteboard));

    // Use both capability flags and the moderator's explicit state. This
    // applies grants/revocations immediately and restores controls on reconnect.
    Media.applyModerationState({
        muted: Boolean(moderation.muted) || !PERMISSIONS.can_use_microphone,
        camera_disabled: Boolean(moderation.camera_disabled) || !PERMISSIONS.can_use_camera,
    });
    if (!PERMISSIONS.can_share_screen) Media.stopScreenShare();
    ChatClient.setSendEnabled(
        Boolean(PERMISSIONS.can_send_messages) || PRIVILEGED,
        'شما اجازهٔ ارسال پیام ندارید.',
    );
    applyFilePresentability();
    applyUploadVisibility();
    syncReadOnlyBanner();
    refreshControlStates();
}

// ---------------------------------------------------------------------------
// Event router — one consistent server protocol
// ---------------------------------------------------------------------------
/** Identities whose join/leave line is already in the chat.
 *  A reconnect replays `user_joined` for people who never left, and the chat
 *  used to announce «… به کلاس پیوست» twice in a row for one arrival. */
const announcedPresence = new Set();

function handleEvent(data) {
    switch (data.type) {
        case 'participant_list': {
            presence.participants.clear();
            data.participants.forEach((p) => {
                if (!p.identity) return;
                presence.participants.set(p.identity, p);
                // Somebody who is already here when we arrive still deserves a
                // «ترک کرد» line later — but not a «پیوست» one now.
                if (p.identity !== IDENTITY) announcedPresence.add(p.identity);
            });
            const ownParticipant = presence.participants.get(IDENTITY);
            if (ownParticipant?.permissions) {
                applyOwnPermissionUpdate(ownParticipant.permissions, {
                    muted: ownParticipant.muted,
                    camera_disabled: ownParticipant.camera_disabled,
                });
            }
            presence.render();
            applyClassroomState(data.classroom || {});
            checkMeshCapacity();
            break;
        }
        case 'user_joined':
            presence.upsert(data.participant);
            checkMeshCapacity();
            if (data.participant.identity !== IDENTITY
                && !announcedPresence.has(data.participant.identity)) {
                announcedPresence.add(data.participant.identity);
                ChatClient.addSystemMessage(`${data.participant.name} به کلاس پیوست.`);
            }
            break;
        case 'user_left':
            presence.remove(data.participant.identity);
            Media.notifyPeerState?.({ identity: data.participant.identity, screen_sharing: false });
            if (permsTargetIdentity === data.participant.identity) refreshPermsDialog(data.participant.identity);
            // Only announce a departure of someone whose arrival was announced:
            // a reconnect burst must not fill the chat with ghost notices.
            if (announcedPresence.delete(data.participant.identity)) {
                ChatClient.addSystemMessage(`${data.participant.name} کلاس را ترک کرد.`);
            }
            break;
        case 'raise_hand':
        case 'lower_hand':
            presence.upsert(data.participant);
            if (data.type === 'raise_hand' && data.participant.identity !== IDENTITY) {
                toast(`${data.participant.name} دست خود را بالا برد.`, 'info', 2500);
            }
            break;
        case 'media_state':
            presence.upsert(data.participant);
            // if the peer stopped sharing, drop the screen view immediately
            Media.notifyPeerState?.(data.participant);
            break;
        case 'permission_changed': {
            const cached = presence.participants.get(data.identity);
            const permissions = data.permissions || (cached?.permissions
                ? { ...cached.permissions, [data.permission]: data.value }
                : null);
            if (cached) {
                presence.upsert({
                    ...cached,
                    permissions: permissions || cached.permissions,
                    muted: data.muted ?? cached.muted,
                    camera_disabled: data.camera_disabled ?? cached.camera_disabled,
                });
            }
            if (data.identity === IDENTITY) {
                applyOwnPermissionUpdate(permissions, {
                    muted: data.muted ?? cached?.muted,
                    camera_disabled: data.camera_disabled ?? cached?.camera_disabled,
                });
            }
            refreshPermsDialog(data.identity);
            break;
        }
        case 'role_changed':
            if (data.identity === IDENTITY) {
                if (data.permissions) Object.assign(PERMISSIONS, data.permissions);
                toast(data.text || 'نقش شما تغییر کرد.', 'success');
                setTimeout(() => location.reload(), 1200); // re-render privileges
            } else {
                const cached = presence.participants.get(data.identity);
                if (data.permissions && cached) cached.permissions = data.permissions;
                presence.upsert({
                    identity: data.identity, role: data.role, role_label: data.role_label,
                    permissions: data.permissions,
                });
                refreshPermsDialog(data.identity);
            }
            break;
        case 'participant_muted': {
            const cached = presence.participants.get(data.identity);
            const permissions = data.permissions || cached?.permissions;
            presence.upsert({
                ...(cached || {}),
                identity: data.identity,
                muted: data.muted,
                camera_disabled: data.camera_disabled ?? cached?.camera_disabled,
                member_id: data.member_id,
                permissions,
            });
            if (data.identity === IDENTITY) {
                applyOwnPermissionUpdate(permissions, {
                    muted: data.muted,
                    camera_disabled: data.camera_disabled,
                });
                if (data.muted) toast('میکروفون شما توسط مدیر بی‌صدا شد.', 'warning');
                else toast('میزبان اجازهٔ میکروفون را به شما برگرداند.', 'success');
            }
            refreshPermsDialog(data.identity);
            break;
        }
        case 'mute_all': {
            const ids = Array.isArray(data.muted_member_ids) ? data.muted_member_ids : null;
            // Without an explicit list fall back to the legacy "everyone
            // except the actor" rule; with one, only listed members apply it
            // (a moderator's mute-all never targets privileged peers).
            const targeted = ids ? ids.includes(MEMBER_ID) : data.except_member_id !== MEMBER_ID;
            if (targeted) {
                toast('همهٔ شرکت‌کنندگان بی‌صدا شدند.', 'warning');
                Media.applyModerationState({ muted: true, camera_disabled: false });
                if (data.can_use_microphone === false) PERMISSIONS.can_use_microphone = false;
                refreshControlStates();
                const me = presence.participants.get(IDENTITY);
                if (me) presence.upsert({ ...me, muted: true, permissions: { ...me.permissions, can_use_microphone: false } });
            }
            if (ids) {
                // keep every roster row + the open dialog honest
                presence.participants.forEach((p) => {
                    if (p.identity !== IDENTITY && ids.includes(p.member_id)) {
                        p.muted = true;
                        if (p.permissions) p.permissions.can_use_microphone = false;
                    }
                });
                presence.scheduleRender();
                if (permsTargetIdentity) refreshPermsDialog(permsTargetIdentity);
            }
            break;
        }
        case 'participant_removed':
            presence.remove(data.identity);
            if (permsTargetIdentity === data.identity) refreshPermsDialog(data.identity);
            Media.notifyPeerState?.({ identity: data.identity, screen_sharing: false });
            if (data.identity === IDENTITY) {
                toast('شما از کلاس حذف شدید.', 'error', 8000);
                setTimeout(() => { location.href = EXIT_URL; }, 1600);
            }
            break;
        case 'notification':
            handleNotification(data);
            break;
        case 'settings_changed': {
            toast('تنظیمات کلاس به‌روزرسانی شد.', 'info', 2200);
            const updates = Array.isArray(data.permission_updates) ? data.permission_updates : [];
            for (const update of updates) {
                if (!update?.identity || !update.permissions) continue;
                const cached = presence.participants.get(update.identity);
                presence.upsert({
                    ...(cached || {}),
                    identity: update.identity,
                    member_id: update.member_id,
                    permissions: update.permissions,
                    muted: update.muted,
                    camera_disabled: update.camera_disabled,
                });
                if (update.identity === IDENTITY) {
                    applyOwnPermissionUpdate(update.permissions, {
                        muted: update.muted,
                        camera_disabled: update.camera_disabled,
                    });
                }
            }
            if (updates.length) {
                presence.scheduleRender();
            } else if (data.settings?.chat_disabled !== undefined) {
                // Backward compatibility with older servers.
                ChatClient.setSendEnabled(
                    !data.settings.chat_disabled || PRIVILEGED,
                    'گفتگو توسط میزبان قطع شده است.'
                );
            }
            break;
        }
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
        case 'classroom_deactivated':
            toast(data.text || 'این کلاس غیرفعال شد.', 'error', 6000);
            break;
        case 'class_ended':
            showClassEnded({ by: data.by || '' });
            break;
        case 'file_uploaded':
            addFileItem(data.file);
            toast(`فایل «${data.file.name}» بارگذاری شد.`, 'info', 2500);
            break;
        case 'file_presentable':
            // The background conversion finished: this file can now be
            // presented (previous broadcast said it could only be downloaded).
            markFilePresentable(data.file_id, data.name);
            break;
        case 'file_deleted':
            removeFileItem(data.file_id);
            toast(`فایل «${data.name}» حذف شد.`, 'info', 2500);
            break;
        case 'presentation_changed':
            if (typeof data.annotation_open === 'boolean') {
                Presentation.applyAnnotationPolicy(data.annotation_open);
                document.getElementById('view-presentation').dataset.annotationOpen =
                    data.annotation_open ? '1' : '0';
            }
            applyPresentation(data);
            break;
        case 'presentation_annotation':
            Presentation.applyAnnotationPolicy(data.open);
            document.getElementById('view-presentation').dataset.annotationOpen =
                data.open ? '1' : '0';
            // Everybody needs to know: otherwise a student keeps tapping a
            // dead canvas — or never notices they may now write.
            toast(
                data.open
                    ? 'نوشتن روی ارائه برای همه باز شد.'
                    : 'نوشتن روی ارائه قفل شد؛ فقط ارائه‌دهنده می‌تواند بنویسد.',
                'info',
                data.open ? 2600 : 3200,
            );
            break;
        case 'quiz_started':
            QuizClient.handleStarted(data);
            break;
        case 'quiz_answered':
            QuizClient.handleProgress(data);
            break;
        case 'quiz_ended':
            QuizClient.handleEnded(data);
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
        case 'reaction':
            // Skip the echo of a bubble we already painted when sending.
            if (_isOwnReactionEcho(data.reaction, data.member_id)) break;
            showReaction(data.reaction, data.name);
            break;
        case 'caption':
            Captions.render({ member_id: data.member_id, name: data.name, text: data.text, final: data.final });
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
            Media.applyModerationState({ muted: true, camera_disabled: false });
            refreshControlStates();
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
    ChatClient.setSendEnabled(
        Boolean(PERMISSIONS.can_send_messages) || PRIVILEGED,
        state.chat_disabled ? 'گفتگو توسط میزبان قطع شده است.' : 'شما اجازهٔ ارسال پیام ندارید.',
    );
    if (typeof state.whiteboard_open === 'boolean') applyWhiteboardState(state.whiteboard_open);
    if (state.current_file_id) {
        applyPresentation({
            file_id: state.current_file_id,
            file_name: state.current_file_name,
            page: state.current_page,
            has_pdf: state.current_file_has_pdf,
        });
    }
    if (state.active_quiz) QuizClient.handleStarted(state.active_quiz);
}

function showLockBadge(locked) {
    let badge = document.getElementById('lock-badge');
    if (locked && !badge) {
        badge = document.createElement('span');
        badge.id = 'lock-badge';
        badge.className = 'badge badge-warn';
        badge.textContent = 'کلاس قفل است';
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
        dot.textContent = 'LIVE';
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

    // Mobile drawer: tapping anywhere outside it (stage, header, dialogs…)
    // closes it — the toggle buttons live under the floating control bar,
    // so an explicit outside gesture guarantees the drawer can always exit.
    document.addEventListener('click', (e) => {
        if (!window.matchMedia('(max-width: 900px)').matches) return;
        const side = document.getElementById('room-side');
        if (!side || !side.classList.contains('drawer-open')) return;
        if (e.target.closest('.room-side, .room-controls, dialog, .toast-container, .messages')) return;
        setDrawer(false);
    });
}

// ---------------------------------------------------------------------------
// Control-bar height → --bar-h
//
// The dock is a layout row, but its height still changes with the viewport
// (a host sees up to 14 controls, a phone gets the compact 38px variant), and
// the floating pieces — PiP camera, toast stack, mobile drawer — are positioned
// against it.  So it is measured, not assumed.
// ---------------------------------------------------------------------------
function trackControlBarHeight() {
    const bar = document.querySelector('.room-controls');
    if (!bar) return;
    const rail = document.getElementById('ctrl-scroll');
    // Fade the edge that hides more controls, so the sideways scroll is
    // discoverable (the scrollbar itself is hidden).
    const fades = () => {
        if (!rail) return;
        const max = rail.scrollWidth - rail.clientWidth;
        const pos = Math.abs(rail.scrollLeft);
        bar.classList.toggle('can-scroll-start', max > 2 && pos > 2);
        bar.classList.toggle('can-scroll-end', max > 2 && pos < max - 2);
    };
    const apply = () => {
        const h = Math.round(bar.getBoundingClientRect().height);
        if (h > 0) {
            root.style.setProperty('--bar-h', `${h}px`);
            // The toast stack lives directly under <body>, where the room's
            // custom properties are not inherited — mirror the height on the
            // document root so it can reserve the same space.
            document.documentElement.style.setProperty('--bar-h', `${h}px`);
        }
        fades();
    };
    apply();
    if (window.ResizeObserver) {
        new ResizeObserver(apply).observe(bar);
    } else {
        window.addEventListener('resize', apply);
    }
    // Safe-guard: a font/permission change can resize the bar later on.
    window.addEventListener('load', apply);
    document.addEventListener('fullscreenchange', apply);
    if (rail) {
        rail.addEventListener('scroll', fades, { passive: true });
        new ResizeObserver(fades).observe(rail);
        // Keyboard users must see the button they just tabbed to.
        rail.addEventListener('focusin', (e) => {
            e.target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        });
        // Re-centre the rail after an orientation change.
        window.addEventListener('orientationchange', () => { rail.scrollLeft = 0; fades(); });
    }
}

// ---------------------------------------------------------------------------
// Chat composer height → --composer-h
//
// On phones the side panel is a drawer whose composer is pinned to the bottom;
// the toast stack lifts by this much so it never covers the field being typed
// into.  A closed drawer is `display:none` on the desktop grid (and off-screen
// when it is a drawer), so the measured height is the honest 0 there.
// ---------------------------------------------------------------------------
function trackComposerHeight() {
    const form = document.querySelector('.room-side .chat-form');
    if (!form) return;
    const apply = () => {
        document.documentElement.style.setProperty('--composer-h', `${Math.round(form.offsetHeight)}px`);
    };
    apply();
    if (window.ResizeObserver) new ResizeObserver(apply).observe(form);
    else window.addEventListener('resize', apply);
}

// ---------------------------------------------------------------------------
// Device-test card height → --dt-h
//
// The first-run test card floats over the bottom of the room, in the same
// band the toast stack occupies, so the stack lifts by its height instead of
// landing on its buttons.  A ResizeObserver on a display:none card reports 0,
// which is exactly the offset we want.
// ---------------------------------------------------------------------------
function trackDeviceTestHeight() {
    const card = document.getElementById('device-test-card');
    if (!card) return;
    const apply = () => {
        const h = card.classList.contains('hidden') ? 0 : Math.round(card.getBoundingClientRect().height);
        document.documentElement.style.setProperty('--dt-h', `${h}px`);
    };
    apply();
    if (window.ResizeObserver) new ResizeObserver(apply).observe(card);
    else window.addEventListener('resize', apply);
}

// ---------------------------------------------------------------------------
// Mobile drawer: backdrop + Escape + auto-close on wide screens
// ---------------------------------------------------------------------------
/** Panel state on desktop (docked) and on phones (drawer). */
function isSideOpen() {
    if (window.matchMedia('(max-width: 900px)').matches) {
        return document.getElementById('room-side')?.classList.contains('drawer-open') ?? false;
    }
    return !document.getElementById('room-body')?.classList.contains('side-closed');
}

function setSideOpen(open) {
    if (window.matchMedia('(max-width: 900px)').matches) { setDrawer(open); return; }
    const body = document.getElementById('room-body');
    if (!body) return;
    body.classList.toggle('side-closed', !open);
    try { localStorage.setItem('room.side', open ? 'open' : 'closed'); } catch (e) { /* private mode */ }
    // The control bar is anchored to the stage, which just changed width.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function setDrawer(open) {
    const side = document.getElementById('room-side');
    const backdrop = document.getElementById('drawer-backdrop');
    if (!side) return;
    side.classList.toggle('drawer-open', open);
    if (backdrop) backdrop.classList.toggle('open', open);
}

/** The empty stage offers the two things that fill it, plus the class link.
 *  Static hint chips looked like decoration; buttons actually start the class. */
function initStageEmpty() {
    const actions = { mic: 'btn-mic', camera: 'btn-camera' };
    document.querySelectorAll('[data-stage-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.stageAction;
            if (actions[action]) {
                document.getElementById(actions[action])?.click();
                return;
            }
            if (action === 'link') {
                const link = window.location.href;
                const done = () => toast('لینک کلاس کپی شد.', 'info', 2400);
                if (navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(link).then(done).catch(() => window.prompt('لینک کلاس:', link));
                } else {
                    window.prompt('لینک کلاس:', link);
                }
            }
        });
    });
}

function initDrawer() {
    try {
        if (localStorage.getItem('room.side') === 'closed') setSideOpen(false);
    } catch (e) { /* private mode */ }
    document.getElementById('drawer-close')?.addEventListener('click', () => setDrawer(false));
    const backdrop = document.getElementById('drawer-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => setDrawer(false));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setDrawer(false);
    });
    // The docked control bar stays live while the drawer is open (it is not
    // under the backdrop), so it doubles as the way out: any control except the
    // two toggles closes the panel instead of acting on a covered stage.
    document.querySelector('.room-controls')?.addEventListener('click', (e) => {
        const toggle = e.target.closest('#btn-chat, #btn-people');
        if (toggle) return;
        if (document.getElementById('room-side')?.classList.contains('drawer-open')) {
            setDrawer(false);
        }
    }, true);
    // Rotating or resizing back to the docked layout must not leave a
    // stale full-screen drawer (and its backdrop) over the stage.
    const reset = () => {
        if (window.matchMedia('(min-width: 901px)').matches) setDrawer(false);
    };
    window.addEventListener('resize', reset);
    window.addEventListener('orientationchange', reset);
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
    if (name === 'chat') {
        ChatClient.resetUnread();
        // Opening the tab should land on the newest message, not wherever
        // this browser last left the scrollbar.
        ChatClient.jumpToLatest();
    }
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
        if (Whiteboard.unavailable) return toast('کتابخانهٔ تخته بارگذاری نشد؛ صفحه را تازه کنید.', 'error');
        const showing = !document.getElementById('view-whiteboard').classList.contains('hidden');
        if (!CAN_CONTROL_BOARD) {
            // Read-only members may still *watch* the board.  This is a local
            // view switch only — opening it for the whole class belongs to the
            // authority roles and is enforced server-side too.
            switchView(showing ? 'media' : 'whiteboard');
            document.getElementById('btn-whiteboard')?.classList.toggle('active', !showing);
            if (!showing) setTimeout(() => Whiteboard.resize(), 60);
            return;
        }
        // Ask the server to broadcast the state so EVERYONE sees the board.
        presence.send({ action: 'whiteboard_state', open: !showing });
    });
    bind('btn-chat', () => {
        const open = isSideOpen();
        const onChat = document.querySelector('.side-tab[data-tab="chat"]')?.classList.contains('active');
        // open if closed; switch tab if open on another tab; close only when
        // re-pressing the toggle for the tab that is already showing
        activateTab('chat');
        const show = !(open && onChat);
        setSideOpen(show);
        if (show) document.getElementById('chat-input').focus();
    });
    bind('btn-people', () => {
        const open = isSideOpen();
        const onPeople = document.querySelector('.side-tab[data-tab="participants"]')?.classList.contains('active');
        activateTab('participants');
        setSideOpen(!(open && onPeople));
    });
    document.getElementById('side-collapse')?.addEventListener('click', () => setSideOpen(false));
    bind('btn-exit-screen', () => switchView('media'));
    bind('btn-exit-presentation', () => switchView('media'));
    bind('cam-pip-fs', () => {
        const pip = document.getElementById('cam-pip');
        const video = document.getElementById('cam-pip-video');
        const target = video && video.readyState > 0 ? video : pip;
        if (document.fullscreenElement) document.exitFullscreen?.();
        else target?.requestFullscreen?.().catch(() => {});
    });
    bind('btn-exit', async () => {
        if (!IS_OWNER) {
            if (await confirmDialog('خروج از کلاس', 'از کلاس خارج شوید؟ برای ورود مجدد باید دوباره به کلاس بپیوندید.', { danger: true, okLabel: 'خروج' })) {
                submitLeave();
            }
            return;
        }
        // The owner always chooses: leave quietly, or close the class for
        // everyone (server-side: memberships are revoked and every client
        // shows the "class is over" panel).
        const choice = await choiceDialog(
            'خروج از کلاس',
            'می‌خواهید فقط خودتان از کلاس خارج شوید یا کلاس برای همهٔ شرکت‌کنندگان تمام شود؟',
            [
                { id: 'self', label: 'فقط خودم خارج می‌شوم', tone: 'primary' },
                { id: 'end', label: 'پایان کلاس برای همه', tone: 'danger' },
                { id: null, label: 'انصراف', tone: 'ghost' },
            ],
        );
        if (choice === 'self') {
            submitLeave();
        } else if (choice === 'end') {
            const sure = await confirmDialog(
                'پایان کلاس',
                'کلاس برای همه بسته می‌شود و همه از جلسه بیرون می‌آیند. ادامه می‌دهید؟',
                { danger: true, okLabel: 'پایان کلاس' },
            );
            if (!sure) return;
            try {
                await api('/end-class/');
                showClassEnded({ by: 'شما', owner: true });
            } catch (err) { /* toast already shown by api() */ }
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
        initRecording();
        initSettingsModal();
    }
}

/**
 * Anchor a fixed-position popover above `anchor`.
 * The control bar clips its own overflow and uses backdrop-filter (which
 * becomes the containing block), so popovers live on <body> and are placed
 * against the anchor's live rect; the returned function re-places them.
 */
function anchorPopover(anchor, pop, gap = 8) {
    const place = () => {
        const rect = anchor.getBoundingClientRect();
        const margin = 8;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Cap the popover to the space that actually exists above its anchor.
        // Without this a tall menu simply grew past the top edge of a phone
        // screen — the first rows were unreachable, and the panel read as a
        // sheet that had eaten the whole page.
        const above = Math.round(rect.top - gap - margin);
        const maxH = Math.max(140, Math.min(above, Math.round(vh * 0.72)));
        pop.style.maxHeight = `${maxH}px`;
        pop.style.overflowY = 'auto';
        pop.style.overscrollBehavior = 'contain';
        const half = (pop.offsetWidth || 200) / 2;
        const left = Math.max(half + margin, Math.min(rect.left + rect.width / 2, vw - half - margin));
        pop.style.left = `${Math.round(left)}px`;
        pop.style.top = `${Math.round(rect.top - gap)}px`;
    };
    place();
    return place;
}

// ---------------------------------------------------------------------------
// Session recording — local only (no server, no upload).
//
// The dock button opens a quality popover, `recorder.js` composites the stage
// and mixes every participant's audio on the device, and the finished WebM is
// playable right here before the host saves or discards it.
// ---------------------------------------------------------------------------
function initRecording() {
    const btn = document.getElementById('btn-record');
    if (!btn) return;
    const timerEl = document.getElementById('rec-timer');

    let tray = null;
    let tick = null;
    let lastUrl = '';
    let starting = false;

    const pad = (n) => String(n).padStart(2, '0');
    const clock = (s) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
    const fileSize = (bytes) => (bytes >= 1048576
        ? `${(bytes / 1048576).toFixed(1)} مگابایت`
        : `${Math.max(1, Math.round(bytes / 1024))} کیلوبایت`);

    const syncButton = () => {
        const on = Recorder.recording;
        btn.classList.toggle('recording', on);
        btn.setAttribute('aria-pressed', String(on));
        btn.title = on ? 'پایان ضبط و ذخیرهٔ فایل' : 'ضبط جلسه (ذخیره در دستگاه شما)';
        timerEl?.classList.toggle('hidden', !on);
        clearInterval(tick);
        tick = null;
        if (on) {
            const refresh = () => { if (timerEl) timerEl.textContent = clock(Recorder.elapsed); };
            refresh();
            tick = setInterval(refresh, 1000);
        }
    };

    // ---- quality popover (same anchoring trick as the reactions tray) ----
    const hideTray = () => {
        tray?.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
    };
    const showTray = () => {
        if (!tray) return;
        tray.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        tray._place?.();
    };
    const buildTray = () => {
        const el = document.createElement('div');
        el.className = 'rec-tray hidden';
        el.setAttribute('role', 'menu');
        el.setAttribute('aria-label', 'کیفیت ضبط');
        el.innerHTML = `
            <button type="button" class="rec-option" data-mode="light" role="menuitem">
                <span class="rec-option-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5a8.5 8.5 0 1 1 8.5-8.5"/><path d="M12 12l4.6-4.6"/></svg></span>
                <span class="rec-option-tx"><strong>ضبط سبک <em>پیشنهادی</em></strong>
                    <span>۱۲ فریم · ۴۸۰p — کمترین فشار روی سیستم و اینترنت</span></span>
            </button>
            <button type="button" class="rec-option" data-mode="hd" role="menuitem">
                <span class="rec-option-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.6" y="5" width="18.8" height="12.4" rx="2.4"/><path d="M8.4 20.4h7.2M12 17.4v3"/></svg></span>
                <span class="rec-option-tx"><strong>ضبط با کیفیت</strong>
                    <span>۲۴ فریم · ۷۲۰p — واضح‌تر، ولی حجم و مصرف بالاتر</span></span>
            </button>
            <p class="rec-tray-note">تصویر صحنه و صدای همه روی همین دستگاه ضبط می‌شود؛ چیزی به سرور فرستاده نمی‌شود.</p>`;
        document.body.appendChild(el);
        el.querySelectorAll('[data-mode]').forEach((opt) => {
            opt.addEventListener('click', () => {
                hideTray();
                startRecording(opt.dataset.mode);
            });
        });
        document.addEventListener('click', (e) => {
            if (el.classList.contains('hidden')) return;
            if (el.contains(e.target) || btn.contains(e.target)) return;
            hideTray();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') hideTray();
        });
        // Reposition (never close) on scroll: focusing a dock button can
        // scroll the page, and closing here made the tray vanish on click.
        el._place = () => anchorPopover(btn, el);
        window.addEventListener('scroll', () => {
            if (!el.classList.contains('hidden')) el._place();
        }, true);
        window.addEventListener('resize', () => {
            if (!el.classList.contains('hidden')) el._place();
        });
        return el;
    };

    // ---- recording lifecycle ----
    const startRecording = async (mode) => {
        if (starting || Recorder.recording) return;
        starting = true;
        btn.classList.add('starting');
        try {
            // Free the previous file before allocating a new one.
            if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = ''; }
            await Recorder.start(mode);
            syncButton();
            toast(
                mode === 'hd'
                    ? 'ضبط با کیفیت آغاز شد — فایل روی دستگاه شما می‌ماند.'
                    : 'ضبط سبک آغاز شد — فایل روی دستگاه شما می‌ماند.',
                'info',
                3200,
            );
        } catch (err) {
            const reason = err?.message;
            if (reason === 'no-media') {
                toast('چیزی برای ضبط نیست — دوربین، اشتراک صفحه یا میکروفون را روشن کنید.', 'warning');
            } else {
                toast('مرورگر شما از ضبط پشتیبانی نمی‌کند.', 'error');
            }
        } finally {
            starting = false;
            btn.classList.remove('starting');
        }
    };

    const stopRecording = async () => {
        if (!Recorder.recording) return;
        const result = await Recorder.stop();
        syncButton();
        if (!result || !result.blob?.size) {
            toast('ضبط خیلی کوتاه بود؛ فایلی ساخته نشد.', 'warning');
            return;
        }
        if (result.reason === 'size') toast('حجم ضبط به سقف رسید و خودکار متوقف شد.', 'warning');
        if (result.reason === 'duration') toast('حداکثر مدت ضبط (۲ ساعت) پر شد.', 'warning');
        if (result.url) {
            lastUrl = result.url;
            showRecordingPlayer(result);
        }
    };

    /** Instant playback + save/discard, without ever leaving the room. */
    const showRecordingPlayer = (rec) => {
        const wrap = document.createElement('div');
        wrap.className = 'rec-result';

        const video = document.createElement('video');
        video.className = 'rec-video';
        video.controls = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.src = rec.url;
        // MediaRecorder blobs carry no duration in the WebM header, which
        // makes the seek bar useless. Nudging currentTime forces Chrome/Safari
        // to compute it, then we jump back to the start.
        video.addEventListener('loadedmetadata', () => {
            if (Number.isFinite(video.duration)) return;
            video.currentTime = 1e101;
            const reset = () => {
                video.removeEventListener('timeupdate', reset);
                video.currentTime = 0;
            };
            video.addEventListener('timeupdate', reset);
        });

        const meta = document.createElement('p');
        meta.className = 'rec-meta';
        meta.textContent = `مدت ${clock(rec.duration / 1000)} · حجم ${fileSize(rec.size)} · `
            + (rec.preset === 'hd' ? 'کیفیت بالا' : 'ضبط سبک')
            + ' · فقط روی همین دستگاه';

        const actions = document.createElement('div');
        actions.className = 'rec-actions';
        const save = document.createElement('a');
        save.className = 'btn btn-primary';
        save.href = rec.url;
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        save.download = `classroom-${ROOM_CODE}-${stamp}.webm`;
        save.textContent = 'ذخیره روی دستگاه';
        const discard = document.createElement('button');
        discard.type = 'button';
        discard.className = 'btn btn-ghost';
        discard.textContent = 'حذف';
        discard.addEventListener('click', () => {
            URL.revokeObjectURL(rec.url);
            lastUrl = '';
            video.removeAttribute('src');
            video.load();
            discard.closest('dialog')?.close('ok');
            toast('ضبط حذف شد.', 'info');
        });
        actions.append(save, discard);

        wrap.append(video, meta, actions);
        infoDialog('ضبط جلسه آماده است', wrap, 'بستن');
    };

    if (!Recorder.supported) {
        btn.classList.add('hidden');
        return;
    }

    tray = buildTray();
    Recorder.onChange = syncButton;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (Recorder.recording) {
            hideTray();
            stopRecording();
        } else if (tray.classList.contains('hidden')) {
            showTray();
        } else {
            hideTray();
        }
    });

    // A closed tab mid-recording must not lose the file silently.
    window.addEventListener('beforeunload', (e) => {
        if (!Recorder.recording) return;
        e.preventDefault();
        e.returnValue = '';
    });
    window.addEventListener('pagehide', () => Recorder.dispose());
}

function switchView(view) {
    for (const id of ['media', 'screen', 'whiteboard', 'presentation']) {
        document.getElementById(`view-${id}`).classList.toggle('hidden', id !== view);
    }
    if (view === 'whiteboard') setTimeout(() => Whiteboard.resize(), 60);
    syncPresReturnChip();
    // picture-in-picture camera for the full-stage views (whiteboard/
    // presentation/screen) — the media engine decides what to show.
    Media.updatePip(view);
}
window.__switchView = switchView; // used by presentation module below
window.__media = Media;           // debugging + automated smoke tests
window.__wb = Whiteboard;         // debugging + automated smoke tests

/** Mirror «nothing is granted yet» into the read-only notice. */
function syncReadOnlyBanner() {
    const banner = document.getElementById('readonly-banner');
    if (!banner) return;
    // Read-only means *no* capability at all — the same rule the server uses
    // for the `read_only` context flag.  A single grant (chat, a raised hand,
    // ink) is already "allowed to do something".
    banner.hidden = PERM_ORDER.some((key) => Boolean(PERMISSIONS[key]));
}

function refreshControlStates() {
    const micBtn = document.getElementById('btn-mic');
    micBtn?.classList.toggle('off', !PERMISSIONS.can_use_microphone);
    document.getElementById('btn-camera')?.classList.toggle('off', !PERMISSIONS.can_use_camera);
    document.getElementById('btn-screen')?.classList.toggle('off', !PERMISSIONS.can_share_screen);
    document.getElementById('btn-hand')?.classList.toggle('off', !PERMISSIONS.can_raise_hand);
    document.getElementById('btn-reactions')?.classList.toggle('off', !PERMISSIONS.can_raise_hand);
    // Not dimmed: read-only members still open the board to watch it — but the
    // button says so, and the toolbar hides its tools (the server re-checks
    // permission on every operation anyway).
    const wbBtn = document.getElementById('btn-whiteboard');
    if (wbBtn) {
        const viewOnly = !PERMISSIONS.can_use_whiteboard;
        wbBtn.classList.toggle('view-only', viewOnly);
        wbBtn.title = viewOnly ? 'تخته سفید — فقط نمایش' : 'تخته سفید';
        wbBtn.setAttribute('aria-label', wbBtn.title);
    }
}

// ---------------------------------------------------------------------------
// "More" menu — permission-filtered
// ---------------------------------------------------------------------------
let menuPlace = () => {};

/** Mirror the parked controls' pressed state onto their menu rows. */
function syncMenuStates() {
    document.querySelectorAll('.menu-sync[data-sync]').forEach((row) => {
        const source = document.getElementById(row.dataset.sync);
        if (!source || !row.hasAttribute('aria-pressed')) return;
        row.setAttribute('aria-pressed', source.getAttribute('aria-pressed') || 'false');
    });
}

function toggleMoreMenu(force) {
    const menu = document.getElementById('more-menu');
    const btn = document.getElementById('btn-more');
    const show = force !== undefined ? force : !menu.classList.contains('show');
    // On phones the side panel is a full-height drawer stacked above the
    // control bar, so an open drawer would cover the menu completely.
    if (show) setDrawer(false);
    btn.setAttribute('aria-expanded', String(show));
    if (show) {
        syncMenuStates();
        menu.classList.remove('hidden');
        // The control bar scrolls its own overflow, and the menu is taller
        // than the bar — park it on <body> and place it above the button.
        if (menu.parentElement !== document.body) document.body.appendChild(menu);
        menuPlace = anchorPopover(btn, menu, 10);
        window.addEventListener('resize', menuPlace);
        // Next frame so the spring-in transition actually runs.
        requestAnimationFrame(() => menu.classList.add('show'));
        menu.querySelector('button')?.focus();
    } else {
        window.removeEventListener('resize', menuPlace);
        menu.classList.remove('show');
        window.setTimeout(() => {
            if (!menu.classList.contains('show')) menu.classList.add('hidden');
        }, 220);
    }
}

function initMoreMenu() {
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('more-menu');
        if (menu.classList.contains('show') &&
            !menu.contains(e.target) && e.target.closest('#btn-more') === null) {
            toggleMoreMenu(false);
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const menu = document.getElementById('more-menu');
        const menuWasOpen = !menu.classList.contains('hidden');
        toggleMoreMenu(false);
        // Escape also dismisses the mobile drawer (when no menu was open)
        if (!menuWasOpen && window.matchMedia('(max-width: 900px)').matches) {
            setDrawer(false);
        }
    });

    const bind = (id, fn) => document.getElementById(id)?.addEventListener('click', () => { toggleMoreMenu(false); fn(); });
    // Rows that mirror a parked control: click the original node so the one
    // handler (and its state) stays authoritative, then mirror its aria-pressed.
    document.querySelectorAll('.menu-sync').forEach((row) => {
        row.addEventListener('click', () => {
            document.getElementById(row.dataset.sync)?.click();
            syncMenuStates();
            toggleMoreMenu(false);
        });
    });
    bind('menu-devices', openDevicesDialog);
    bind('menu-theme', () => {
        const order = ['system', 'light', 'dark'];
        const next = order[(order.indexOf(window.UITheme.preference) + 1) % order.length];
        window.UITheme.set(next);
        toast(`پوسته: ${{ system: 'خودکار', light: 'روشن', dark: 'تیره' }[next]}`, 'info', 1800);
    });
        bind('menu-settings', () => document.getElementById('settings-dialog')?.showModal());
        bind('btn-settings', () => document.getElementById('settings-dialog')?.showModal());
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
            <li><kbd>R</kbd> ارسال واکنش سریع (قلب)</li>
            <li><kbd>Esc</kbd> بستن سینی واکنش‌ها و پنجره‌ها</li>
            <li class="shortcut-sep">در تختهٔ سفید:</li>
            <li><kbd>P</kbd> قلم &nbsp;·&nbsp; <kbd>H</kbd> هایلایت &nbsp;·&nbsp; <kbd>E</kbd> پاک‌کن</li>
            <li><kbd>L</kbd> نشانگر لیزری &nbsp;·&nbsp; <kbd>T</kbd> متن</li>
            <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> بازگشت &nbsp;·&nbsp; <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> جلو</li>
        </ul>
        <p class="muted small">هنگام تایپ در فیلدهای متنی، میان‌برها غیرفعال‌اند.</p>`);
}

function showHelp() {
    infoDialog('راهنمای کلاس', `
        <ul class="shortcut-list">
            <li>از نوار پایین میکروفون و دوربین را کنترل کنید.</li>
            <li>با دکمهٔ «دست بالا» از میزبان اجازهٔ صحبت بگیرید؛ برای واکنش سریع، دکمهٔ قلب کنار آن را بزنید.</li>
            <li>چیدمان صحنه را از دکمه‌های بالای ویدیوها تغییر دهید؛ انتخاب شما ذخیره می‌شود.</li>
            <li>⋯ منوی «بیشتر»: دستگاه‌ها، پوسته، تنظیمات و گزارش مشکل.</li>
            <li>دسترسی‌ها (میکروفون، دوربین، تخته، گفتگو) توسط میزبان مدیریت می‌شود.</li>
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
            ChatClient.send(`گزارش مشکل: ${text.slice(0, 300)}`);
            toast('گزارش شما ارسال شد.', 'success');
        }
    });
}

// ---------------------------------------------------------------------------
// Devices dialog — change devices mid-class, no rejoin
// ---------------------------------------------------------------------------
/**
 * Browsers hide device names until access is granted.  Ask for a throw-away
 * stream (and release it at once) so the dropdowns show real names instead of
 * "میکروفون ۱" — otherwise nobody can tell which device they are picking.
 */
async function ensureDeviceLabels() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }
    if (devices.some((d) => d.kind !== 'audiooutput' && d.label)) return;   // unlocked
    for (const constraints of [{ audio: true, video: true }, { audio: true }, { video: true }]) {
        let tmp = null;
        try { tmp = await navigator.mediaDevices.getUserMedia(constraints); } catch (e) { /* denied */ }
        if (tmp) { tmp.getTracks().forEach((t) => t.stop()); return; }
    }
}

async function fillDeviceSelects() {
    const camSel = document.getElementById('dev-camera');
    const micSel = document.getElementById('dev-mic');
    const spkSel = document.getElementById('dev-speaker');
    if (!camSel || !micSel || !spkSel) return;
    const devices = await Media.listDevices();
    const fill = (sel, kind, fallback, allowed) => {
        const current = sel.value;
        sel.innerHTML = '';
        const items = devices.filter((d) => d.kind === kind);
        if (!items.length) {
            const opt = document.createElement('option');
            opt.value = '';                       // never send a label as an id
            opt.disabled = true;
            opt.textContent = `بدون ${fallback}`;
            sel.appendChild(opt);
            sel.disabled = true;
            return;
        }
        sel.disabled = !allowed;
        items.forEach((d, i) => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `${fallback} ${i + 1}`;
            sel.appendChild(opt);
        });
        if (current && items.some((d) => d.deviceId === current)) sel.value = current;
    };
    fill(camSel, 'videoinput', 'دوربین', PERMISSIONS.can_use_camera !== false);
    fill(micSel, 'audioinput', 'میکروفون', PERMISSIONS.can_use_microphone !== false);
    fill(spkSel, 'audiooutput', 'بلندگو', true);
    if (!('setSinkId' in HTMLAudioElement.prototype)) {
        spkSel.disabled = true;
        spkSel.title = 'انتخاب بلندگو در این مرورگر پشتیبانی نمی‌شود';
    }
}

async function openDevicesDialog() {
    const dialog = document.getElementById('devices-dialog');
    const feedback = document.getElementById('dev-feedback');
    if (feedback) { feedback.textContent = 'در حال دریافت فهرست دستگاه‌ها…'; feedback.className = 'muted small'; }
    await ensureDeviceLabels();
    await fillDeviceSelects();
    if (feedback) feedback.textContent = '';
    dialog.showModal();
}

function initDevicesDialog() {
    const dialog = document.getElementById('devices-dialog');
    document.getElementById('devices-close').addEventListener('click', () => dialog.close());
    document.getElementById('devices-apply').addEventListener('click', async () => {
        const feedback = document.getElementById('dev-feedback');
        feedback.className = 'muted small';
        feedback.textContent = 'در حال اعمال…';
        const cam = document.getElementById('dev-camera').value;
        const mic = document.getElementById('dev-mic').value;
        const spk = document.getElementById('dev-speaker').value;
        try {
            // Empty value == the "no device" placeholder: skip it, and report
            // the real per-device outcome instead of always claiming success.
            const results = [];
            if (cam) results.push(['دوربین', await Media.setCameraDevice(cam)]);
            if (mic) results.push(['میکروفون', await Media.setMicDevice(mic)]);
            if (spk) results.push(['بلندگو', await Media.setOutputDevice(spk)]);
            const failed = results.filter(([, ok]) => !ok).map(([name]) => name);
            if (!results.length) {
                feedback.textContent = 'دستگاهی برای اعمال انتخاب نشده است.';
            } else if (failed.length) {
                feedback.textContent = `${failed.join(' و ')} اعمال نشد — دستگاه در دسترس نیست.`;
            } else {
                feedback.textContent = 'دستگاه‌ها اعمال شد.';
                setTimeout(() => dialog.close(), 700);
            }
        } catch (err) {
            feedback.textContent = `اعمال ناموفق بود: ${err.message || ''}`;
        }
    });

    // Plugging in a headset mid-class should be visible immediately.
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', () => {
            if (dialog.open) fillDeviceSelects();
        });
    }
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts — disabled while typing
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Quick reactions — ephemeral, never stored, animated for everyone
// ---------------------------------------------------------------------------
const REACTION_ICONS = {
    heart: '#i-heart', clap: '#i-clap', thumbs: '#i-thumbs',
    star: '#i-star', question: '#i-question',
};

/**
 * Locally rendered reactions, so the sender sees their own bubble immediately
 * instead of waiting for the server to echo it back — and so a dropped socket
 * can never look like "the button does nothing".
 * `{ key, at }` — used to ignore the echo of our own reaction.
 */
const _recentReactions = [];

function _noteLocalReaction(key) {
    const now = Date.now();
    _recentReactions.push({ key, at: now });
    while (_recentReactions.length > 12) _recentReactions.shift();
    return now;
}

/** True when this echo belongs to a bubble we already painted ourselves. */
function _isOwnReactionEcho(key, memberId) {
    if (Number(memberId) !== MEMBER_ID) return false;
    const now = Date.now();
    for (let i = _recentReactions.length - 1; i >= 0; i--) {
        const item = _recentReactions[i];
        if (now - item.at > 2500) { _recentReactions.splice(i, 1); continue; }
        if (item.key === key) { _recentReactions.splice(i, 1); return true; }
    }
    return false;
}

function showReaction(key, name) {
    const icon = REACTION_ICONS[key];
    const layer = document.getElementById('reaction-layer');
    if (!icon || !layer) return;
    // Reduced motion means *less movement*, never *less feedback*: this used to
    // return early, so on any phone with "Reduce Motion" (or in the reduced
    // theme) the reaction silently vanished — the report was «واکنش می‌دهم،
    // هیچ چیز روی صفحه نمی‌آید».
    const still = document.documentElement.getAttribute('data-motion') === 'reduced';

    const bubble = document.createElement('span');
    bubble.className = `reaction-bubble reaction-${key}${still ? ' is-still' : ''}`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', icon);
    svg.appendChild(use);
    bubble.appendChild(svg);

    // spread the bubbles across the stage instead of stacking on one spot
    bubble.style.setProperty('--rx', `${8 + Math.random() * 84}%`);
    bubble.style.setProperty('--rd', `${2.2 + Math.random() * 1.1}s`);
    bubble.style.setProperty('--rs', `${.85 + Math.random() * .5}`);
    if (name) bubble.title = name;

    layer.appendChild(bubble);
    if (still) {
        // No keyframes to end: a plain timer keeps the layer clean.
        window.setTimeout(() => bubble.remove(), 1900);
    } else {
        bubble.addEventListener('animationend', () => bubble.remove(), { once: true });
    }
}

/** Send a reaction and paint it here first — the source of truth is the echo. */
function sendReaction(key) {
    if (!REACTION_ICONS[key]) return false;
    // A reaction is a voice signal like a raised hand: the same grant covers
    // both, and the server re-checks it on every frame.
    if (!PERMISSIONS.can_raise_hand) {
        toast('شما اجازهٔ ارسال واکنش ندارید.', 'warning');
        return false;
    }
    const sent = presence.send({ action: 'reaction', reaction: key });
    if (sent) {
        _noteLocalReaction(key);
        showReaction(key, root.dataset.participantName || '');
        return true;
    }
    // Offline: say so instead of swallowing the tap.  (The bubble is not shown
    // here on purpose — nobody else would see it.)
    toast('اتصال قطع است؛ واکنش فرستاده نشد. چند لحظه بعد دوباره امتحان کنید.', 'warning', 3200);
    return false;
}

function initReactions() {
    const btn = document.getElementById('btn-reactions');
    const tray = document.getElementById('reaction-tray');
    if (!btn || !tray) return;

    // The control bar scrolls its own overflow, which would clip an anchored
    // popover — so the tray lives on <body> and is positioned against the
    // button's live rect every time it opens (and on resize while open).
    if (tray.parentElement !== document.body) document.body.appendChild(tray);

    const place = () => anchorPopover(btn, tray);

    const close = () => {
        tray.classList.add('hidden');
        btn.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
        tray.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        place();
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!PERMISSIONS.can_raise_hand) {
            toast('شما اجازهٔ ارسال واکنش ندارید.', 'warning');
            return;
        }
        tray.classList.contains('hidden') ? open() : close();
    });

    const reposition = () => {
        if (!tray.classList.contains('hidden')) place();
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    tray.querySelectorAll('[data-reaction]').forEach((item) => {
        item.addEventListener('click', (e) => {
            // The document-level handler below would otherwise run for this
            // same tap and could close a tray the user just re-opened.
            e.stopPropagation();
            sendReaction(item.dataset.reaction);
            close();
        });
    });

    document.addEventListener('click', (e) => {
        if (!tray.classList.contains('hidden') && !tray.contains(e.target) && e.target !== btn) close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
    });
}

// ---------------------------------------------------------------------------
// Live captions — speech-to-text in the speaker's browser, relayed over the
// presence socket, rendered for everyone.  Opt-in: nothing runs until the
// speaker presses the CC button.
// ---------------------------------------------------------------------------
function initCaptions() {
    const btn = document.getElementById('btn-captions');
    if (!btn) return;

    Captions.init({
        send: (payload) => presence.send(payload),
        identity: IDENTITY,
        displayName: root.dataset.participantName || '',
        memberId: MEMBER_ID,
    });

    const sync = () => {
        btn.classList.toggle('active', Captions.enabled);
        btn.setAttribute('aria-pressed', String(Captions.enabled));
        btn.title = Captions.enabled ? 'خاموش کردن زیرنویس' : 'زیرنویس زنده';
    };

    btn.addEventListener('click', () => {
        if (!Captions.supported) {
            Captions.start(); // shows the honest "not supported" message
            return;
        }
        Captions.toggle();
        sync();
    });

    // Speech recognition can stop itself (permission lost, service hiccup) —
    // the module reports state changes instead of us polling.
    Captions.onChange = sync;
    sync();
}

function initShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        const key = e.key.toLowerCase();
        // The whiteboard owns letter keys while it is on screen (P = pen),
        // so keep the room shortcuts out of its way there.
        const boardOpen = !document.getElementById('view-whiteboard')?.classList.contains('hidden');
        if (key === 'm') { e.preventDefault(); Media.toggleMicrophone(); }
        else if (key === 'v') { e.preventDefault(); Media.toggleCamera(); }
        else if (key === 'c') { e.preventDefault(); document.getElementById('btn-chat')?.click(); }
        else if (key === 'p' && !boardOpen) { e.preventDefault(); document.getElementById('btn-people')?.click(); }
        else if (key === 's') { e.preventDefault(); Media.toggleScreenShare(); }
        else if (key === 'r') { e.preventDefault(); sendReaction('heart'); }
        else if (key === 'd' && e.shiftKey) { e.preventDefault(); document.getElementById('btn-captions')?.click(); }
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
    // Text + icon (no emoji: they render as tofu without an emoji font).
    el.textContent = qualityLabel(quality);
    el.className = `conn-quality q-${quality}`;
    el.dataset.quality = quality;
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
/**
 * Sync the "click row to present" affordance with PERMISSIONS.can_present.
 *
 * Idempotent and two-directional: presenters get data-present/role/tabindex
 * on every row; non-presenters get them stripped, leaving the download link
 * as the only action.  Called at boot and whenever permissions change live.
 */
function applyFilePresentability() {
    const list = document.getElementById('file-list');
    if (!list) return;
    const canPresent = !!PERMISSIONS.can_present;
    list.classList.toggle('can-present', canPresent);
    list.querySelectorAll('.file-item').forEach((li) => {
        const info = li.querySelector('.file-info');
        if (!info) return;
        const id = li.dataset.fileId;
        // Presenters present (room-wide); everybody else opens a private
        // preview.  Neither downloads anything — the download button does.
        if (canPresent) {
            info.dataset.present = id;
            delete info.dataset.preview;
            info.title = 'کلیک: ارائهٔ این فایل برای همه';
        } else {
            info.dataset.preview = id;
            delete info.dataset.present;
            info.title = 'کلیک: مشاهدهٔ فایل بدون دانلود';
        }
        info.setAttribute('role', 'button');
        info.setAttribute('tabindex', '0');
    });
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    let v = n;
    for (const u of ['KB', 'MB', 'GB']) {
        v /= 1024;
        if (v < 1024 || u === 'GB') return `${v.toFixed(1)} ${u}`;
    }
    return `${v.toFixed(1)} GB`;
}

let activeUpload = null; // in-flight XHR so the cancel button can abort it

function applyUploadVisibility() {
    // The form visibility always tracks the live permission — a grant that
    // arrives mid-class must light up the uploader without a reload.
    document.getElementById('upload-form')?.classList.toggle('hidden', !PERMISSIONS.can_upload_files);
}

function initFiles() {
    const section = document.getElementById('panel-files');
    const MAX_MB = Number(section.dataset.maxUploadMb || 25);
    const ALLOWED_EXT = new Set((section.dataset.allowedExt || '').split(',').filter(Boolean));

    const input = document.getElementById('file-input');
    const progress = document.getElementById('upload-progress');
    const fill = document.getElementById('upload-progress-fill');
    const text = document.getElementById('upload-progress-text');
    applyUploadVisibility();

    const setProgress = (pct, label) => {
        fill.style.width = `${pct}%`;
        fill.setAttribute('aria-valuenow', String(pct));
        text.textContent = label;
    };

    input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file || activeUpload) return;
        if (!PERMISSIONS.can_upload_files) {
            toast('شما اجازهٔ بارگذاری فایل ندارید.', 'warning');
            return;
        }

        // ---- pre-flight checks: fail instantly, don't waste the upload ----
        const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
        if (!ALLOWED_EXT.has(ext)) {
            toast(`پسوند «.${ext || 'نامشخص'}» مجاز نیست. فرمت‌های مجاز: ${[...ALLOWED_EXT].join('، ')}`, 'error', 4000);
            return;
        }
        if (file.size === 0) { toast('فایل خالی است.', 'error'); return; }
        if (file.size > MAX_MB * 1024 * 1024) {
            toast(`حجم فایل بیش از حد مجاز (${MAX_MB.toLocaleString('fa-IR')} مگابایت) است.`, 'error', 4000);
            return;
        }

        progress.classList.remove('hidden');
        input.disabled = true;
        setProgress(0, `۰٪ — «${file.name}»`);

        const xhr = new XMLHttpRequest();
        activeUpload = xhr;
        xhr.upload.addEventListener('progress', (ev) => {
            if (!ev.lengthComputable) return;
            const pct = Math.round((ev.loaded / ev.total) * 100);
            setProgress(pct, `${pct.toLocaleString('fa-IR')}٪ — «${file.name}»`);
        });
        const finish = () => {
            activeUpload = null;
            input.disabled = false;
            progress.classList.add('hidden');
        };
        xhr.addEventListener('load', () => {
            finish();
            let data = {};
            try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON error */ }
            if (xhr.status >= 200 && xhr.status < 300) {
                // add locally for instant feedback; the `file_uploaded`
                // broadcast reaches everyone else (dedup keeps one row).
                addFileItem({
                    id: data.id, name: data.name,
                    size: formatBytes(file.size),
                    uploader: 'شما', uploader_id: SELF_USER_ID,
                    has_pdf: data.has_pdf,
                    url: `/class/${ROOM_CODE}/files/${data.id}/download/`,
                });
                toast('فایل بارگذاری شد.', 'success');
            } else {
                toast(data.detail || 'بارگذاری ناموفق بود.', 'error', 4000);
            }
        });
        xhr.addEventListener('error', () => { finish(); toast('خطای شبکه در بارگذاری فایل.', 'error'); });
        xhr.addEventListener('abort', () => { finish(); toast('بارگذاری لغو شد.', 'info', 2000); });
        const fd = new FormData();
        fd.append('file', file);
        xhr.open('POST', `/class/${ROOM_CODE}/files/upload/`);
        xhr.setRequestHeader('X-CSRFToken', csrfToken);
        xhr.send(fd);
    });

    document.getElementById('upload-cancel').addEventListener('click', () => activeUpload?.abort());

    const list = document.getElementById('file-list');
    applyFilePresentability();
    updateFileEmpty();

    const presentFile = (trigger) => {
        if (!PERMISSIONS.can_present) {
            toast('شما اجازهٔ ارائهٔ فایل ندارید.', 'warning', 2500);
            return;
        }
        api('/presentation/', { file_id: Number(trigger.dataset.present), page: 1 });
    };
    /**
     * Open a shared file on this screen only: streamed inline into the
     * presentation canvas, nothing downloaded, nobody else switched to it.
     */
    const previewFile = (trigger) => {
        const li = trigger.closest('.file-item');
        if (!li) return;
        switchView('presentation');
        Presentation.preview({
            file_id: Number(trigger.dataset.preview),
            file_name: li.dataset.fileName || '',
            page: 1,
            has_pdf: li.dataset.hasPdf === '1',
        });
        if (window.matchMedia('(max-width: 900px)').matches) setSideOpen(false);
    };
    const deleteFile = async (btn) => {
        const ok = await confirmDialog('حذف فایل', 'این فایل برای همهٔ شرکت‌کنندگان حذف شود؟',
            { danger: true, okLabel: 'حذف' });
        if (!ok) return;
        try {
            await api(`/files/${btn.dataset.delete}/delete/`, {});
            removeFileItem(btn.dataset.delete);  // broadcast also removes — idempotent
            toast('فایل حذف شد.', 'success', 2200);
        } catch (err) {
            toast(err.message, 'error');
        }
    };
    list.addEventListener('click', (e) => {
        const del = e.target.closest('.file-delete');
        if (del) { deleteFile(del); return; }
        if (e.target.closest('a[download]')) return; // explicit download only
        const present = e.target.closest('[data-present]');
        if (present) { presentFile(present); return; }
        const preview = e.target.closest('[data-preview]');
        if (preview) previewFile(preview);
    });
    list.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const present = e.target.closest('[data-present]');
        const preview = e.target.closest('[data-preview]');
        if (!present && !preview) return;
        e.preventDefault();
        if (present) presentFile(present);
        else previewFile(preview);
    });
}

/** File-kind class for the chip colour (kept in sync with room.css). */
function fileKind(name) {
    const ext = (name || '').includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (['png', 'jpg', 'jpeg'].includes(ext)) return 'img';
    if (['docx', 'pptx', 'xlsx'].includes(ext)) return 'office';
    if (['zip'].includes(ext)) return 'zip';
    if (ext === 'pdf') return 'pdf';
    return 'file';
}

/** Management rights over a file: privileged members, or its uploader. */
function canManageFile(file) {
    if (PRIVILEGED) return true;
    return SELF_USER_ID !== null && Number(file.uploader_id) === SELF_USER_ID;
}

function updateFileEmpty() {
    const list = document.getElementById('file-list');
    const empty = document.getElementById('file-empty');
    if (list && empty) empty.classList.toggle('hidden', list.querySelectorAll('.file-item').length > 0);
}

/** Highlight the row of the file currently being presented (null clears). */
function syncPresentingBadge(fileId) {
    document.querySelectorAll('#file-list .file-item').forEach((li) => {
        li.classList.toggle('presenting', fileId != null && Number(li.dataset.fileId) === Number(fileId));
    });
    syncPresReturnChip();
}

/** The chip only makes sense while the slide is NOT the visible view. */
function syncPresReturnChip() {
    const chip = document.getElementById('pres-return');
    if (!chip) return;
    const onPresentation = !document.getElementById('view-presentation')?.classList.contains('hidden');
    chip.classList.toggle('hidden', !livePresentation || onPresentation);
}

function addFileItem(file) {
    const list = document.getElementById('file-list');
    if (list.querySelector(`.file-item[data-file-id="${Number(file.id)}"]`)) return;
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.fileId = String(file.id);
    li.dataset.fileName = file.name || '';
    li.dataset.hasPdf = file.has_pdf ? '1' : '0';
    // Presenters present it; everyone else opens it locally (no download).
    const openAttrs = PERMISSIONS.can_present
        ? ` data-present="${Number(file.id)}" role="button" tabindex="0" title="کلیک: ارائهٔ این فایل برای همه"`
        : ` data-preview="${Number(file.id)}" role="button" tabindex="0" title="کلیک: مشاهدهٔ فایل بدون دانلود"`;
    li.innerHTML = `
        <span class="file-icon" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><use href="#i-file"/></svg></span>
        <div class="file-info"${openAttrs}>
            <span class="file-name"></span>
            <small class="muted"></small>
        </div>
        <span class="file-presenting-pill" title="این فایل اکنون ارائه می‌شود">در حال ارائه</span>
        <div class="file-actions">
            ${PERMISSIONS.can_present
                ? `<button type="button" class="btn btn-sm btn-primary file-present"
                           data-present="${Number(file.id)}"
                           title="ارائهٔ این فایل برای همه" aria-label="ارائهٔ این فایل"><svg class="ic" aria-hidden="true"><use href="#i-play"/></svg></button>`
                : ''}
            <a class="btn btn-sm btn-ghost file-download" href="${file.url}" download
               title="دانلود این فایل" aria-label="دانلود این فایل"><svg class="ic" aria-hidden="true"><use href="#i-download"/></svg></a>
        </div>`;
    const iconEl = li.querySelector('.file-icon');
    const kind = file.kind || fileKind(file.name);
    iconEl.dataset.kind = kind;
    iconEl.querySelector('use').setAttribute('href', `#i-file-${kind}` === '#i-file-file' ? '#i-file' : `#i-file-${kind}`);
    li.querySelector('.file-name').textContent = file.name;
    if (file.has_pdf) {
        const pill = document.createElement('span');
        pill.className = 'pdf-ready-pill';
        pill.title = 'نسخهٔ PDF آمادهٔ ارائه است';
        pill.textContent = '✓ PDF';
        li.querySelector('.file-name').appendChild(pill);
    }
    li.querySelector('.file-info small').textContent =
        [file.uploader, file.size].filter(Boolean).join(' · ');
    if (canManageFile(file)) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'file-delete';
        del.dataset.delete = String(file.id);
        del.title = 'حذف فایل';
        del.setAttribute('aria-label', `حذف ${file.name}`);
        del.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
            + '<path d="M4.5 7h15"/><path d="M9.5 7V5.6A1.6 1.6 0 0 1 11.1 4h1.8a1.6 1.6 0 0 1 1.6 1.6V7"/>'
            + '<path d="M6.6 7l.8 11.4A1.7 1.7 0 0 0 9.1 20h5.8a1.7 1.7 0 0 0 1.7-1.6L17.4 7"/></svg>'
            + '<span>حذف</span>';
        li.querySelector('.file-actions').appendChild(del);
    }
    list.prepend(li);
    updateFileEmpty();
}

function removeFileItem(fileId) {
    document.querySelector(`#file-list .file-item[data-file-id="${Number(fileId)}"]`)?.remove();
    updateFileEmpty();
}

/**
 * A file that was uploaded as Office (PPTX/DOCX/XLSX) only becomes
 * presentable once the server has converted it to PDF. That happens in the
 * background, so the row is upgraded in place when `file_presentable` lands —
 * no refresh, no re-upload.
 */
function markFilePresentable(fileId, name) {
    const li = document.querySelector(`#file-list .file-item[data-file-id="${Number(fileId)}"]`);
    if (!li) return;
    if (li.dataset.hasPdf === '1') return;  // already shown as ready
    li.dataset.hasPdf = '1';
    const nameEl = li.querySelector('.file-name');
    if (nameEl && !nameEl.querySelector('.pdf-ready-pill')) {
        const pill = document.createElement('span');
        pill.className = 'pdf-ready-pill';
        pill.title = 'نسخهٔ PDF آمادهٔ ارائه است';
        pill.textContent = '✓ PDF';
        nameEl.appendChild(pill);
    }
    toast(`نسخهٔ ارائهٔ «${name || li.dataset.fileName}» آماده شد.`, 'success', 3000);
}

/** Submit the hidden leave form (server revokes the membership/guest slot). */
function submitLeave() {
    document.getElementById('leave-submit')?.form?.submit();
}

/**
 * Full-stage notice shown when the class is over — either because the owner
 * ended it (everyone gets `class_ended` over the socket) or because this tab
 * was the one doing the ending.
 */
function showClassEnded({ by = '', owner = false } = {}) {
    const panel = document.getElementById('class-ended');
    if (!panel) return;
    const who = panel.querySelector('[data-ended-by]');
    if (who) {
        who.textContent = owner
            ? 'کلاس توسط شما پایان یافت.'
            : (by ? `کلاس توسط ${by} پایان یافت.` : 'این کلاس پایان یافته است.');
    }
    panel.classList.remove('hidden');
    document.body.classList.add('class-is-over');
    try { Media.stopScreenShare?.(); } catch (e) { /* nothing shared */ }
    try { Recorder.stop?.(); } catch (e) { /* not recording */ }
    // never leave the user on a dead room: offer the dashboard right away
    panel.querySelector('[data-ended-home]')?.focus?.();
}

// Last `presentation_changed` payload (or the server-rendered one at boot):
// the «back to the slide» chip and a page refresh both need it.
let livePresentation = null;

function applyPresentation(data, { open = true } = {}) {
    livePresentation = data && data.file_id ? data : null;
    syncPresentingBadge(data?.file_id ?? null);
    // Only the presented file accepts free ink (see Presentation._annotAllowed).
    Presentation.setPresented(data?.file_id ?? null);
    if (!data || !data.file_id) {
        Presentation.hide();
        switchView('media');
        return;
    }
    // switch FIRST: the renderer measures its holder, and a hidden
    // holder measures 0×0 (which now aborts the render entirely).
    if (open) switchView('presentation');
    Presentation.show({
        file_id: data.file_id, file_name: data.file_name,
        page: data.page || 1, has_pdf: data.has_pdf,
    });
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
// Control-bar space reservation
// ---------------------------------------------------------------------------
// The floating bar wraps to 1–3 rows depending on viewport; expose its real
// occupied height (plus margin) as --bar-space so the stage, drawer and
// camera PiP always reserve exactly the right amount of clearance.
/** The height the user can actually see right now.
 *
 * `innerHeight` ignores the mobile keyboard on Safari: it keeps reporting the
 * pre-keyboard height while the visible area has shrunk, and measuring the
 * dock against it reserved a whole keyboard's worth of dead space — the stage,
 * chat and camera preview all shrank and nothing recovered after the keyboard
 * closed. `visualViewport.height` is the honest number there; on desktop both
 * agree, so `min()` is safe everywhere.
 */
function visibleHeight() {
    const viewport = window.visualViewport;
    return viewport ? Math.min(window.innerHeight, viewport.height) : window.innerHeight;
}

function syncBarSpace() {
    const bar = document.querySelector('.room-controls');
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    if (!r.height) return;
    const gap = Math.max(0, visibleHeight() - r.top) + 12;
    document.documentElement.style.setProperty('--bar-space', `${Math.round(gap)}px`);
}

// ---------------------------------------------------------------------------
// Boot
//
// Order matters: every UI binding happens FIRST, so a failure in any
// optional subsystem (media libs, whiteboard canvas, sockets) can never
// leave the page with dead controls.  Each risky init is isolated.
// ---------------------------------------------------------------------------
/**
 * Run one boot step in isolation: a failure in any single subsystem must never
 * leave the room dead (no socket, frozen clock, empty roster).  Every failure
 * is logged with its label so it is obvious in the console.
 */
function safe(label, fn) {
    try {
        return fn();
    } catch (err) {
        console.error(`[room] init failed: ${label}`, err);
        reportBootError(label, err);
        return undefined;
    }
}

safe('tabs', initTabs);
safe('drawer', initDrawer);
safe('stage-empty', initStageEmpty);
safe('controls', initControls);
safe('bar-space', () => {
    trackControlBarHeight();
    trackDeviceTestHeight();
    trackComposerHeight();
    syncBarSpace();
    window.addEventListener('resize', syncBarSpace);
    window.addEventListener('load', syncBarSpace);
    // Keyboard open/close (Safari fires no `resize` for it) and pinch-zoom.
    window.addEventListener('app:viewport', syncBarSpace);
    window.visualViewport?.addEventListener('resize', syncBarSpace);
    setTimeout(syncBarSpace, 400); // re-measure after webfonts settle
});
safe('layouts', initLayouts);
safe('fullscreen', initFullscreen);
safe('more-menu', initMoreMenu);
safe('devices-dialog', initDevicesDialog);
safe('shortcuts', initShortcuts);
safe('reactions', initReactions);
safe('captions', initCaptions);
safe('files', initFiles);
safe('roster-tools', initRosterTools);
safe('perms-dialog', initPermsDialog);
safe('clock', initClock);
safe('control-states', refreshControlStates);
safe('readonly-banner', syncReadOnlyBanner);
if (!PERMISSIONS.can_send_messages) {
    safe('chat-send-state', () => ChatClient.setSendEnabled(false, 'شما اجازهٔ ارسال پیام ندارید.'));
}
if (SHOW_CHAT) {
    safe('chat-tab', () => activateTab('chat'));
}

// Sockets come before anything optional: the roster, the participant count and
// the media signal channel all depend on the presence socket.  Nothing below
// is allowed to keep it from connecting.
safe('chat', () => ChatClient.connect(ROOM_CODE, IDENTITY, PRIVILEGED));
safe('presence', () => presence.connect());
// Instant recovery on network/tab wake instead of waiting out the backoff.
safe('network', () => {
    Network.init();
    Network.register((force) => presence.nudge(force));
    Network.register((force) => ChatClient.nudge?.(force));
    Network.register(() => Media.onNetworkOnline?.());
});
// Clicking the connection pill retries by hand (useful when a network switch
// killed the socket and the backoff has grown long).
safe('conn-pill-retry', () => {
    const retry = () => {
        if (navigator.onLine === false || presence.state !== 'connected') presence.reconnect();
    };
    presence.el?.addEventListener('click', retry);
    // It looks like a pill but behaves like a button, so it has to answer the
    // keyboard as one too.
    presence.el?.addEventListener('keydown', (evt) => {
        if (evt.key !== 'Enter' && evt.key !== ' ' && evt.key !== 'Spacebar') return;
        evt.preventDefault();
        retry();
    });
});

// Optional subsystems — each isolated, each optional.
safe('device-test', () => initDeviceTest({ roomCode: ROOM_CODE }));
safe('whiteboard', () => Whiteboard.init({
    roomCode: ROOM_CODE,
    identity: IDENTITY,
    canDraw: PERMISSIONS.can_use_whiteboard,
    canControlBoard: CAN_CONTROL_BOARD,
}));
safe('presentation', () => Presentation.init({
    roomCode: ROOM_CODE,
    identity: IDENTITY,
    canAnnotate: PERMISSIONS.can_use_whiteboard,
    canPresent: PERMISSIONS.can_present,
    isAuthority: CAN_CONTROL_BOARD,
    annotationOpen: document.getElementById('view-presentation')?.dataset.annotationOpen === '1',
    presentedFileId: document.getElementById('view-presentation')?.dataset.currentFile || null,
    api,
}));
safe('quiz', () => QuizClient.init({ api, identity: IDENTITY, privileged: PRIVILEGED }));
// A refresh during a live presentation must land on the slide, not on an
// empty media grid — the server already told us what is on screen.
safe('presentation-restore', () => {
    const pv = document.getElementById('view-presentation');
    const fileId = Number(pv?.dataset.currentFile || 0);
    if (!fileId) return;
    applyPresentation({
        file_id: fileId,
        file_name: pv.dataset.currentName || '',
        has_pdf: pv.dataset.currentHasPdf === '1',
        page: Number(pv.dataset.currentPage || 1) || 1,
    });
});
// «ارائه در جریان است — بازگشت» on the media/whiteboard views.
safe('presentation-return', () => {
    document.getElementById('pres-return')?.addEventListener('click', () => {
        if (livePresentation) applyPresentation(livePresentation);
    });
});

// Media last, and never awaited by the boot path: it opens devices and may be
// slow (or refused).  The room must never wait on it to become interactive.
Media.init({
    roomCode: ROOM_CODE,
    currentIdentity: IDENTITY,
    permissions: PERMISSIONS,
    mediaUrl: MEDIA_URL,
    mediaEnabled: MEDIA_ENABLED,
    meshEnabled: MESH_ENABLED,
    iceServers: ICE_SERVERS,
    self: { identity: IDENTITY, memberId: MEMBER_ID, name: root.dataset.participantName },
    signal: (payload) => presence.send(payload),
    onStateChange: (state) => presence.send({ action: 'media_state', ...state }),
    onQualityChange,
}).then(() => {
    // re-sync the mesh once media is up (the first snapshot may predate it)
    Media.syncPeers(Array.from(presence.participants.values())
        .filter((p) => !p.in_waiting_room)
        .map((p) => ({
            identity: p.identity, member_id: p.member_id, name: p.name,
            permissions: p.permissions || {}, muted: Boolean(p.muted),
            camera_disabled: Boolean(p.camera_disabled), screen_sharing: p.screen_sharing,
        })));
}).catch((err) => {
    console.error('[room] init failed: media', err);
    reportBootError('media', err);
});

// Periodic keepalive so idle proxies don't drop the presence socket.
setInterval(() => presence.send({ action: 'ping' }), 25_000);
