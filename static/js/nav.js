/**
 * nav.js — the site header on phones.
 *
 * The markup is the same at every width: one <nav> that is a row on desktop
 * and a slide-in panel below 900px.  This file only owns the panel's state —
 * open/closed, Escape, the scrim, focus, and body scroll lock — so the CSS
 * stays free of behaviour and the navigation is never duplicated.
 */
(function () {
    'use strict';

    const toggle = document.querySelector('[data-nav-toggle]');
    const panel = document.querySelector('[data-nav-panel]');
    const scrim = document.querySelector('[data-nav-scrim]');
    const desktop = window.matchMedia('(min-width: 901px)');

    if (!toggle || !panel) return;

    let lastFocused = null;

    function isOpen() {
        return panel.classList.contains('open');
    }

    function open() {
        if (isOpen()) return;
        lastFocused = document.activeElement;
        panel.classList.add('open');
        scrim?.classList.add('open');
        document.body.classList.add('nav-open');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.setAttribute('aria-label', 'بستن منو');
        // Focus the first real item so a keyboard user lands inside the panel
        // instead of tabbing through the page behind it.
        const first = panel.querySelector('a[href], button:not([disabled])');
        first?.focus({ preventScroll: true });
    }

    function close(restoreFocus = true) {
        if (!isOpen()) return;
        panel.classList.remove('open');
        scrim?.classList.remove('open');
        document.body.classList.remove('nav-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'باز کردن منو');
        if (restoreFocus && lastFocused instanceof HTMLElement) {
            lastFocused.focus({ preventScroll: true });
        }
        lastFocused = null;
    }

    toggle.addEventListener('click', () => (isOpen() ? close() : open()));

    scrim?.addEventListener('click', () => close());

    panel.addEventListener('click', (event) => {
        if (event.target.closest('[data-nav-close]')) {
            close();
            return;
        }
        // A link navigates away; closing first avoids the panel flashing on
        // the next page for browsers that restore the DOM from the cache.
        if (event.target.closest('a[href]')) close(false);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen()) {
            event.stopPropagation();
            close();
        }
    });

    // Rotating a phone or resizing a window past the breakpoint leaves a
    // "fixed" panel behind if its state is not cleared.
    const onChange = (event) => {
        if (event.matches) close(false);
    };
    if (typeof desktop.addEventListener === 'function') {
        desktop.addEventListener('change', onChange);
    } else if (typeof desktop.addListener === 'function') {
        desktop.addListener(onChange); // Safari < 14
    }
})();
