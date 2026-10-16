/**
 * offline.test.mjs — the board has to work when the classroom socket does not.
 *
 * This is the case a teacher hits most often: `runserver` is up, Redis (or the
 * whole channel layer) is not, the presence socket never opens — and the page
 * still has to open the board, draw, keep the strokes, and push them once the
 * connection comes back.  A board that only works with a healthy WebSocket
 * *is* the "whiteboard doesn't work" bug report.
 *
 * Run: node offline.test.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { boot, tick } from './browser.harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
function same(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${message || 'not equal'}\n  actual:   ${a}\n  expected: ${b}`);
}

async function main() {
    /* =============================================================== */
    /* 1. the socket never opens                                       */
    /* =============================================================== */
    const env = await boot({ canDraw: true, width: 1000, height: 620, online: false });
    const { Whiteboard, document, socket, helpers } = env;

    await check('offline: the board still initialises', () => {
        assert(Whiteboard.ready === true, 'the facade never became ready');
    });

    await check('offline: the canvas has a 2d context', () => {
        assert(Whiteboard.unavailable !== true, 'the renderer reported itself unavailable');
        assert(Whiteboard.renderer.unavailable !== true, 'no 2d context on the canvas');
    });

    await check('offline: the socket really is closed', () => {
        assert(socket.readyState !== 1, `readyState=${socket.readyState}`);
    });

    await check('offline: the status pill does not claim to be online', () => {
        const pill = document.getElementById('wb-status');
        assert(pill, 'no status pill');
        const text = (pill.textContent || '').trim();
        assert(text.length > 0, 'the status pill is empty');
        assert(pill.dataset.state !== 'online', `state=${pill.dataset.state}`);
    });

    await check('offline: drawing is not blocked by a dead socket', () => {
        assert(Whiteboard.canDraw === true, 'canDraw was downgraded to false');
        const hint = document.getElementById('wb-nodraw-hint');
        assert(!hint || hint.classList.contains('hidden'), 'the "you may not draw" hint is showing');
    });

    Whiteboard.setTool('pen');
    Whiteboard.setColor('#dc2626');
    const before = helpers.inkCount();
    await helpers.stroke([[120, 120], [240, 200], [360, 300]]);

    await check('offline: the stroke paints on this device', () => {
        assert(helpers.inkCount() > before, `ink did not grow (${before} → ${helpers.inkCount()})`);
        const box = helpers.inkBox(([r, g, b]) => r > 150 && g < 120 && b < 120);
        assert(box, 'no red ink anywhere on the canvas');
        const cx = (box.minX + box.maxX) / 2;
        assert(Math.abs(cx - 240) < 24, `red ink is centred at ${cx.toFixed(1)}, expected ~240`);
    });

    await check('offline: no op is claimed to have reached the server', () => {
        assert(socket.ops().length === 0, `${socket.ops().length} ops were "sent" on a closed socket`);
    });

    await check('offline: the op waits in the outbox', () => {
        assert(Whiteboard.model.pending.size >= 1, `pending=${Whiteboard.model.pending.size}`);
    });

    await check('offline: the model keeps the object for the local user', () => {
        assert(Whiteboard.objects(Whiteboard.page).length >= 1, 'the model lost the stroke');
    });

    await check('offline: no fatal client error', () => {
        const bad = env.log().filter((line) => /unavailable|Unhandled|TypeError|ReferenceError/i.test(line));
        assert(bad.length === 0, bad.join(' | '));
    });

    /* =============================================================== */
    /* 2. the connection comes back: the queue must flush              */
    /* =============================================================== */
    socket.open();
    await tick(80);

    await check('reconnect: the queued stroke is sent', () => {
        assert(socket.ops().length === 1, `${socket.ops().length} ops sent`);
        assert(socket.ops()[0].type === 'draw', `sent a "${socket.ops()[0].type}" op`);
    });

    await check('reconnect: the outbox is empty again', () => {
        assert(Whiteboard.socket.outbox.length === 0, `${Whiteboard.socket.outbox.length} ops stuck in the outbox`);
    });

    await check('reconnect: the local drawing survives the handshake', () => {
        assert(Whiteboard.objects(Whiteboard.page).length >= 1, 'the stroke was dropped on reconnect');
        assert(Whiteboard.model.pending.size >= 1, 'the op was never held for confirmation');
    });

    await check('reconnect: the server echo clears the pending op without duplicating it', async () => {
        const before = Whiteboard.objects(Whiteboard.page).length;
        const sent = socket.ops();
        assert(sent.length >= 1, 'nothing was sent to echo back');
        let seq = 0;
        for (const op of sent) {
            seq += 1;
            // exactly what the consumer broadcasts: the op back to its author,
            // which is how an optimistic operation turns authoritative
            env.send({ type: 'whiteboard_operation', op, seq, ephemeral: false, actor_identity: 'u:7' });
        }
        await tick(40);
        assert(Whiteboard.model.pending.size === 0, `still ${Whiteboard.model.pending.size} pending`);
        assert(Whiteboard.objects(Whiteboard.page).length === before,
            `the echoed op was applied twice (${before} → ${Whiteboard.objects(Whiteboard.page).length})`);
    });

    await check('reconnect: drawing keeps working after the flush', async () => {
        const before = socket.ops().length;
        const objects = Whiteboard.objects(Whiteboard.page).length;
        await helpers.stroke([[420, 200], [520, 260]]);
        assert(socket.ops().length > before, 'the second stroke was not sent');
        assert(Whiteboard.objects(Whiteboard.page).length === objects + 1,
            `the second stroke is not in the model (${objects} → ${Whiteboard.objects(Whiteboard.page).length})`);
    });

    /* =============================================================== */
    /* 3. a viewer without the permission stays locked, offline too    */
    /* =============================================================== */
    const guest = await boot({ canDraw: false, width: 1000, height: 620, online: false });
    await check('offline viewer: the board is read-only and says so', () => {
        assert(guest.Whiteboard.canDraw === false, 'canDraw leaked');
        const hint = guest.document.getElementById('wb-nodraw-hint');
        assert(hint && !hint.classList.contains('hidden'), 'no hint for a read-only viewer');
        const toolbar = guest.document.querySelector('.wb-toolbar');
        assert(toolbar?.classList.contains('no-draw'), 'the toolbar still looks interactive');
    });

    await check('offline viewer: a pointer gesture changes nothing', async () => {
        const before = guest.helpers.inkCount();
        await guest.helpers.stroke([[200, 200], [400, 320]]);
        assert(guest.helpers.inkCount() === before, 'a read-only viewer painted on the canvas');
        assert(guest.Whiteboard.objects(guest.Whiteboard.page).length === 0, 'the model accepted the stroke');
    });

    /* =============================================================== */
    /* 4. a single-process broadcast layer is called out, not hidden    */
    /* =============================================================== */
    // the layer is announced in the first history frame, so this one connects
    const shared = await boot({ canDraw: true, layer: 'memory' });
    await check('layer: the in-memory channel layer is reported and warned about', () => {
        same(shared.Whiteboard.diag().layer, 'memory', 'diag must report the layer');
        const warning = shared.log().find((line) => line.includes('in-memory channel layer'));
        assert(warning, `no warning was logged; log=${JSON.stringify(shared.log())}`);
        assert(/REDIS_URL/.test(warning), 'the warning must say how to fix it');
    });

    /* =============================================================== */
    /* report                                                          */
    /* =============================================================== */
    const failed = results.filter((entry) => !entry.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error('offline suite crashed:', err);
        process.exit(2);
    });
}
