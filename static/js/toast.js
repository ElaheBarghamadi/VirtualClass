/**
 * toast.js — lightweight notification component (accessible, RTL-aware).
 */
let container = null;

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
    const box = ensureContainer();
    const el = document.createElement('div');
    el.className = `toast toast-${level}`;
    el.setAttribute('role', level === 'error' ? 'alert' : 'status');

    const icons = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '⛔' };
    el.innerHTML = `<span class="toast-icon" aria-hidden="true">${icons[level] || ''}</span>`;
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
