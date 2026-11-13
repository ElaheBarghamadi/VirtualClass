/**
 * toast.js — the app's single notification surface.
 *
 * Every message that cannot be shown where it happened ends up here: a refused
 * camera, a muted class, a deleted file, a lost socket, a server flash message.
 * One stack, one look, one place to close it.
 *
 * Behaviour worth knowing:
 *  - the stack is docked to the side of the viewport and grows upward, so
 *    several notifications read as a list instead of a pile (inside the room
 *    it moves to the stage side, clear of the chat rail and the composer);
 *  - an identical message arriving again does not duplicate itself: the
 *    existing card is refreshed and gets a ×2 (×3 …) badge;
 *  - each card has a close button, and on touch it can also be swiped away;
 *  - the auto-dismiss countdown pauses while the pointer or keyboard focus is
 *    inside the card, because a message you are reading should not vanish.
 */

const DEFAULT_MS = 4200;
const MAX_VISIBLE = 4;
const EXIT_MS = 260;

/** SVG paths only — the project never uses emoji in the UI. */
const ICONS = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.4"/><path d="M12 7.6v.6"/>',
    success: '<circle cx="12" cy="12" r="9"/><path d="m8.2 12.4 2.6 2.6 5-5.2"/>',
    warning: '<path d="M12 3.6 21 20H3z"/><path d="M12 9.6v4.2"/><path d="M12 17v.4"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8"/>',
};

let stack = null;
/** element → { timer, remaining, startedAt, paused, leaving, key, ms } */
const state = new WeakMap();
/** "level::text" → element that is still on screen */
const visible = new Map();

function svg(paths, className) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('class', className);
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = paths;
    return node;
}

function ensureStack() {
    if (stack && stack.isConnected) return stack;
    stack = document.createElement('div');
    stack.className = 'toast-container';
    stack.setAttribute('role', 'region');
    stack.setAttribute('aria-label', 'اعلان‌ها');
    document.body.appendChild(stack);
    return stack;
}

function clearTimer(entry) {
    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }
}

function arm(entry) {
    const el = entry.el;
    clearTimer(entry);
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => dismiss(el), entry.remaining);
}

function pause(entry) {
    if (!entry || entry.paused || entry.leaving) return;
    entry.paused = true;
    entry.remaining = Math.max(1400, entry.remaining - (Date.now() - entry.startedAt));
    clearTimer(entry);
    entry.el.classList.add('is-paused');
}

function resume(entry) {
    if (!entry || !entry.paused || entry.leaving) return;
    entry.paused = false;
    entry.el.classList.remove('is-paused');
    // The CSS countdown continued from the same point because it was only
    // paused, so the JS timer resumes with the remaining time as well.
    const bar = entry.el.querySelector('.toast__timer');
    if (bar) bar.style.setProperty('--toast-ms', `${entry.remaining}ms`);
    entry.el.style.setProperty('--toast-ms', `${entry.remaining}ms`);
    arm(entry);
}

/** Remove a card, with the collapse animation that keeps the stack tidy. */
export function dismiss(el, immediate = false) {
    if (!el) return;
    const entry = state.get(el);
    if (entry && entry.leaving) return;
    if (entry) {
        entry.leaving = true;
        clearTimer(entry);
        if (visible.get(entry.key) === el) visible.delete(entry.key);
    }
    el.classList.add('is-leaving');
    if (immediate) {
        el.remove();
        return;
    }
    setTimeout(() => el.remove(), EXIT_MS);
}

/** Drop everything (used when leaving the room / on a hard error). */
export function clearToasts() {
    Array.from(ensureStack().children).forEach((el) => dismiss(el, true));
    visible.clear();
}

function bumpCount(el) {
    let badge = el.querySelector('.toast__count');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'toast__count';
        badge.setAttribute('aria-hidden', 'true');
        el.querySelector('.toast__body').appendChild(badge);
    }
    // textContent is the *rendered* label ("×2"), so strip the sign before
    // parsing — parseInt("×2") is NaN and every repeat would stay at ×2.
    const previous = parseInt(badge.textContent.replace(/\D+/g, ''), 10) || 1;
    badge.textContent = `×${previous + 1}`;
    el.classList.remove('is-bumped');
    // restart the little pop without a forced reflow dance
    void el.offsetWidth;
    el.classList.add('is-bumped');
}

function makeCard(text, level, ms) {
    const el = document.createElement('div');
    el.className = `toast toast--${level}`;
    el.dataset.level = level;
    el.style.setProperty('--toast-ms', `${ms}ms`);
    el.setAttribute('role', level === 'error' ? 'alert' : 'status');

    const icon = document.createElement('span');
    icon.className = 'toast__icon';
    icon.appendChild(svg(ICONS[level] || ICONS.info, 'toast__glyph'));
    el.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'toast__body';
    const paragraph = document.createElement('p');
    paragraph.className = 'toast__text';
    paragraph.textContent = text;
    body.appendChild(paragraph);
    el.appendChild(body);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast__close';
    close.setAttribute('aria-label', 'بستن اعلان');
    close.appendChild(svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', 'toast__x'));
    close.addEventListener('click', () => dismiss(el));
    el.appendChild(close);

    const timer = document.createElement('span');
    timer.className = 'toast__timer';
    timer.setAttribute('aria-hidden', 'true');
    el.appendChild(timer);

    // Reading a card should not race the clock.
    el.addEventListener('pointerenter', () => pause(state.get(el)));
    el.addEventListener('pointerleave', () => resume(state.get(el)));
    el.addEventListener('focusin', () => pause(state.get(el)));
    el.addEventListener('focusout', (event) => {
        if (!el.contains(event.relatedTarget)) resume(state.get(el));
    });

    attachSwipe(el);
    return el;
}

/** Swipe a card sideways to dismiss it — the close button stays the real path. */
function attachSwipe(el) {
    let startX = null;
    let startY = 0;
    let dx = 0;
    let active = false;

    el.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' || event.button !== 0) return;
        if (event.target.closest('.toast__close')) return;
        startX = event.clientX;
        startY = event.clientY;
        dx = 0;
        active = false;
    });

    el.addEventListener('pointermove', (event) => {
        if (startX === null) return;
        const mx = event.clientX - startX;
        const my = event.clientY - startY;
        if (!active) {
            // a vertical gesture belongs to the page, not to the card
            if (Math.abs(my) > Math.abs(mx)) return;
            if (Math.abs(mx) < 8) return;
            active = true;
            el.classList.add('is-dragging');
            el.setPointerCapture?.(event.pointerId);
        }
        dx = mx;
        const limit = el.offsetWidth * 1.1;
        el.style.transform = `translateX(${Math.max(-limit, Math.min(limit, dx))}px)`;
        el.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / (limit * 0.8)));
    });

    const finish = () => {
        if (startX === null) return;
        const shouldClose = active && Math.abs(dx) > Math.min(110, el.offsetWidth * 0.35);
        startX = null;
        active = false;
        el.classList.remove('is-dragging');
        el.style.transform = '';
        el.style.opacity = '';
        if (shouldClose) dismiss(el);
    };

    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
}

/**
 * Show a toast.
 *
 * @param {string} text
 * @param {'info'|'success'|'warning'|'error'} [level]
 * @param {number} [ms] auto-dismiss delay; errors default to a longer read
 */
export function toast(text, level = 'info', ms = DEFAULT_MS) {
    const message = String(text ?? '').trim();
    if (!message) return null;
    const kind = ICONS[level] ? level : 'info';
    const duration = kind === 'error' && ms === DEFAULT_MS ? DEFAULT_MS + 3000 : ms;

    const key = `${kind}::${message}`;
    const existing = visible.get(key);
    if (existing && existing.isConnected) {
        bumpCount(existing);
        const entry = state.get(existing);
        if (entry) {
            entry.remaining = duration;
            existing.style.setProperty('--toast-ms', `${duration}ms`);
            if (!entry.paused) arm(entry);
        }
        return existing;
    }

    const box = ensureStack();
    // Keep the stack bounded: the oldest card leaves immediately instead of
    // letting a burst of events push the screen full.
    const live = Array.from(box.querySelectorAll('.toast:not(.is-leaving)'));
    for (let i = 0; i <= live.length - MAX_VISIBLE; i += 1) dismiss(live[i], true);

    const el = makeCard(message, kind, duration);
    visible.set(key, el);
    state.set(el, {
        el,
        key,
        ms: duration,
        remaining: duration,
        startedAt: Date.now(),
        paused: false,
        leaving: false,
        timer: null,
    });
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-in'));
    arm(state.get(el));
    return el;
}

/** Long-lived errors are worth keeping on screen; successes are not. */
export function toastError(text, ms = DEFAULT_MS + 3000) {
    return toast(text, 'error', ms);
}

// Classic scripts (app.js, nav.js, inline handlers) reach the same component
// through this bridge, so there is never a second notification surface.
window.UItoast = toast;
window.UItoast.clear = clearToasts;
window.UItoast.dismiss = dismiss;
