/**
 * toast.js — lightweight notification component (accessible, RTL-aware).
 */
let container = null;
let lastToast = { text: '', level: '', at: 0 };

function ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('role', 'region');
    container.setAttribute('aria-label', 'اعلان‌ها');
    document.body.appendChild(container);
    return container;
}

/**
 * Show a toast notification.
 * @param {string} text
 * @param {'info'|'success'|'warning'|'error'} [level]
 * @param {number} [ms]
 */
export function toast(text, level = 'info', ms = 4200) {
    // Several paths can report the same fact at once (e.g. the server sends a
    // `notification` *and* a `participant_muted` for one mute).  Collapse
    // repeats inside a short window instead of stacking identical toasts.
    if (!text) return;
    const now = Date.now();
    if (lastToast.text === text && lastToast.level === level && now - lastToast.at < 1500) {
        lastToast.at = now;
        return;
    }
    lastToast = { text, level, at: now };
    const box = ensureContainer();
    const el = document.createElement('div');
    el.className = `toast toast-${level}`;
    el.setAttribute('role', level === 'error' ? 'alert' : 'status');

    // SVG only (no emoji): emoji render as tofu on many Linux/Windows setups
    // and clash with the icon set used everywhere else in the app.
    const paths = {
        info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.4"/><path d="M12 7.6v.6"/>',
        success: '<circle cx="12" cy="12" r="9"/><path d="m8.2 12.4 2.6 2.6 5-5.2"/>',
        warning: '<path d="M12 3.6 21 20H3z"/><path d="M12 9.6v4.2"/><path d="M12 17v.4"/>',
        error: '<circle cx="12" cy="12" r="9"/><path d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8"/>',
    };
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('class', 'toast-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = paths[level] || paths.info;
    el.appendChild(icon);
    const span = document.createElement('span');
    span.className = 'toast-text';
    span.textContent = text;
    el.appendChild(span);

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'بستن اعلان');
    close.textContent = '×';
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);

    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => el.remove(), 300);
    }, ms);
}

/** Confirmation helper with a native dialog (blocks, accessible). */
export function confirmAction(message) {
    return window.confirm(message);
}
