/**
 * nav.js — the site header on phones and tablets.
 *
 * The markup is the same at every width: one <nav> that is a row above 1025px
 * and a slide-in panel below it.  This file only owns the panel's state — open
 * and closed, Escape, the scrim, focus, body scroll lock — so the CSS stays
 * free of behaviour and the navigation is never duplicated.
 *
 * Three details matter more than they look:
 *  • focus is trapped inside the panel while it is open (Tab must not walk
 *    into the page behind the scrim), and returns to the burger on close;
 *  • the document scroll is locked on <html> *and* <body> — locking only the
 *    body leaves iOS free to scroll the page behind the panel;
 *  • nothing is repositioned to achieve that lock: the header must not jump,
 *    so the page keeps its scroll offset untouched.
 */
(function () {
    'use strict';

    const toggle = document.querySelector('[data-nav-toggle]');
    const panel = document.querySelector('[data-nav-panel]');
    const scrim = document.querySelector('[data-nav-scrim]');
    const desktop = window.matchMedia('(min-width: 1025px)');

    if (!toggle || !panel) return;

    const FOCUSABLE = [
        'a[href]', 'button:not([disabled])', 'input:not([disabled])',
        'select:not([disabled])', 'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    let lastFocused = null;

    function isOpen() {
        return panel.classList.contains('open');
    }

    /* Everything tabbable inside the panel.  Hidden ancestors are the only
       thing worth filtering: the panel itself is `visibility: hidden` while
       closed, and measuring layout here would be wrong mid-transition. */
    function focusable() {
        return Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
            (el) => !el.hasAttribute('hidden') && !el.closest('[hidden]'),
        );
    }

    /* Locking both elements covers the browsers that ignore one of them; the
       page never moves, so there is no scroll offset to restore afterwards. */
    function lockScroll() {
        document.documentElement.classList.add('nav-lock');
        document.body.classList.add('nav-lock');
    }

    function unlockScroll() {
        document.documentElement.classList.remove('nav-lock');
        document.body.classList.remove('nav-lock');
    }

    function open() {
        if (isOpen()) return;
        lastFocused = document.activeElement;
        panel.classList.add('open');
        scrim?.classList.add('open');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.setAttribute('aria-label', 'بستن منو');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        lockScroll();
        // Land on the first real item instead of tabbing through the page.
        (focusable()[0] || panel).focus({ preventScroll: true });
    }

    function close(restoreFocus = true) {
        if (!isOpen()) return;
        panel.classList.remove('open');
        scrim?.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'باز کردن منو');
        panel.removeAttribute('role');
        panel.removeAttribute('aria-modal');
        unlockScroll();
        // `instanceof HTMLElement` across realms (iframes, test harnesses) is
        // a needless trap; a focusable reference is all this needs.
        if (restoreFocus && lastFocused && typeof lastFocused.focus === 'function') {
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
        if (!isOpen()) return;

        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
            return;
        }

        if (event.key !== 'Tab') return;
        const items = focusable();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });

    // Rotating a phone or resizing past the breakpoint leaves a "fixed" panel
    // behind if its state is not cleared.
    const onChange = (event) => {
        if (event.matches) close(false);
    };
    if (typeof desktop.addEventListener === 'function') {
        desktop.addEventListener('change', onChange);
    } else if (typeof desktop.addListener === 'function') {
        desktop.addListener(onChange); // Safari < 14
    }
})();
