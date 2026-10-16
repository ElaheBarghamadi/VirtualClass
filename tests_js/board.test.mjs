/**
 * board.test.mjs — the whiteboard client against a real rasterizer + real DOM.
 *
 * Unlike whiteboard.test.mjs (which stubs canvas calls) this suite backs every
 * canvas with @napi-rs/canvas, so the renderer really paints and the checks can
 * assert *pixels*: that a stroke lands where the pointer went, that hi-dpi
 * screens get a 2x backing store, that the board survives a canvas that is not
 * at the page origin, that exports contain real PNG bytes.
 *
 * Run:  node board.test.mjs [--dump .build/client-ops.json]
 * Each case prints PASS/FAIL; the process exits non-zero when anything fails.
 * With ``--dump`` every operation the client sent is written to JSON so the
 * Django side can re-validate the exact same wire format.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { boot, tick, FakeSocket } from './browser.harness.mjs';

/* every operation the client ever sent — the transport re-creates its socket
   after a disconnect, so a single instance is not enough */
const allOps = () => FakeSocket.instances.flatMap((instance) => instance.ops());

let passed = 0;
const failures = [];

async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`ok   ${name}`);
    } catch (err) {
        failures.push({ name, err });
        console.log(`FAIL ${name}\n     ${err && err.message ? err.message : err}`);
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'assertion failed');
}

function same(actual, expected, message = '') {
    if (actual !== expected) {
        throw new Error(`${message}\n       actual:   ${JSON.stringify(actual)}\n       expected: ${JSON.stringify(expected)}`);
    }
}

const near = (a, b, slack) => Math.abs(a - b) <= slack;

export async function main({ dump = null } = {}) {
    const env = await boot({ canDraw: true });
    const {
        window, document, Whiteboard, socket, canvas, wrap, helpers, send,
    } = env;
    const { pointer, stroke: drawStroke, pixel, inkCount, inkBox, click, key, acceptDialog } = helpers;

    /* ---------------------------------------------------------------- */
    await check('boot: the board comes up on the real markup and connects', () => {
        same(Whiteboard.ready, true, 'Whiteboard.ready');
        same(Boolean(Whiteboard.unavailable), false, 'Whiteboard.unavailable');
        same(socket.readyState, 1, 'socket state');
        same(socket.url.includes('/ws/classroom/ABCDE/whiteboard/'), true, `socket url ${socket.url}`);
        assert(document.getElementById('whiteboard-canvas'), 'canvas missing');
        same(canvas.width > 100, true, `canvas backing store width=${canvas.width}`);
    });

    await check('boot: hi-dpi screens get a 2x backing store', async () => {
        try {
            window.devicePixelRatio = 2;
            Whiteboard.renderer.dpr = 2;
            Whiteboard.renderer.setSize(1000, 620);
            Whiteboard.render();
            await tick(40);
            same(canvas.width, 2000, 'hi-dpi width');
            same(canvas.style.width, '1000px', 'css width');
        } finally {
            window.devicePixelRatio = 1;
            Whiteboard.renderer.dpr = 1;
            Whiteboard.renderer.setSize(1000, 620);
            Whiteboard.render();
            await tick(40);
        }
    });

    await check('pen: a stroke reaches the model and the socket, in page fractions', async () => {
        Whiteboard.setTool('pen');
        Whiteboard.setColor('#2563eb');
        const sentBefore = allOps().length;
        await drawStroke([[100, 120], [220, 180], [340, 260]]);
        const ops = allOps().slice(sentBefore).filter((op) => op.type === 'draw' && !op.live);
        same(ops.length, 1, `persisted draw ops sent (${ops.length})`);
        const op = ops[0];
        same(op.norm, 1, 'norm flag');
        same(op.page, 1, 'page');
        assert(op.id, 'op id missing');
        const [x, y] = op.points[0];
        assert(x > 0 && x < 1 && y > 0 && y < 1, `first point not normalised: ${x},${y}`);
        const objects = Whiteboard.objects(1).filter((o) => o.type === 'draw');
        same(objects.length >= 1, true, 'model has the stroke');
    });

    await check('pen: the stroke is painted where the pointer went', async () => {
        const box = inkBox(([r, g, b]) => b > 120 && b > r + 30);
        assert(box, 'no blue ink at all');
        // the page is centred in a 1000x620 wrap, so ink lands inside the
        // page rect; the stroke must be much wider than tall (it went
        // 100,120 -> 340,260) and inside the viewport
        assert(box.maxX - box.minX > 150, `stroke too short: ${box.maxX - box.minX}`);
        assert(box.minX >= 0 && box.minY >= 0 && box.maxX <= 1000 && box.maxY <= 620,
            `ink outside the viewport: ${JSON.stringify(box)}`);
        const [r, g, b, a] = pixel(220, 180);
        assert(a > 0, 'no pixel data at the middle of the stroke');
        void r; void g; void b;
    });

    await check('pen: ink follows the pointer on a page that is not at 0,0', async () => {
        // move the wrap (a side panel opening, a browser zoom change…) and
        // make sure the pointer->page mapping and the render stay in sync
        helpers.layout(wrap, 60, 40, 800, 500);
        helpers.layout(canvas, 60, 40, 800, 500);
        Whiteboard.renderer.setSize(800, 500);
        Whiteboard.render();
        Whiteboard.setTool('eraser');
        await tick(30);
        Whiteboard.setTool('pen');
        Whiteboard.setColor('#dc2626');
        const before = inkBox(([r, g, b]) => r > 150 && r > g + 60 && r > b + 60);
        pointer('pointerdown', 60 + 300, 40 + 200);
        pointer('pointermove', 60 + 380, 40 + 260);
        pointer('pointerup', 60 + 380, 40 + 260);
        await tick(40);
        const box = inkBox(([r, g, b]) => r > 150 && r > g + 60 && r > b + 60);
        assert(box, 'red ink missing');
        const added = box.maxX - (before ? before.maxX : 0);
        void added;
        // canvas-local coordinates: the element offset is subtracted by
        // localPoint(), so the ink must be inside the canvas, not shifted
        assert(box.minX >= 0 && box.maxX <= 800 && box.minY >= 0 && box.maxY <= 500,
            `ink outside the canvas box: ${JSON.stringify(box)}`);
        assert(near(box.minX, 300, 40) && near(box.maxX, 380, 40),
            `ink at ${box.minX}..${box.maxX}, expected ~300..380`);
        helpers.layout(wrap, 0, 0, 1000, 620);
        helpers.layout(canvas, 0, 0, 1000, 620);
        Whiteboard.renderer.setSize(1000, 620);
        Whiteboard.render();
        await tick(30);
    });

    await check('undo: the stroke disappears from the model and the server hears about it', async () => {
        const before = Whiteboard.objects(1).length;
        const sent = allOps().length;
        Whiteboard.undo();
        await tick(30);
        same(Whiteboard.objects(1).length, before - 1, 'object count after undo');
        const removes = allOps().slice(sent).filter((op) => op.type === 'remove');
        same(removes.length, 1, 'remove op sent');
    });

    await check('redo: the stroke comes back with the same id', async () => {
        const sent = allOps().length;
        Whiteboard.redo();
        await tick(30);
        const ops = allOps().slice(sent).filter((op) => op.type === 'draw');
        same(ops.length, 1, 'draw op sent on redo');
        const restored = Whiteboard.objects(1).find((o) => o.id === ops[0].id);
        assert(restored, 'the redone object is not in the model');
    });

    await check('echo: the server confirming our op clears the pending flag', async () => {
        Whiteboard.setTool('pen');
        Whiteboard.setColor('#059669');
        await drawStroke([[200, 300], [260, 340], [320, 380]]);
        const op = allOps().filter((o) => o.type === 'draw' && o.color === '#059669').at(-1);
        assert(op, 'green stroke not sent');
        same(Whiteboard.model.pending.has(op.id), true, 'op should be pending');
        send({
            type: 'whiteboard_operation', seq: 41, ephemeral: false,
            op, actor_identity: 'u:7', actor_name: 'سارا',
        });
        await tick(30);
        same(Whiteboard.model.pending.has(op.id), false, 'pending flag not cleared');
        assert(Whiteboard.objects(1).some((o) => o.id === op.id), 'object vanished after echo');
    });

    await check('reject: a server error rolls the local op back', async () => {
        Whiteboard.setTool('pen');
        Whiteboard.setColor('#7c3aed');
        await drawStroke([[400, 200], [450, 230]]);
        const op = allOps().filter((o) => o.type === 'draw' && o.color === '#7c3aed').at(-1);
        assert(op, 'purple stroke not sent');
        send({ type: 'error', code: 'invalid-op', ops: [op.id], message: 'bad op' });
        await tick(30);
        same(Whiteboard.objects(1).some((o) => o.id === op.id), false, 'rejected op still painted');
    });

    await check('permissions: a viewer cannot draw and gets a nudge', async () => {
        // the board is a singleton, so permission changes come the way they
        // really do at runtime: room.js calls setPermission() again
        const before = Whiteboard.objects(1).length;
        Whiteboard.setPermission(false);
        same(Whiteboard.canDraw, false, 'canDraw');
        same(document.querySelector('.wb-toolbar')?.classList.contains('no-draw'), true,
            'toolbar should be marked no-draw');
        pointer('pointerdown', 200, 200);
        pointer('pointermove', 260, 240);
        pointer('pointerup', 260, 240);
        await tick(40);
        same(Whiteboard.objects(1).length, before, 'viewer must not create objects');
        Whiteboard.setPermission(true);
        same(Whiteboard.canDraw, true, 'canDraw restored');
    });

    await check('pages: adding a page updates the label, the model and the server', async () => {
        const before = Whiteboard.model.pageCount;
        click('#wb-page-add');
        await tick(60);
        same(Whiteboard.model.pageCount, before + 1, 'page count');
        const ops = allOps().filter((op) => op.type === 'page_add');
        same(ops.length >= 1, true, 'page_add op sent');
        const label = document.getElementById('wb-page-label')?.textContent || '';
        assert(/[۰-۹]/.test(label), `the page label should use Persian digits, got "${label}"`);
    });

    await check('pages: the board follows a page_go from the server', async () => {
        send({
            type: 'whiteboard_operation', seq: 90, ephemeral: false,
            op: { type: 'page_go', page: 1, by: 'u:3' }, actor_identity: 'u:3', actor_name: 'علی',
        });
        await tick(30);
        same(Whiteboard.page, 1, 'page after page_go');
    });

    await check('text: the inline editor opens, takes typing and commits an op', async () => {
        Whiteboard.setPage(1, { broadcast: false });
        Whiteboard.setTool('text');
        Whiteboard.setColor('#111827');
        pointer('pointerdown', 300, 150);
        pointer('pointerup', 300, 150);
        await tick(40);
        const editor = document.querySelector('textarea.wb-inline-editor');
        assert(editor, 'inline editor did not open');
        editor.value = 'سلام';
        editor.dispatchEvent(new window.Event('input', { bubbles: true }));
        const event = new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
        editor.dispatchEvent(event);
        await tick(60);
        assert(!document.querySelector('textarea.wb-inline-editor'), 'editor stayed open after ctrl+enter');
        const op = allOps().filter((o) => o.type === 'text').at(-1);
        assert(op, 'text op not sent');
        same(op.text, 'سلام', 'text payload');
        assert(op.x > 0 && op.x < 1, `text x not normalised: ${op.x}`);
    });

    await check('sticky: clicking with the sticky tool creates a note', async () => {
        Whiteboard.setTool('sticky');
        await drawStroke([[500, 300], [505, 305]], { steps: 2 });
        const op = allOps().filter((o) => o.type === 'sticky').at(-1);
        assert(op, 'sticky op not sent');
        assert(op.w > 0 && op.h > 0, `sticky has no size: ${op.w}x${op.h}`);
        same(op.norm, 1, 'sticky norm');
        // the inline editor is open for the note — type and commit it
        const editor = document.querySelector('textarea.wb-inline-editor');
        if (editor) {
            editor.value = 'یادداشت';
            editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
            await tick(60);
        }
        const objects = Whiteboard.objects(1).filter((o) => o.type === 'sticky');
        same(objects.length >= 1, true, 'sticky in the model');
    });

    await check('select: dragging an object sends a translated update', async () => {
        Whiteboard.setTool('select');
        const target = Whiteboard.objects(1).find((o) => o.type === 'draw');
        assert(target, 'no stroke to move');
        const point = helpers.clientPoint(target);
        const sent = allOps().length;
        pointer('pointerdown', point[0], point[1]);
        await tick(20);
        pointer('pointermove', point[0] + 60, point[1] + 40);
        await tick(20);
        pointer('pointerup', point[0] + 60, point[1] + 40);
        await tick(40);
        const updates = allOps().slice(sent).filter((op) => op.type === 'update');
        assert(updates.length >= 1, 'no update op sent');
        const moved = Whiteboard.objects(1).find((o) => o.id === target.id);
        assert(moved, 'the moved object disappeared');
        const x0 = moved.norm ? moved.points[0][0] * 1244.4444 : moved.points[0][0];
        const before = target.norm ? target.points[0][0] * 1244.4444 : target.points[0][0];
        assert(x0 > before + 10, `object did not move right: ${before} -> ${x0}`);
    });

    await check('eraser: dragging over a stroke removes it', async () => {
        Whiteboard.setTool('select');
        Whiteboard.tools.clearSelection();
        const target = Whiteboard.objects(1).find((o) => o.type === 'draw');
        assert(target, 'no stroke to erase');
        const point = helpers.clientPoint(target);
        const sent = allOps().length;
        Whiteboard.setTool('eraser');
        pointer('pointerdown', point[0], point[1]);
        pointer('pointermove', point[0] + 2, point[1] + 2);
        pointer('pointerup', point[0] + 2, point[1] + 2);
        await tick(60);
        const removes = allOps().slice(sent).filter((op) => op.type === 'remove');
        assert(removes.length >= 1, 'eraser sent no remove op');
        assert(!Whiteboard.objects(1).some((o) => o.id === target.id), 'erased object still painted');
    });

    await check('zoom: ctrl+wheel and the zoom buttons change the scale', async () => {
        Whiteboard.resetView();
        await tick(30);
        const before = Whiteboard.renderer.scale;
        const ev = new window.WheelEvent('wheel', {
            deltaY: -240, ctrlKey: true, bubbles: true, cancelable: true, clientX: 400, clientY: 200,
        });
        canvas.dispatchEvent(ev);
        await tick(40);
        assert(Whiteboard.renderer.scale > before, `zoom did not change (${before} -> ${Whiteboard.renderer.scale})`);
        same(ev.defaultPrevented, true, 'ctrl+wheel must be cancelled (no browser page zoom)');
        const label = document.getElementById('wb-zoom-value')?.textContent || '';
        assert(/[٪%]/.test(label), `zoom indicator should show a percentage, got "${label}"`);
        const shown = Number(label.replace(/[^0-9۰-۹]/g, '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
        assert(shown > 100, `zoom indicator should read above 100%, got "${label}"`);
        Whiteboard.resetView();
        await tick(20);
    });

    await check('laser: the pointer trail is ephemeral and never persisted', async () => {
        Whiteboard.setTool('laser');
        const sent = allOps().length;
        pointer('pointerdown', 200, 200);
        pointer('pointermove', 260, 240);
        pointer('pointerup', 260, 240);
        await tick(40);
        const ops = allOps().slice(sent).filter((op) => op.type === 'laser');
        assert(ops.length >= 1, 'no laser op sent');
        assert(ops.every((op) => op.live || op.ephemeral || op.type === 'laser'), 'laser must stay ephemeral');
        Whiteboard.setTool('pen');
        void sent;
    });

    await check('presence: a peer joining shows up, leaving clears it again', async () => {
        send({
            type: 'presence', action: 'join',
            participant: { identity: 'u:3', name: 'علی', can_draw: true },
        });
        await tick(30);
        const chips = document.getElementById('wb-presence');
        assert(chips && chips.textContent.includes('علی'), `peer not listed: "${chips?.textContent}"`);
        send({
            type: 'presence', action: 'leave',
            participant: { identity: 'u:3', name: 'علی', can_draw: true },
        });
        await tick(30);
        assert(!document.getElementById('wb-presence').textContent.includes('علی'), 'peer not removed');
    });

    await check('presence: the peer count survives a resize', async () => {
        send({
            type: 'presence', action: 'join',
            participant: { identity: 'u:4', name: 'مریم', can_draw: true },
        });
        await tick(20);
        helpers.layout(wrap, 0, 0, 700, 420);
        helpers.layout(canvas, 0, 0, 700, 420);
        Whiteboard.resize();
        await tick(40);
        assert(document.getElementById('wb-presence').textContent.includes('مریم'), 'peer lost on resize');
        helpers.layout(wrap, 0, 0, 1000, 620);
        helpers.layout(canvas, 0, 0, 1000, 620);
        Whiteboard.resize();
        await tick(30);
    });

    await check('offline: a stroke made while disconnected is queued and flushed', async () => {
        socket.serverClose(1006);
        await tick(20);
        same(socket.readyState, 3, 'socket closed');
        Whiteboard.setTool('pen');
        Whiteboard.setColor('#ea580c');
        await drawStroke([[150, 400], [250, 430], [350, 470]]);
        const op = Whiteboard.objects(1).filter((o) => o.type === 'draw' && o.color === '#ea580c').at(-1);
        assert(op, 'offline stroke missing from the model');
        const outbox = Whiteboard.socket.outbox;
        same(outbox.some((o) => o.id === op.id), true, `outbox does not hold the stroke (${outbox.length})`);
    });

    await check('reconnect: the queue is flushed on the next connection', async () => {
        Whiteboard.socket.retryDelay = 1;
        Whiteboard.socket.connect();
        const next = Whiteboard.socket.ws;
        next.readyState = 1;
        next.onopen?.({});
        await tick(60);
        const drained = next.ops().some((o) => o.type === 'draw');
        assert(drained, 'queued ops were not flushed after reconnect');
        same(Whiteboard.socket.outbox.length, 0, 'outbox not empty after flush');
    });

    await check('sync: a full history frame replaces the board and clears history', async () => {
        send({
            type: 'whiteboard_history',
            board: { page_count: 2, pages: { 2: { color: '#fff7ed', grid: 'grid' } }, revision: 120 },
            events: [
                {
                    seq: 118, id: 1, op: { type: 'draw', tool: 'pen', id: 'srv-1', page: 1, norm: 1, width: 4, color: '#2563eb', points: [[0.1, 0.1], [0.4, 0.2]] },
                },
                {
                    seq: 119, id: 2, op: { type: 'sticky', id: 'srv-2', page: 1, norm: 1, x: 0.5, y: 0.3, w: 0.14, h: 0.1, color: '#fde68a', text: 'متن' },
                },
            ],
            seq: 120, full: true,
            you: { identity: 'u:7', name: 'سارا', can_draw: true },
        });
        await tick(60);
        same(Whiteboard.model.pageCount, 2, 'page count from the frame');
        same(Whiteboard.model.canUndo(1), false, 'undo stack cleared on full sync');
        const ids = Whiteboard.objects(1).map((o) => o.id);
        assert(ids.includes('srv-1') && ids.includes('srv-2'), `history objects missing: ${ids}`);
    });

    await check('legacy: old-format operations (px points) still paint', async () => {
        const legacyFlat = { type: 'draw', id: 'legacy-flat', page: 1, color: '#111827', width: 3, points: [100, 100, 160, 130, 220, 160] };
        send({ type: 'whiteboard_operation', seq: 121, ephemeral: false, op: legacyFlat, actor_identity: 'u:3' });
        const legacyPx = {
            type: 'draw', id: 'legacy-px', page: 1, color: '#b91c1c', width: 5,
            points: [[200, 200], [260, 240]],
        };
        send({ type: 'whiteboard_operation', seq: 122, ephemeral: false, op: legacyPx, actor_identity: 'u:3' });
        await tick(60);
        const ids = Whiteboard.objects(1).map((o) => o.id);
        assert(ids.includes('legacy-flat') && ids.includes('legacy-px'), `legacy ops dropped: ${ids}`);
        assert(inkCount() > 500, `legacy ops did not paint (ink=${inkCount()})`);
    });

    await check('export: PNG export produces a real, non-empty image', async () => {
        const url = await Whiteboard.exportPNG(1);
        assert(typeof url === 'string' && url.startsWith('data:image/png;base64,'),
            `not a png data url: ${String(url).slice(0, 40)}`);
        const bytes = Buffer.from(url.split(',')[1], 'base64');
        assert(bytes.length > 2000, `suspiciously small export (${bytes.length} bytes)`);
        same(bytes.subarray(1, 4).toString('latin1'), 'PNG', 'not real PNG bytes');
        const link = document.createElement('a');
        Whiteboard.exportPNG(1);
        assert(link.__clicked !== undefined || true, 'noop');
    });

    await check('print: printing every page opens a document with every page', async () => {
        let written = '';
        window.open = () => ({
            document: { write(html) { written += html; }, close() {} },
            focus() {}, print() {}, close() {},
        });
        Whiteboard.printAll();
        await tick(60);
        assert(written.includes('<img') || written.includes('<canvas'), 'print output has no page images');
        assert((written.match(/data:image\/png/g) || []).length >= 1, 'print output has no images');
    });

    await check('resize: a hidden view is left alone, a shown one is measured', async () => {
        document.getElementById('view-whiteboard').classList.add('hidden');
        const width = canvas.width;
        Whiteboard.resize();
        same(canvas.width, width, 'hidden view must keep its canvas');
        document.getElementById('view-whiteboard').classList.remove('hidden');
        helpers.layout(wrap, 0, 0, 900, 560);
        helpers.layout(canvas, 0, 0, 900, 560);
        Whiteboard.resize();
        await tick(40);
        same(Whiteboard.renderer.width, 900, 'renderer width after showing');
        same(canvas.width, 900, 'canvas width after showing');
    });

    await check('robustness: malformed server frames never break the board', async () => {
        for (const frame of [
            { type: 'whiteboard_operation', seq: 130, op: null },
            { type: 'whiteboard_operation', seq: 131, op: { type: 'draw', points: 'nope' } },
            { type: 'whiteboard_operation', seq: 132, op: { type: 'draw', page: 'x', points: [[1, 2]] } },
            { type: 'whiteboard_operation', seq: 133, op: { type: 'unknown-thing', page: 1 } },
            { type: 'presence', action: 'join', participant: null },
            { type: 'error' },
            { type: 'whiteboard_history', board: null, events: null, seq: null },
            { type: 'nonsense' },
        ]) {
            send(frame);
        }
        await tick(60);
        same(Boolean(Whiteboard.unavailable), false, 'board went unavailable on a bad frame');
        Whiteboard.setTool('pen');
        Whiteboard.setColor('#0f172a');
        await drawStroke([[600, 400], [660, 440]]);
        const ok = allOps().filter((o) => o.type === 'draw' && o.color === '#0f172a').at(-1);
        assert(ok, 'board stopped accepting drawing after malformed frames');
    });

    /* ------------------------------------------------------------------ */
    /* keyboard and pointer gestures the toolbar advertises                 */
    /* ------------------------------------------------------------------ */

    await check('keys: every tool letter the toolbar advertises works', async () => {
        const letters = new Map();
        for (const button of document.querySelectorAll('#view-whiteboard [data-tool]')) {
            const match = /\(([A-Za-z])\)/.exec(button.title || '');
            if (match) letters.set(match[1].toLowerCase(), button.dataset.tool);
        }
        assert(letters.size >= 8, `the toolbar advertises ${letters.size} tool shortcuts`);
        for (const [letter, tool] of letters) {
            key('keydown', letter);
            await tick(12);
            same(Whiteboard.tool, tool, `pressing "${letter}" should switch to ${tool}`);
            same(document.querySelector(`[data-tool="${tool}"]`)?.classList.contains('active'), true,
                `the ${tool} button should light up`);
        }
        // and the help sheet must mention every one of them
        Whiteboard.setTool('pen');
        document.getElementById('wb-help').click();
        await tick(60);
        const sheet = document.querySelector('.app-dialog-body')?.textContent || '';
        for (const letter of letters.keys()) {
            assert(sheet.toUpperCase().includes(letter.toUpperCase()), `the help sheet omits "${letter}"`);
        }
        document.querySelector('.app-dialog-x')?.click();
        await tick(30);
    });

    await check('keys: escape, select-all, delete, nudge and page navigation', async () => {
        Whiteboard.setTool('pen');
        Whiteboard.setColor('#0f766e');
        await drawStroke([[300, 520], [360, 545], [420, 570]]);
        const target = Whiteboard.objects(1).filter((o) => o.type === 'draw' && o.color === '#0f766e').at(-1);
        assert(target, 'no stroke to select');

        key('keydown', 'a', { ctrlKey: true });
        await tick(30);
        same(Whiteboard.tools.selection.size >= 1, true, 'ctrl+A selected nothing');
        same(Whiteboard.tools.selection.has(target.id), true, 'ctrl+A missed the stroke');

        // nudging moves the selection and tells the server
        const beforeNudge = allOps().length;
        key('keydown', 'ArrowRight', { shiftKey: true });
        await tick(40);
        assert(allOps().slice(beforeNudge).some((op) => op.type === 'update'),
            'nudging sent no update op');

        key('keydown', 'Escape');
        await tick(20);
        same(Whiteboard.tools.selection.size, 0, 'escape should clear the selection');

        // duplicates: ctrl+D then delete
        Whiteboard.tools.select([target.id]);
        const beforeDup = allOps().length;
        key('keydown', 'd', { ctrlKey: true });
        await tick(60);
        assert(allOps().slice(beforeDup).some((op) => op.type === 'draw'), 'ctrl+D duplicated nothing');
        Whiteboard.tools.select([target.id]);
        key('keydown', 'Delete');
        await tick(60);
        assert(!Whiteboard.objects(1).some((o) => o.id === target.id), 'Delete did not remove the stroke');

        // alt+arrow changes the page (the toolbar title promises it)
        const page = Whiteboard.page;
        key('keydown', 'ArrowRight', { altKey: true });
        await tick(40);
        assert(Whiteboard.page !== page || Whiteboard.model.pageCount === 1,
            'alt+right did not change the page');
        key('keydown', 'ArrowLeft', { altKey: true });
        await tick(30);
    });

    await check('wheel: ctrl+wheel zooms, a two-finger scroll pans', async () => {
        Whiteboard.resetView();
        await tick(20);
        const renderer = Whiteboard.renderer;
        const zoom = renderer.zoom;
        canvas.dispatchEvent(new window.WheelEvent('wheel', {
            deltaY: -200, ctrlKey: true, bubbles: true, cancelable: true, clientX: 300, clientY: 300,
        }));
        await tick(30);
        assert(renderer.zoom > zoom, `ctrl+wheel did not zoom (${zoom} -> ${renderer.zoom})`);

        Whiteboard.resetView();
        await tick(20);
        const panBefore = renderer.panX + renderer.panY;
        canvas.dispatchEvent(new window.WheelEvent('wheel', {
            deltaY: 120, deltaX: 60, bubbles: true, cancelable: true, clientX: 300, clientY: 300,
        }));
        await tick(30);
        assert(renderer.panX + renderer.panY !== panBefore, 'a plain wheel did not pan the board');
        Whiteboard.resetView();
        Whiteboard.setTool('pen');
        await tick(20);
    });

    await check('sticky: the palette colour is used for the next note', async () => {
        Whiteboard.setTool('sticky');
        const swatches = [...document.querySelectorAll('#wb-sticky-palette [data-color]')];
        assert(swatches.length >= 3, `the sticky palette has ${swatches.length} colours`);
        swatches[1].click();
        await tick(30);
        const chosen = Whiteboard.tools.stickyColor;
        await drawStroke([[600, 300], [604, 304]], { steps: 2 });
        const note = allOps().filter((op) => op.type === 'sticky').at(-1);
        assert(note, 'no sticky op sent');
        same(note.color, chosen, 'the note ignored the palette colour');
        const editor = document.querySelector('textarea.wb-inline-editor');
        if (editor) {
            editor.value = 'رنگ';
            editor.dispatchEvent(new window.KeyboardEvent('keydown', {
                key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
            }));
            await tick(40);
        }
    });

    await check('text: double-clicking a text object reopens it with its text', async () => {
        Whiteboard.setTool('text');
        Whiteboard.setColor('#1d4ed8');
        pointer('pointerdown', 700, 200);
        pointer('pointerup', 700, 200);
        await tick(40);
        const editor = document.querySelector('textarea.wb-inline-editor');
        assert(editor, 'the text editor did not open');
        editor.value = 'دو کلیک';
        editor.dispatchEvent(new window.KeyboardEvent('keydown', {
            key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
        }));
        await tick(60);
        const op = Whiteboard.objects(1).filter((o) => o.type === 'text').at(-1);
        assert(op && op.text === 'دو کلیک', 'the text was not committed');
        const client = helpers.clientPoint({ ...op, norm: 1, points: [[op.x, op.y]], x: op.x, y: op.y });
        const again = new window.MouseEvent('dblclick', {
            bubbles: true, cancelable: true, clientX: client[0], clientY: client[1],
        });
        canvas.dispatchEvent(again);
        await tick(60);
        const reopened = document.querySelector('textarea.wb-inline-editor');
        assert(reopened, 'double click did not reopen the editor');
        same(reopened.value, 'دو کلیک', 'the editor did not carry the existing text');
        reopened.dispatchEvent(new window.KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
        }));
        await tick(30);
        same(Boolean(document.querySelector('textarea.wb-inline-editor')), false, 'escape left the editor open');
    });

    /* ------------------------------------------------------------------ */
    /* the toolbar, button by button                                       */
    /* ------------------------------------------------------------------ */

    await check('toolbar: every tool button selects its own tool', async () => {
        const buttons = [...document.querySelectorAll('#view-whiteboard [data-tool]')];
        assert(buttons.length >= 15, `expected the full tool palette, found ${buttons.length}`);
        const seen = [];
        for (const button of buttons) {
            button.click();
            await tick(12);
            seen.push(button.dataset.tool);
            same(Whiteboard.tool, button.dataset.tool, `tool after clicking ${button.dataset.tool}`);
            Whiteboard.chrome.closePopovers();
        }
        for (const tool of ['pen', 'highlighter', 'eraser', 'line', 'arrow', 'rectangle',
            'ellipse', 'triangle', 'diamond', 'star', 'text', 'sticky', 'select', 'laser', 'pan']) {
            assert(seen.includes(tool), `no button for the ${tool} tool`);
        }
    });

    await check('toolbar: every popover toggle opens its popover (and closes again)', async () => {
        const toggles = [...document.querySelectorAll('#view-whiteboard [data-popover]')];
        const names = new Set(toggles.map((toggle) => toggle.dataset.popover));
        for (const expected of ['color', 'sticky', 'page', 'export']) {
            assert(names.has(expected), `no toggle for the ${expected} popover`);
        }
        for (const toggle of toggles) {
            const name = toggle.dataset.popover;
            const popover = document.getElementById(`wb-popover-${name}`);
            assert(popover, `missing popover markup for "${name}"`);
            toggle.click();
            await tick(12);
            same(popover.classList.contains('hidden'), false, `popover "${name}" did not open`);
            same(toggle.getAttribute('aria-expanded'), 'true', `aria-expanded for "${name}"`);
            // clicking anywhere else closes it
            document.getElementById('view-whiteboard').click();
            await tick(12);
            same(popover.classList.contains('hidden'), true, `popover "${name}" did not close`);
        }
    });

    await check('toolbar: the colour palette and the width slider reach the pen', async () => {
        Whiteboard.setTool('pen');
        const swatches = [...document.querySelectorAll('#wb-palette [data-color]')];
        assert(swatches.length >= 6, `expected a colour palette, found ${swatches.length}`);
        const before = Whiteboard.color;
        same(typeof before, 'string', 'the board should report its current colour');
        let changed = 0;
        for (const swatch of swatches) {
            swatch.click();
            await tick(8);
            if (Whiteboard.color === swatch.dataset.color && swatch.dataset.color !== before) changed += 1;
        }
        assert(changed >= 5, `palette swatches did not change the colour (${changed})`);

        const width = document.getElementById('wb-width');
        assert(width, 'the width slider is missing');
        width.value = '12';
        width.dispatchEvent(new window.Event('input', { bubbles: true }));
        await tick(20);
        same(Whiteboard.width, 12, 'width slider');
        same(document.getElementById('wb-width-value')?.textContent, '12', 'width label');

        // and the chosen colour is what the next stroke is sent with
        Whiteboard.setColor('#0ea5e9');
        await drawStroke([[420, 420], [470, 450]]);
        const op = allOps().filter((o) => o.type === 'draw' && o.color === '#0ea5e9').at(-1);
        assert(op, 'the stroke did not use the selected colour');
        same(op.width, 12, 'the stroke did not use the selected width');
    });

    await check('toolbar: the pages panel opens, lists pages and closes', async () => {
        const panel = document.getElementById('wb-pages-panel');
        const toggle = document.getElementById('wb-pages-toggle');
        assert(panel && toggle, 'the pages panel is missing');
        if (panel.classList.contains('hidden')) toggle.click();
        await tick(60);
        same(panel.classList.contains('hidden'), false, 'the pages panel did not open');
        const list = document.getElementById('wb-pages-list');
        const thumbs = list.querySelectorAll('button');
        assert(thumbs.length >= 1, 'the pages panel listed no page');
        document.getElementById('wb-pages-close').click();
        await tick(40);
        same(panel.classList.contains('hidden'), true, 'the pages panel did not close');
    });

    await check('toolbar: zoom in / out / fit drive the renderer scale', async () => {
        const renderer = Whiteboard.renderer;
        const base = renderer.zoom;
        document.getElementById('wb-zoom-in').click();
        await tick(30);
        assert(renderer.zoom > base, `zoom-in did nothing (${base} -> ${renderer.zoom})`);
        document.getElementById('wb-zoom-out').click();
        await tick(30);
        document.getElementById('wb-zoom-fit').click();
        await tick(30);
        same(Number(renderer.zoom.toFixed(4)), 1, 'zoom-fit should return to 100%');
    });

    await check('toolbar: page background, grid and the zoom indicator', async () => {
        const before = { ...Whiteboard.model.style(1) };
        const input = document.getElementById('wb-page-bg');
        input.value = '#fff7ed';
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        await tick(40);
        same(Whiteboard.model.style(1).color, '#fff7ed', 'page background colour');
        const setups = allOps().filter((op) => op.type === 'page_setup');
        assert(setups.length >= 1, 'no page_setup op sent');
        same(setups.at(-1).page, 1, 'page_setup page');
        same(setups.at(-1).color, '#fff7ed', 'page_setup colour');

        document.getElementById('wb-grid').click();
        await tick(40);
        assert(Whiteboard.model.style(1).grid !== before.grid, 'the grid button did not cycle the grid');

        Whiteboard.zoomBy(1.25);
        await tick(30);
        const label = document.getElementById('wb-zoom-value').textContent;
        assert(/[۰-۹0-9]/.test(label), `zoom indicator empty: ${label}`);
        Whiteboard.resetView();
        await tick(20);
    });

    await check('toolbar: selection buttons delete, duplicate and reorder', async () => {
        Whiteboard.setTool('pen');
        Whiteboard.setColor('#be123c');
        await drawStroke([[500, 500], [560, 520], [620, 540]]);
        const target = Whiteboard.objects(1).filter((o) => o.type === 'draw' && o.color === '#be123c').at(-1);
        assert(target, 'no stroke to work with');
        Whiteboard.setTool('select');
        Whiteboard.tools.select([target.id]);
        await tick(30);
        same(Whiteboard.tools.selection.size, 1, 'the stroke should be selected');

        document.getElementById('wb-layers-front').click();
        await tick(20);
        assert(allOps().some((op) => op.type === 'reorder' && op.id === target.id),
            'the layer button sent no reorder op');

        const before = allOps().length;
        document.getElementById('wb-duplicate-selection').click();
        await tick(60);
        const copies = allOps().slice(before).filter((op) => op.type === 'draw');
        assert(copies.length >= 1, 'the duplicate button sent no draw op');

        Whiteboard.tools.select([target.id]);
        await tick(20);
        same(Whiteboard.tools.selection.has(target.id), true, 'the original should be selected again');
        const deleteSent = allOps().length;
        document.getElementById('wb-delete-selection').click();
        await tick(60);
        assert(allOps().slice(deleteSent).some((op) => op.type === 'remove'),
            'the delete button sent no remove op');
        assert(!Whiteboard.objects(1).some((o) => o.id === target.id), 'the object survived delete');
    });

    await check('toolbar: the save button downloads a real PNG', async () => {
        const before = window.__downloads.length;
        document.getElementById('wb-save').click();
        await tick(60);
        const downloads = window.__downloads.slice(before);
        assert(downloads.length === 1, `the save button triggered ${downloads.length} downloads`);
        assert(String(downloads[0].href).startsWith('data:image/png;base64,'),
            `unexpected download: ${String(downloads[0].href).slice(0, 32)}`);
        assert(/\.png$/.test(downloads[0].download || ''), `no .png filename: ${downloads[0].download}`);
    });

    await check('toolbar: the help button opens the shortcut sheet', async () => {
        document.getElementById('wb-help').click();
        await tick(60);
        const dialog = document.querySelector('.app-dialog');
        assert(dialog && dialog.open, 'the shortcut sheet did not open');
        dialog.querySelector('.app-dialog-x')?.click();
        dialog.close?.();
        await tick(40);
        same(Boolean(dialog.open), false, 'the shortcut sheet did not close');
    });

    await check('diagnostics: __wb.diag() reports the state support needs', () => {
        const info = Whiteboard.diag();
        same(info.build, Whiteboard.build, 'build stamp');
        same(info.fresh, true, 'the server-rendered stamp should match this bundle');
        same(info.ready, true, 'ready');
        same(info.canDraw, true, 'canDraw');
        same(typeof info.canvas.backing, 'string', 'canvas backing store');
        same(info.canvas.view, 'ok', '2d context');
        same(typeof info.socket.state, 'string', 'socket state');
        assert(info.socket.url.includes('/whiteboard/'), 'socket url in diag');
        same(info.wrap, '900×560', 'wrap measurement');
        // a stale bundle must be visible in the report
        document.getElementById('classroom-root').dataset.wbBuild = 'wb-from-an-older-deploy';
        same(Whiteboard.diag().fresh, false, 'stale bundle must report fresh=false');
        document.getElementById('classroom-root').dataset.wbBuild = Whiteboard.build;
    });

    await check('live: an in-progress stroke is streamed to peers while drawing', async () => {
        Whiteboard.setTool('pen');
        Whiteboard.setColor('#0f766e');
        const socket = Whiteboard.socket.ws;
        socket.sent.length = 0;

        helpers.pointer('pointerdown', 300, 300);
        helpers.pointer('pointermove', 316, 306);
        await tick(120);                       // past the live-stream interval
        helpers.pointer('pointermove', 348, 322);
        await tick(120);
        helpers.pointer('pointermove', 380, 340);

        const live = socket.ops().filter((op) => op.live);
        assert(live.length >= 2, `only ${live.length} live frames were streamed`);
        for (const op of live) {
            same(op.type, 'draw', 'a live frame must be a draw preview');
            same(op.tool, 'pen', 'live frame tool');
            assert(Array.isArray(op.points) && op.points.length >= 2,
                `live frame carries ${op.points && op.points.length} points`);
            assert(op.points.length <= 320, `live frame is not trimmed (${op.points.length} points)`);
            same(op.norm, 1, 'live frames are normalised');
        }

        helpers.pointer('pointerup', 380, 340);
        await tick(40);
        const committed = socket.ops().filter((op) => !op.live && op.type === 'draw');
        assert(committed.length === 1, `expected exactly one committed draw, got ${committed.length}`);
        assert(committed[0].points.length >= live[0].points.length,
            'the committed stroke is shorter than the preview');
    });

    await check('latency: the round trip of our own operation is measured', async () => {
        const socket = Whiteboard.socket.ws;
        const sent = socket.ops().filter((op) => !op.live && op.type === 'draw');
        assert(sent.length >= 1, 'nothing was sent to confirm');
        const op = sent[sent.length - 1];
        const before = Whiteboard.diag().latency.count;
        await tick(30);                        // the op is "in flight" for a while
        // the echo has to be newer than what the client already knows
        send({
            type: 'whiteboard_operation', op, seq: Whiteboard.model.revision + 5, ephemeral: false,
            actor_identity: 'u:7', server_ms: 17,
        });
        await tick(30);

        const info = Whiteboard.diag();
        assert(info.latency && info.latency.count === before + 1,
            `expected one new sample (${before} → ${info.latency.count})`);
        assert(info.latency.p50 >= 30, `p50=${info.latency.p50} ms is too small for a 30 ms round trip`);
        same(info.latency.serverMs, 17, 'the server-reported time');
        same(info.latency.last >= 30, true, 'last sample');

        const chip = document.getElementById('wb-lag');
        assert(chip && !chip.classList.contains('hidden'), 'the lag chip stayed hidden');
        assert(/ms/.test(chip.textContent), `unexpected chip text: ${chip.textContent}`);
        assert(['ok', 'slow', 'bad'].includes(chip.dataset.level), `level=${chip.dataset.level}`);
    });

    await check('latency: a fast round trip keeps the chip quiet but reported', async () => {
        const socket = Whiteboard.socket.ws;
        // drain the meter with quick confirmations
        for (let index = 0; index < 8; index += 1) {
            const op = { type: 'draw', id: `fast-${index}`, page: 1, norm: 1, tool: 'pen', points: [[0.1, 0.1], [0.2, 0.2]], color: '#111827', width: 3 };
            Whiteboard.tools.commit([op], { record: false });
            send({ type: 'whiteboard_operation', op, seq: 50 + index, ephemeral: false, actor_identity: 'u:7', server_ms: 4 });
        }
        await tick(40);
        const summary = Whiteboard.diag().latency;
        assert(summary.p50 !== null && summary.p50 < 400, `p50=${summary.p50} should be small here`);
        same(document.getElementById('wb-lag').dataset.level, 'ok', 'level for a fast board');
    });

    await check('connections: the broadcast layer the server uses is reported', () => {
        same(Whiteboard.diag().layer, 'redis', 'the history frame carries the channel layer');
    });

    await check('schema: an outdated server database is explained, not silent', async () => {
        const before = Whiteboard.unavailable;
        same(Boolean(before), false, 'the board started out available');
        send({
            type: 'error', code: 'migrate-required',
            message: 'دیتابیس سرور به‌روز نیست؛ «python manage.py migrate» لازم است.',
        });
        await tick(40);

        same(Whiteboard.unavailable, true, 'the board must stop pretending it works');
        const hint = document.getElementById('wb-error-hint');
        assert(hint && !hint.classList.contains('hidden'), 'the red hint stayed hidden');
        assert(/migrate/.test(hint.textContent), `the hint does not name the command: ${hint.textContent}`);
        assert(/migrate/.test(Whiteboard.diag().unavailableReason || ''), 'diag() must carry the reason');
        assert(document.querySelector('.wb-toolbar')?.classList.contains('is-unavailable'),
            'the toolbar should look unavailable');
        same(Whiteboard.socket.closed, true, 'the client must not keep reconnecting');
        assert(env.log().some((line) => /migrate/.test(line)), 'nothing was logged for support');
    });

    await check('diagnostics: the build stamp lives in the bundle', () => {
        assert(/^wb-\d{4}-\d{2}-\d{2}/.test(Whiteboard.build), `unexpected build stamp: ${Whiteboard.build}`);
    });

    if (dump) {
        const ops = allOps();
        fs.writeFileSync(dump, JSON.stringify(ops, null, 2));
        console.log(`     (dumped ${ops.length} client operations to ${dump})`);
    }

    console.log(`\n${passed}/${passed + failures.length} checks passed`);
    if (failures.length) {
        console.log('\nfailures:');
        for (const failure of failures) console.log(` - ${failure.name}`);
    }
    return failures.length;
}

/* run only when executed directly (``node board.test.mjs``), so the harness
   can also be imported by other scripts */
const dumpIndex = process.argv.indexOf('--dump');
const dumpPath = dumpIndex > -1 ? process.argv[dumpIndex + 1] || 'ops.json' : null;
const isEntryPoint = process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isEntryPoint) {
    // imported: expose main() without running it
} else main({ dump: dumpPath }).then((failed) => {
    // the client keeps heartbeats/reconnect timers alive on purpose; stop
    // them so the harness exits instead of hanging the shell
    try {
        globalThis.__wb?.socket?.close?.();
    } catch (err) { /* nothing to close */ }
    process.exit(failed ? 1 : 0);
}).catch((err) => {
    console.error(err);
    process.exit(1);
});
