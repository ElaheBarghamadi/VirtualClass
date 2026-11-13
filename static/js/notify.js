/**
 * notify.js — turns server-side flash messages into the same toast stack the
 * rest of the app uses.
 *
 * Django renders `messages` at the top of <main>, which meant two different
 * notification looks depending on whether a message came from JS or from a
 * view. The markup now carries the text as data (hidden, and duplicated inside
 * <noscript> so it still works without JS) and this module hands it to
 * toast.js, so there is exactly one visual language for "something happened".
 */

import { toast } from './toast.js';

const LEVELS = new Set(['success', 'warning', 'error', 'danger', 'info', 'debug']);
const ALIASES = { danger: 'error', debug: 'info' };

function levelOf(tags) {
    const words = String(tags || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hit = words.find((word) => LEVELS.has(word));
    return ALIASES[hit] || hit || 'info';
}

function promote() {
    const source = document.querySelector('[data-notify-source]');
    if (!source) return;
    const items = Array.from(source.querySelectorAll('[data-message]'));
    source.remove();

    items.forEach((node, index) => {
        const text = node.textContent.replace(/\s+/g, ' ').trim();
        if (!text) return;
        const level = levelOf(node.getAttribute('data-message'));
        // Stagger them: three messages arriving on the same frame read as a
        // wall otherwise.
        window.setTimeout(
            () => toast(text, level, level === 'error' ? 7600 : 4600),
            index * 110,
        );
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', promote, { once: true });
} else {
    promote();
}
