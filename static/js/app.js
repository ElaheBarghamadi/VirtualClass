/**
 * app.js — global UI helpers (loaded on every page).
 * Currently: "Copy Link" buttons for classroom URLs.
 */
document.addEventListener('click', (event) => {
    const copyBtn = event.target.closest('[data-copy-link] [data-copy]');
    if (!copyBtn) return;

    const box = copyBtn.closest('[data-copy-link]');
    const input = box.querySelector('input');

    const done = () => {
        const original = copyBtn.textContent;
        copyBtn.textContent = '✓ کپی شد';
        copyBtn.classList.add('copied');
        setTimeout(() => {
            copyBtn.textContent = original;
            copyBtn.classList.remove('copied');
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
