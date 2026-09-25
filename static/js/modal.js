/**
 * modal.js — the single dialog component used across the room.
 *
 * One accessible <dialog> is created lazily and reused: focus is trapped
 * by the platform, Esc closes, and focus returns to the opener. All
 * confirmations (leave, remove, end session…) go through confirmDialog
 * so styling/behaviour stays consistent.
 */

let dialog = null;
let resolveFn = null;
let lastFocus = null;

function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'app-dialog';
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `
        <div class="app-dialog-head">
            <h2 class="app-dialog-title" id="app-dialog-title"></h2>
            <button type="button" class="app-dialog-x" aria-label="بستن">✕</button>
        </div>
        <div class="app-dialog-body" id="app-dialog-body"></div>
        <div class="app-dialog-actions">
            <button type="button" class="btn btn-ghost" data-act="cancel"></button>
            <button type="button" class="btn btn-primary" data-act="ok"></button>
        </div>`;
    document.body.appendChild(dialog);

    dialog.querySelector('.app-dialog-x').addEventListener('click', () => finish(false));
    dialog.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
    dialog.querySelector('[data-act="ok"]').addEventListener('click', () => finish(true));
    dialog.addEventListener('close', () => finish(dialog.returnValue === 'ok'));
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });
    return dialog;
}

function finish(value) {
    if (dialog?.open) dialog.close(value ? 'ok' : 'cancel');
    if (resolveFn) {
        const r = resolveFn;
        resolveFn = null;
        r(value);
    }
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
}

/**
 * Open a confirmation dialog.
 * @param {string} title
 * @param {string} [message]
 * @param {{okLabel?: string, cancelLabel?: string, danger?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(title, message = '', opts = {}) {
    const d = ensureDialog();
    lastFocus = document.activeElement;
    d.querySelector('#app-dialog-title').textContent = title;
    d.querySelector('#app-dialog-body').textContent = message;
    const ok = d.querySelector('[data-act="ok"]');
    const cancel = d.querySelector('[data-act="cancel"]');
    ok.textContent = opts.okLabel || 'تأیید';
    cancel.textContent = opts.cancelLabel || 'انصراف';
    ok.className = `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`;
    ok.style.display = '';
    cancel.style.display = '';
    return new Promise((resolve) => {
        resolveFn = resolve;
        d.returnValue = '';
        d.showModal();
        ok.focus();
    });
}

/**
 * Open an informational dialog (help, shortcuts, problem report…).
 * @param {string} title
 * @param {string|HTMLElement} content — string is inserted as text-safe HTML
 * @param {string} [okLabel]
 * @returns {Promise<void>}
 */
export function infoDialog(title, content, okLabel = 'بستن') {
    const d = ensureDialog();
    lastFocus = document.activeElement;
    d.querySelector('#app-dialog-title').textContent = title;
    const body = d.querySelector('#app-dialog-body');
    if (typeof content === 'string') body.innerHTML = content;
    else { body.textContent = ''; body.appendChild(content); }
    d.querySelector('[data-act="ok"]').textContent = okLabel;
    d.querySelector('[data-act="ok"]').style.display = '';
    d.querySelector('[data-act="cancel"]').style.display = 'none';
    return new Promise((resolve) => {
        resolveFn = () => resolve();
        d.returnValue = '';
        d.showModal();
        d.querySelector('[data-act="ok"]').focus();
    });
}
