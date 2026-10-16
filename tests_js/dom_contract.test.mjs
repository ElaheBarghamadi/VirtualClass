/**
 * dom_contract.test.mjs — the markup and the client have to agree.
 *
 * Every id the engine reaches for (`getElementById`, the `$()`/`q()` helpers)
 * and every selector it binds has to exist in the real room template.  A typo
 * here is invisible to the other suites — they boot against the same markup and
 * silently skip a missing hook with `?.` — but in the browser it is exactly
 * "the whiteboard does not work": a button that does nothing, a palette that
 * never opens, a hint that never shows.
 *
 * The scanning is deliberately dumb (regex over the source).  Anything that is
 * legitimately created at runtime is listed below with the reason, and the list
 * is checked for stale entries, so it cannot rot silently.
 *
 * Run: node dom_contract.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const TEMPLATE = path.join(REPO, 'classrooms/templates/classrooms/room.html');

const CLIENT_FILES = [
    'static/js/whiteboard.js',
    ...fs.readdirSync(path.join(REPO, 'static/js/wb'))
        .filter((name) => name.endsWith('.js'))
        .sort()
        .map((name) => `static/js/wb/${name}`),
    'static/js/room.js',
];

/* ------------------------------------------------------------------ */
/* things that only exist once the page has been rendered at runtime   */
/* ------------------------------------------------------------------ */
const RUNTIME_IDS = {
    'member-permissions': 'rendered by {{ permissions|json_script:"member-permissions" }}',
};

const RUNTIME_SELECTORS = {
    '[name=csrfmiddlewaretoken]': 'rendered by {% csrf_token %}',
    'dialog[open]': 'state-dependent: only matches while a modal is up',
    '.wb-popover:not(.hidden)': 'state-dependent: only matches while a popover is open',
    '.participant-avatar': 'roster rows are built by room.js',
    '.participant-name': 'roster rows are built by room.js',
    '.participant-role': 'roster rows are built by room.js',
    '#perms-list input[type=checkbox]': 'the per-member permission list is built by room.js',
    '#report-text': 'the report dialog body is built by room.js',
    '.wb-swatch[data-color]': 'the colour palettes are built by wb/ui.js',
    '#wb-sticky-palette .wb-swatch': 'the sticky palette is built by wb/ui.js',
};

/* ------------------------------------------------------------------ */
/* tiny assertion harness (same shape as the other suites)             */
/* ------------------------------------------------------------------ */
const results = [];
async function check(name, fn) {
    try {
        const value = await fn();
        if (value === false) throw new Error('assertion returned false');
        results.push({ name, ok: true });
        console.log(`ok   ${name}`);
    } catch (err) {
        results.push({ name, ok: false, err });
        console.log(`FAIL ${name}\n     ${String(err && err.message).split('\n').join('\n     ')}`);
    }
}
function assert(cond, message) {
    if (!cond) throw new Error(message || 'assertion failed');
}

/* ------------------------------------------------------------------ */
/* scan                                                                */
/* ------------------------------------------------------------------ */
const template = fs.readFileSync(TEMPLATE, 'utf8')
    .replace(/\{%[^%]*%\}/g, '')
    .replace(/\{\{[^}]*\}\}/g, '');
const doc = new JSDOM(`<!doctype html><html><body>${template}</body></html>`).window.document;

/** ids the client creates itself (`element.id = 'x'`) */
const createdIds = new Set();
for (const file of CLIENT_FILES) {
    const src = fs.readFileSync(path.join(REPO, file), 'utf8');
    for (const match of src.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) createdIds.add(match[1]);
    for (const match of src.matchAll(/setAttribute\(\s*['"]id['"]\s*,\s*['"]([^'"]+)['"]/g)) createdIds.add(match[1]);
}

const missingIds = new Map();
const missingSelectors = new Map();
const unparsable = new Map();
const remember = (map, key, where) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(where);
};

for (const file of CLIENT_FILES) {
    fs.readFileSync(path.join(REPO, file), 'utf8').split('\n').forEach((line, index) => {
        const where = `${file}:${index + 1}`;
        for (const match of line.matchAll(/(?:getElementById|this\.\$|(?<![\w.$])\$)\s*\(\s*['"]([^'"`$]+)['"]/g)) {
            const id = match[1];
            if (!/^[A-Za-z][\w-]*$/.test(id)) continue; // that is a selector, handled below
            if (doc.getElementById(id) || createdIds.has(id) || id in RUNTIME_IDS) continue;
            remember(missingIds, id, where);
        }
        for (const match of line.matchAll(/(?:querySelectorAll|querySelector|this\.q|this\.all)\s*\(\s*['"]([^'"`$]+)['"]/g)) {
            const selector = match[1];
            if (!/^[.#[\sa-zA-Z]/.test(selector)) continue;
            if (selector in RUNTIME_SELECTORS) {
                RUNTIME_SELECTORS[selector] = `USED ${where}`;
                continue;
            }
            try {
                if (!doc.querySelectorAll(selector).length) remember(missingSelectors, selector, where);
            } catch {
                remember(unparsable, selector, where);
            }
        }
    });
}

const list = (map) => [...map].map(([key, where]) => `${key}  ← ${[...where].join(', ')}`).join('\n       ');

async function main() {
    await check('every element id the client asks for exists in the room template', () => {
        assert(missingIds.size === 0, `missing:\n       ${list(missingIds)}`);
    });

    await check('every selector the client binds matches something in the room template', () => {
        assert(missingSelectors.size === 0, `no match for:\n       ${list(missingSelectors)}`);
    });

    await check('the runtime-only allowlist has no stale entries', () => {
        const stale = Object.entries(RUNTIME_SELECTORS)
            .filter(([, value]) => !value.startsWith('USED'))
            .map(([key]) => key);
        assert(stale.length === 0, `no longer referenced by the client: ${stale.join(', ')}`);
        const staleIds = ['member-permissions'].filter((id) => !fs.readFileSync(TEMPLATE, 'utf8').includes('member-permissions'));
        assert(staleIds.length === 0, `no longer in the template: ${staleIds.join(', ')}`);
    });

    await check('no client selector is truncated by the scanner', () => {
        /* Selectors built from strings ("[data-action=" + name + "]") are read
           as a truncated prefix — that is a limitation of this scan, not a bug
           in the client, so they are reported only when the scan sees a
           complete-looking selector that the DOM engine rejects. */
        const broken = [...unparsable]
            .filter(([selector]) => selector.endsWith(']') || selector.endsWith(')'));
        assert(broken.length === 0, `unexpected unparsable selectors:\n       ${list(unparsable)}`);
    });

    /* ------------------------------------------------------------------ */
    /* the anti-stale-cache contract: a stale bundle must never win        */
    /* ------------------------------------------------------------------ */
    const html = fs.readFileSync(TEMPLATE, 'utf8');
    const room = fs.readFileSync(path.join(REPO, 'static/js/room.js'), 'utf8');
    const engine = fs.readFileSync(path.join(REPO, 'static/js/whiteboard.js'), 'utf8');

    await check('the room module is loaded through a build-stamped URL', () => {
        assert(/js\/room\.js' %\}\?v=\{% client_build %\}/.test(html),
            'room.html must load js/room.js?v={% client_build %}');
    });

    await check('the whiteboard engine is imported through a build-stamped URL', () => {
        assert(/await import\(`\.\/whiteboard\.js\$\{WB_STAMP/.test(room),
            'room.js must import ./whiteboard.js with ?v=<build>');
        assert(/\?v=\$\{encodeURIComponent\(WB_STAMP\)\}/.test(room),
            'the engine URL must carry the stamp as ?v=');
        assert(/dataset\.wbBuild/.test(room), 'the stamp must come from data-wb-build');
    });

    await check('the bundle exports the stamp the page compares against', () => {
        assert(/export const BUILD = '[^']+'/.test(engine), 'whiteboard.js must export BUILD');
        assert(/__WB_EXPECTED_BUILD__/.test(html), 'the page must carry the server-side stamp');
        assert(/clientWarning/.test(html), 'a mismatch must be surfaced to the user');
    });

    const failed = results.filter((entry) => !entry.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error('dom contract suite crashed:', err);
        process.exit(2);
    });
}
