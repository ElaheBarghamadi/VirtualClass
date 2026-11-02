/**
 * app.js — global UI helpers (loaded on every page).
 * Currently: "Copy Link" buttons for classroom URLs.
 */
document.addEventListener('click', (event) => {
    const copyBtn = event.target.closest('[data-copy-link] [data-copy]');
    if (!copyBtn) return;

    const box = copyBtn.closest('[data-copy-link]');
    const input = box.querySelector('input');

    const CHECK_SVG =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"' +
        ' stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"' +
        ' aria-hidden="true" class="copy-check"><path d="M4.5 12.5 9.5 17.5 19.5 6.5"/></svg>';

    // Text is set with innerHTML so the confirmation uses the same line-icon
    // language as the rest of the UI (no ✓ glyph, no emoji).
    const done = () => {
        if (copyBtn.dataset.busy === '1') return;
        copyBtn.dataset.busy = '1';
        const original = copyBtn.innerHTML;
        copyBtn.innerHTML = CHECK_SVG + '<span>کپی شد</span>';
        copyBtn.classList.add('copied');
        setTimeout(() => {
            copyBtn.innerHTML = original;
            copyBtn.classList.remove('copied');
            delete copyBtn.dataset.busy;
        }, 1600);
    };

    // Clipboard API with a selection fallback for insecure contexts.
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(input.value).then(done).catch(() => fallback());
    } else {
        fallback();
    }

    function fallback() {
        input.select();
        input.setSelectionRange(0, 99999);
        try { document.execCommand('copy'); done(); } catch (e) { /* ignored */ }
    }
});

/* --------------------------------------------------------------------------
 * Colour swatches
 * A <input type="color"> cannot style its own wrapper, so any `.wb-swatch`
 * (whiteboard ink, page background, presentation annotations) mirrors the
 * picked value into a `--sw` custom property that paints the visible dot.
 * Delegated + bubbling `input` events work for controls created later too.
 * ------------------------------------------------------------------------ */
const paintSwatch = (input) => {
    const wrap = input.closest('.wb-swatch');
    if (wrap) wrap.style.setProperty('--sw', input.value);
};
document.addEventListener('input', (event) => {
    if (event.target.matches?.('input[type="color"]')) paintSwatch(event.target);
});
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.wb-swatch input[type="color"]').forEach(paintSwatch);
});
