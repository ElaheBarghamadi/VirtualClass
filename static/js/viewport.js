/**
 * viewport.js — keeps the layout tied to the *visual* viewport.
 *
 * Mobile keyboards used to knock the room out of shape: opening the composer
 * shrank the visible area, the browser scrolled the page to reveal the input,
 * and closing the keyboard left everything half a screen off. Two things fix
 * that, and this file is the second one:
 *
 *  1. the viewport meta asks Chrome to *resize the content* rather than just
 *     overlay the keyboard (see base.html);
 *  2. the visible height is published as `--app-h`, so the room is exactly as
 *     tall as what the user can actually see — on Safari, which never resizes
 *     the layout viewport, this is the only value that keeps the composer
 *     above the keyboard instead of underneath it.
 *
 * `--kb` (the covered slice) and `html.kb-open` let the few fixed surfaces
 * step aside while the keyboard is up. Pinch-zoom is ignored on purpose: while
 * zoomed the user wants to inspect the current layout, not relayout it.
 */

const root = document.documentElement;
const viewport = window.visualViewport;
const KEYBOARD_MIN = 100; // px — a smaller difference is browser chrome, not a keyboard

let frame = 0;

function measure() {
    frame = 0;
    const layoutHeight = window.innerHeight || root.clientHeight;
    const zoomed = viewport ? viewport.scale > 1.05 : false;
    const visible = viewport && !zoomed ? viewport.height : layoutHeight;
    const height = Math.round(visible) || layoutHeight;
    const covered = Math.max(0, Math.round(layoutHeight - height));
    const keyboard = covered >= KEYBOARD_MIN ? covered : 0;

    root.style.setProperty('--app-h', `${height}px`);
    root.style.setProperty('--kb', `${keyboard}px`);

    const open = keyboard > 0;
    if (root.classList.contains('kb-open') !== open) {
        root.classList.toggle('kb-open', open);
        // Let modules that place floating UI (picker, PiP) recompute once.
        window.dispatchEvent(new CustomEvent('app:viewport', {
            detail: { height, keyboard, open },
        }));
    }
}

function schedule() {
    if (frame) return;
    frame = window.requestAnimationFrame(measure);
}

measure();
if (viewport) {
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
}
window.addEventListener('resize', schedule);
window.addEventListener('orientationchange', () => {
    // Orientation swaps report stale numbers for a frame or two.
    schedule();
    window.setTimeout(measure, 220);
});
