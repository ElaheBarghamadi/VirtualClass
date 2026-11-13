/* Progressive enhancement for the "add a question" form on the quiz detail
   page: reveals up to ten option rows instead of hard-coding four.

   Everything here is optional. The form ships two required rows in HTML, so a
   browser without JS still submits a valid two-option question; the extra rows
   only appear when someone asks for them, and hidden rows disable their inputs
   so they are never submitted empty. */
(function () {
    'use strict';

    const fieldset = document.getElementById('options-fieldset');
    const addBtn = document.getElementById('add-option');
    if (!fieldset || !addBtn) return;

    const min = Number(fieldset.dataset.min) || 2;
    const max = Number(fieldset.dataset.max) || 10;
    const extras = Array.from(fieldset.querySelectorAll('.option-row--extra'));
    let shown = min;

    function rows() {
        return Array.from(fieldset.querySelectorAll('.option-row'));
    }

    function sync() {
        rows().forEach((row, index) => {
            const active = index < shown;
            row.hidden = !active;
            row.querySelectorAll('input').forEach((input) => {
                input.disabled = !active;
            });
            // Only the first two rows are mandatory; beyond that a blank row is
            // simply ignored by the server.
            const text = row.querySelector('input[type="text"]');
            if (text) text.required = index < min;
        });
        addBtn.hidden = shown >= max || shown >= rows().length;
        addBtn.textContent = '+ گزینه';
    }

    addBtn.addEventListener('click', () => {
        if (shown >= max || shown >= rows().length) return;
        shown += 1;
        sync();
        const next = rows()[shown - 1];
        const text = next && next.querySelector('input[type="text"]');
        if (text) text.focus();
    });

    // Escape closes the newest optional row again.
    fieldset.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || shown <= min) return;
        event.preventDefault();
        shown -= 1;
        sync();
    });

    sync();
})();
