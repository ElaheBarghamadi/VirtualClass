/**
 * vendor.js — the three big browser libraries, fetched on first use.
 *
 * The room used to ship ~1.1 MB of vendor JavaScript to every participant
 * before the first frame: the LiveKit client (423 KB), fabric.js (313 KB) and
 * pdf.js (377 KB).  A student who opens the class to listen, ask one question
 * and leave never needed two of the three, and a mesh-only deployment (no SFU)
 * never needs LiveKit at all.
 *
 * Each library is therefore loaded the first time something actually asks for
 * it, exactly once (concurrent callers share one promise), and cached by the
 * browser from then on.  `window.VC_VENDOR` holds the (asset-versioned) URLs,
 * so the template still owns every path — this module never invents one.
 *
 * Failure is not fatal: the caller gets a rejected promise, shows its own
 * message ("the board could not load"), and the rest of the room keeps working.
 */

/** library name → the global the UMD bundle defines. */
const GLOBALS = {
    fabric: 'fabric',
    pdf: 'pdfjsLib',
    livekit: 'LivekitClient',
};

/** name → Promise, so two panels opening at once share one <script>. */
const _pending = new Map();

function sourceUrl(name) {
    const map = window.VC_VENDOR || {};
    const url = map[name];
    if (!url) throw new Error(`vendor: no URL configured for "${name}"`);
    return url;
}

/** Has the library's global appeared? (Cheap; no network.) */
export function isVendorLoaded(name) {
    const globalName = GLOBALS[name];
    return Boolean(globalName) && typeof window[globalName] !== 'undefined';
}

/**
 * Load `name` if it is not loaded yet.  Resolves with the library's global.
 * @param {'fabric'|'pdf'|'livekit'} name
 */
export function loadVendor(name, { timeoutMs = 20000 } = {}) {
    if (!GLOBALS[name]) return Promise.reject(new Error(`vendor: unknown library "${name}"`));
    if (isVendorLoaded(name)) return Promise.resolve(window[GLOBALS[name]]);
    if (_pending.has(name)) return _pending.get(name);

    const promise = new Promise((resolve, reject) => {
        let settled = false;
        // A stalled proxy must not leave a panel spinning forever.
        const timer = setTimeout(
            () => finish(reject, new Error(`vendor: timed out loading "${name}"`)),
            timeoutMs,
        );
        function finish(fn, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        }

        const script = document.createElement('script');
        script.src = sourceUrl(name);
        script.async = true;
        script.onload = () => {
            if (isVendorLoaded(name)) finish(resolve, window[GLOBALS[name]]);
            else finish(reject, new Error(`vendor: "${name}" loaded but defined no global`));
        };
        script.onerror = () => finish(reject, new Error(`vendor: failed to load "${name}"`));

        document.head.appendChild(script);
    }).catch((err) => {
        // Allow a retry on the next attempt (a flaky network should not poison
        // the panel for the rest of the lesson).
        _pending.delete(name);
        throw err;
    });

    _pending.set(name, promise);
    return promise;
}
