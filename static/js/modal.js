/**
 * modal.js — the single dialog component used across the room.
 *
 * A fresh accessible <dialog> is created per call: focus is trapped by the
 * platform, Esc closes, and focus returns to the opener. Reusing one node
 * caused a stale `close` event (from the previous question) to dismiss the
 * next one, so every dialog is its own element and is removed on close.
 *
 * - confirmDialog(title, message, opts) → Promise<boolean>
 * - choiceDialog(title, message, options) → Promise<option id | null>
 * - infoDialog(title, content, okLabel) → Promise<void>
 */

let current = null;   // { el, resolve }
let lastFocus = null;

function build() {
    const el = document.createElement('dialog');
    el.className = 'app-dialog';
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
        <div class="app-dialog-head">
            <h2 class="app-dialog-title" id="app-dialog-title"></h2>
            <button type="button" class="app-dialog-x" aria-label="بستن">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
            </button>
        </div>
        <div class="app-dialog-body" id="app-dialog-body"></div>
        <div class="app-dialog-actions" id="app-dialog-actions"></div>`;
    document.body.appendChild(el);
    return el;
}

function settle(el, value) {
    if (current?.el !== el) return;
    const { resolve } = current;
    current = null;
    if (el.open) el.close();
    el.remove();
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
    resolve(value);
}

/**
 * Create + show a dialog.
 * @param {string} title
 * @param {string|HTMLElement} body
 * @param {Array<{label: string, value: any, tone?: 'primary'|'danger'|'ghost'}>} actions
 * @param {{html?: boolean, focusIndex?: number}} [opts]
 * @returns {Promise<any>}
 */
function show(title, body, actions, opts = {}) {
    // Only one dialog at a time: a silent replacement keeps the UI coherent.
    if (current) {
        const previous = current;
        current = null;
        if (previous.el.open) previous.el.close();
        previous.el.remove();
        previous.resolve(null);
    }
    const el = build();
    lastFocus = document.activeElement;
    el.querySelector('#app-dialog-title').textContent = title;

    const bodyEl = el.querySelector('#app-dialog-body');
    if (body instanceof HTMLElement) bodyEl.appendChild(body);
    else if (opts.html) bodyEl.innerHTML = body || '';
    else bodyEl.textContent = body || '';

    const row = el.querySelector('#app-dialog-actions');
    // three or more choices read better as a stacked list than as a wrapped row
    if (actions.length > 2) row.classList.add('is-stacked');
    const buttons = actions.map((action) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn btn-${action.tone || 'ghost'}`;
        btn.textContent = action.label;
        btn.addEventListener('click', () => settle(el, action.value));
        row.appendChild(btn);
        return btn;
    });

    el.querySelector('.app-dialog-x').addEventListener('click', () => settle(el, null));
    el.addEventListener('close', () => settle(el, null));          // Esc / backdrop
    el.addEventListener('cancel', (e) => { e.preventDefault(); settle(el, null); });

    return new Promise((resolve) => {
        current = { el, resolve };
        el.showModal();
        (buttons[opts.focusIndex ?? 0] || el.querySelector('.app-dialog-x')).focus();
    });
}

/**
 * Confirmation dialog.
 * @returns {Promise<boolean>}
 */
export function confirmDialog(title, message = '', opts = {}) {
    return show(
        title,
        message,
        [
            { label: opts.cancelLabel || 'انصراف', value: false, tone: 'ghost' },
            { label: opts.okLabel || 'تأیید', value: true, tone: opts.danger ? 'danger' : 'primary' },
        ],
        { focusIndex: 1 },
    ).then(Boolean);
}

/**
 * Multi-option dialog — used where "cancel" is not the only alternative
 * (e.g. the owner leaving the class vs. ending it for everybody).
 * @param {string} title
 * @param {string|HTMLElement} message
 * @param {Array<{id: any, label: string, tone?: string}>} options
 * @returns {Promise<any|null>} the chosen `id`, or null when dismissed
 */
export function choiceDialog(title, message, options) {
    return show(title, message, options.map((opt, index) => ({
        label: opt.label,
        value: opt.id,
        tone: opt.tone || (index === 0 ? 'primary' : 'ghost'),
    })));
}

/**
 * Informational dialog (help, shortcuts, problem report…).
 * @param {string} title
 * @param {string|HTMLElement} content — strings are treated as app-authored HTML
 * @param {string} [okLabel]
 * @returns {Promise<void>}
 */
export function infoDialog(title, content, okLabel = 'بستن') {
    return show(
        title,
        content,
        [{ label: okLabel, value: true, tone: 'primary' }],
        { html: typeof content === 'string' },
    ).then(() => undefined);
}
