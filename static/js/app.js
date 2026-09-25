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
