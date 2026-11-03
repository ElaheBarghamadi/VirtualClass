/**
 * captions.js — live captions, generated in the speaker's browser.
 *
 * Speech → text uses the Web Speech API (Chrome/Edge today).  The recognised
 * text is relayed through the existing presence socket, so the server never
 * runs speech models and nothing is stored.  Rendering works everywhere: any
 * student can *read* captions even on browsers without recognition support.
 *
 * Cost control: recognition only runs while the speaker enables it, interim
 * results are throttled to ~2/s, each line is deleted with a single timer, and
 * at most MAX_LINES bubbles are on screen at any moment.
 */
import { toast } from './toast.js';

const MAX_LINES = 3;
const LINE_TTL = 11000;        // final lines disappear after ~11s
const INTERIM_THROTTLE = 500;  // ms between interim updates
const MAX_CHARS = 200;         // must match classrooms/consumers.py

function getRecognition() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.lang = 'fa-IR';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    return rec;
}

class CaptionsImpl {
    constructor() {
        this.layer = null;
        this.recognition = null;
        this.enabled = false;
        this.send = () => {};
        this.identity = null;
        this.displayName = '';
        this._lines = new Map();   // member_id → {el, timer, interimEl}
        this._lastInterim = 0;
        this._restartTimer = null;
        this._wantRunning = false;
        this.onChange = () => {};   // room.js hook → keep the CC button in sync
    }

    get supported() {
        return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    }

    init({ send, identity, displayName, memberId }) {
        this.layer = document.getElementById('caption-layer');
        this.send = send;
        this.identity = identity;
        this.displayName = displayName || '';
        this.memberId = memberId ?? 'self';
    }

    // ------------------------------------------------------------ producing
    toggle() {
        return this.enabled ? (this.stop(), false) : (this.start(), true);
    }

    start() {
        if (this.enabled) return;
        if (!this.supported) {
            toast('زیرنویس زنده در این مرورگر ممکن نیست؛ کروم یا اج را امتحان کنید. زیرنویس دیگران را می‌بینید.', 'warning', 5200);
            return;
        }
        const rec = getRecognition();
        if (!rec) return;
        this.recognition = rec;
        this._wantRunning = true;

        rec.onresult = (ev) => {
            let interim = '';
            for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
                const res = ev.results[i];
                const text = (res[0]?.transcript || '').trim().slice(0, MAX_CHARS);
                if (!text) continue;
                if (res.isFinal) this._emit(text, true);
                else interim += ` ${text}`;
            }
            interim = interim.trim().slice(0, MAX_CHARS);
            if (interim) {
                const now = Date.now();
                if (now - this._lastInterim > INTERIM_THROTTLE) {
                    this._lastInterim = now;
                    this._emit(interim, false);
                }
            }
        };
        rec.onerror = (ev) => {
            if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
                toast('دسترسی به میکروفون برای زیرنویس داده نشد.', 'warning');
                this.stop();
            } else if (ev.error === 'no-speech') {
                /* normal silence — the browser restarts on its own */
            } else if (ev.error === 'network') {
                toast('سرویس تبدیل گفتار به متن در دسترس نیست.', 'warning');
                this.stop();
            }
        };
        rec.onend = () => {
            // Chrome stops after a pause; restart while the toggle is on.
            if (!this._wantRunning) return;
            clearTimeout(this._restartTimer);
            this._restartTimer = setTimeout(() => {
                try { rec.start(); } catch (e) { /* already running */ }
            }, 350);
        };
        try {
            rec.start();
            this.enabled = true;
            this.onChange(this.enabled);
            toast('زیرنویس روشن شد — گفتار شما برای همه نمایش داده می‌شود.', 'info', 3200);
        } catch (e) {
            toast('شروع زیرنویس ممکن نشد.', 'error');
            this._wantRunning = false;
        }
    }

    stop(silent = false) {
        this._wantRunning = false;
        clearTimeout(this._restartTimer);
        const rec = this.recognition;
        this.recognition = null;
        this.enabled = false;
        try { rec?.stop(); } catch (e) { /* already stopped */ }
        try { rec?.abort?.(); } catch (e) { /* ignore */ }
        this.onChange(this.enabled);
        if (!silent) toast('زیرنویس خاموش شد.', 'info', 2200);
    }

    _emit(text, final) {
        this.send({ action: 'caption', text, final });
        // Local echo immediately — no need to wait for the round trip.
        this.render({ member_id: this.memberId, name: this.displayName, text, final });
    }

    // ------------------------------------------------------------ rendering
    /** Show/update one speaker's caption line. */
    render({ member_id: mid, name, text, final }) {
        if (!this.layer || !text) return;
        const key = String(mid ?? name ?? '');
        let line = this._lines.get(key);

        if (!line) {
            const el = document.createElement('div');
            el.className = 'caption-line';
            const who = document.createElement('span');
            who.className = 'caption-name';
            who.textContent = name || 'شرکت‌کننده';
            const body = document.createElement('span');
            body.className = 'caption-text';
            el.append(who, body);
            this.layer.appendChild(el);
            line = { el, body, timer: null, finalText: '' };
            this._lines.set(key, line);
            this._trim();
        }

        if (final) line.finalText = text;
        line.body.textContent = final ? line.finalText : `${line.finalText ? `${line.finalText} ` : ''}${text}`;
        line.el.classList.toggle('interim', !final);
        line.el.classList.add('is-live');

        clearTimeout(line.timer);
        line.timer = setTimeout(() => this.remove(key), final ? LINE_TTL : LINE_TTL * 1.6);
    }

    remove(key) {
        const line = this._lines.get(key);
        if (!line) return;
        clearTimeout(line.timer);
        this._lines.delete(key);
        line.el.classList.add('is-leaving');
        const drop = () => line.el.remove();
        // Animate out unless motion is reduced.
        if (document.documentElement.getAttribute('data-motion') === 'reduced') drop();
        else setTimeout(drop, 260);
    }

    clear() {
        for (const key of [...this._lines.keys()]) this.remove(key);
    }

    /** Keep the overlay to MAX_LINES — drop the oldest, never the newest. */
    _trim() {
        const keys = [...this._lines.keys()];
        while (keys.length > MAX_LINES) {
            this.remove(keys.shift());
        }
    }
}

export const Captions = new CaptionsImpl();
