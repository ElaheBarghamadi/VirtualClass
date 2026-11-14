/**
 * motion.js — progressive enhancement for the animation layer (motion.css).
 *
 * Nothing here is required for the app to work: every effect degrades to a
 * static (but complete) page when this file is missing, blocked, or when the
 * visitor asked the OS for reduced motion.  That is why the CSS hooks are
 * gated behind the `js-anim` class added below — no flash of invisible
 * content ever.
 *
 * The decorative half of this file is scoped to the landing page
 * (`body.is-home`): reveal-on-scroll, count-up, the press ripple and the
 * pointer parallax.  Inner pages are working screens — they get one calm
 * fade-in and nothing that keeps moving while the user reads.
 *
 *  1. Reveal-on-scroll for cards, stats and section headings (home only).
 *  2. Count-up for stat numbers (home only).
 *  3. A press ripple on primary buttons (home only).
 *  4. Pointer parallax on the landing preview (home + desktop pointers).
 *  5. Always-on shell state: sticky header shadow, scrollable nav hint and the
 *     measured header height (--header-h) used for anchor offsets.
 */
(function () {
    'use strict';

    const root = document.documentElement;

    const reduced = () =>
        root.getAttribute('data-motion') === 'reduced' ||
        (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // ---- 1. reveal on scroll -------------------------------------------------
    const REVEAL_SELECTORS = [
        '.page-head', '.hero > *', '.hero-features > *',
        '.card', '.stat-card', '.feature', '.classroom-card',
        '.section-title', '.table-wrap', '.auth-card', '.lobby-card', '.status-page',
        '.sec-head', '.step', '.role-card', '.faq-item', '.cta-band', '.cmp-wrap',
        '.move', '.showcase',
    ];

    function tagReveals() {
        const seen = new Set();
        let i = 0;
        REVEAL_SELECTORS.forEach((sel) => {
            document.querySelectorAll(sel).forEach((el) => {
                if (seen.has(el) || el.hasAttribute('data-reveal')) return;
                // never hide something that is already animating on its own
                if (el.closest('.room, dialog, .toast-container, .app-dialog')) return;
                seen.add(el);
                el.setAttribute('data-reveal', '');
                el.style.setProperty('--reveal-delay', String(Math.min(i, 8) * 55));
                i += 1;
            });
        });
    }

    function observeReveals() {
        const targets = document.querySelectorAll('[data-reveal]:not(.is-revealed)');
        if (!targets.length) return;

        if (!('IntersectionObserver' in window) || reduced()) {
            targets.forEach((el) => el.classList.add('is-revealed'));
            return;
        }

        const io = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add('is-revealed');
                io.unobserve(entry.target);
            });
        }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

        targets.forEach((el) => io.observe(el));
    }

    // ---- 2. count-up for stat numbers ---------------------------------------
    function parseNumber(text) {
        // Accept both Latin and Persian digits; keep everything else intact.
        const map = { '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
                      '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
        const latin = text.replace(/[۰-۹]/g, (d) => map[d]).replace(/[,٬\s]/g, '');
        const n = Number(latin);
        return Number.isFinite(n) ? n : null;
    }

    function countUp(el) {
        const raw = (el.textContent || '').trim();
        const target = parseNumber(raw);
        if (target === null || target === 0) return;
        const persian = /[۰-۹]/.test(raw);
        const format = (v) => (persian
            ? Math.round(v).toLocaleString('fa-IR')
            : Math.round(v).toLocaleString('en-US'));
        const duration = 750;
        const start = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
            el.textContent = format(target * eased);
            if (t < 1) requestAnimationFrame(step);
            else el.textContent = format(target);
        };
        el.textContent = format(0);
        requestAnimationFrame(step);
    }

    function animateStats() {
        if (reduced()) return;
        document.querySelectorAll('.stat-value').forEach((el) => {
            if (!('IntersectionObserver' in window)) return countUp(el);
            const io = new IntersectionObserver((entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    countUp(el);
                    io.disconnect();
                }
            }, { threshold: 0.4 });
            io.observe(el);
        });
    }

    // ---- 3. press ripple ----------------------------------------------------
    const RIPPLE_TARGETS = '.btn-primary, .ctrl-btn, .ctrl-exit';

    function ripple(event) {
        if (reduced()) return;
        const el = event.target.closest(RIPPLE_TARGETS);
        if (!el || el.disabled) return;

        const rect = el.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height) * 1.2;
        const dot = document.createElement('span');
        dot.className = 'press-ripple';
        dot.setAttribute('aria-hidden', 'true');
        dot.style.width = dot.style.height = `${size}px`;
        dot.style.left = `${event.clientX - rect.left - size / 2}px`;
        dot.style.top = `${event.clientY - rect.top - size / 2}px`;
        // Overlays must not swallow the click target's own styles.
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        el.appendChild(dot);
        window.setTimeout(() => dot.remove(), 620);
    }

    // ---- 4. pointer parallax on the landing preview --------------------------
    // The demo card leans towards the pointer, so the hero reacts to the
    // visitor before they scroll.  Skipped entirely for touch input and for
    // anybody who asked for reduced motion.
    function heroParallax() {
        const preview = document.querySelector('.hero-preview');
        const card = preview && preview.querySelector('.hp-card');
        if (!card || reduced()) return;
        if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

        let frame = 0;
        let nextX = 0;
        let nextY = 0;

        const paint = () => {
            frame = 0;
            card.style.setProperty('--hp-ry', `${nextX.toFixed(2)}deg`);
            card.style.setProperty('--hp-rx', `${nextY.toFixed(2)}deg`);
        };

        preview.addEventListener('pointermove', (event) => {
            const box = preview.getBoundingClientRect();
            if (!box.width || !box.height) return;
            nextX = ((event.clientX - box.left) / box.width - 0.5) * 7;
            nextY = -((event.clientY - box.top) / box.height - 0.5) * 5;
            if (!frame) frame = requestAnimationFrame(paint);
        }, { passive: true });

        preview.addEventListener('pointerleave', () => {
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
            card.style.setProperty('--hp-ry', '0deg');
            card.style.setProperty('--hp-rx', '0deg');
        });
    }

    // ---- 5. sticky header + scrollable nav affordances -----------------------
    // The header changes height between breakpoints (and shrinks once the page
    // is scrolled), so its measured height is published for scroll offsets —
    // a fixed `scroll-padding-top: 76px` was wrong at every other width.
    function headerHeight() {
        const header = document.querySelector('.site-header');
        if (!header) return;
        const apply = () => {
            const h = Math.round(header.getBoundingClientRect().height);
            if (h > 0) root.style.setProperty('--header-h', `${h}px`);
        };
        apply();
        if ('ResizeObserver' in window) new ResizeObserver(apply).observe(header);
        else window.addEventListener('resize', apply);
        window.addEventListener('load', apply);
    }

    // How far down the page we are, as 0…1, written to the header hairline.
    // Measured from the *document* height so a page that grows (images, fonts,
    // an opened FAQ answer) reports honestly instead of overshooting.
    function scrollFraction() {
        const doc = document.documentElement;
        const scrollable = doc.scrollHeight - window.innerHeight;
        if (scrollable <= 8) return 0;
        return Math.min(1, Math.max(0, window.scrollY / scrollable));
    }

    function headerState() {
        const header = document.querySelector('.site-header');
        if (!header) return;
        const bar = document.querySelector('.scroll-progress');
        let ticking = false;
        const sync = () => {
            ticking = false;
            header.classList.toggle('is-scrolled', window.scrollY > 8);
            if (bar) bar.style.setProperty('--progress', scrollFraction().toFixed(4));
        };
        window.addEventListener('scroll', () => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(sync);
        }, { passive: true });
        // a resize or a late font/resource changes the total height
        window.addEventListener('resize', sync, { passive: true });
        window.addEventListener('load', sync);
        sync();
    }

    function navOverflowHint() {
        const nav = document.querySelector('.main-nav');
        if (!nav) return;
        const sync = () => nav.classList.toggle('can-scroll', nav.scrollWidth - nav.clientWidth > 4);
        sync();
        window.addEventListener('resize', sync, { passive: true });
        // Web fonts land after first paint and can push the row into overflow,
        // so re-measure once they are ready (and once the window has loaded).
        window.addEventListener('load', sync);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(sync).catch(() => {});
        if ('ResizeObserver' in window) new ResizeObserver(sync).observe(nav);
    }

    function init() {
        root.classList.add('js-anim');
        // Shell state runs on every page; it is not decoration.
        headerState();
        headerHeight();
        navOverflowHint();

        // Decorative motion belongs to the landing page only.  Working screens
        // (dashboard, lists, forms, auth) stay still: one short fade-in from
        // CSS and responsive hover feedback, nothing else.
        if (!document.body.classList.contains('is-home')) return;

        tagReveals();
        observeReveals();
        animateStats();
        heroParallax();
        document.addEventListener('pointerdown', ripple, { passive: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Re-scan when the app swaps large chunks of the DOM (file lists, roster…).
    window.MotionRefresh = () => {
        if (!document.body.classList.contains('is-home')) return;
        tagReveals();
        observeReveals();
    };
})();
