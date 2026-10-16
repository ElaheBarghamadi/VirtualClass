/**
 * harness.mjs — a browser-faithful whiteboard harness for the sandbox.
 *
 * Unlike tests_js/ (which exercises the client against stubbed canvas calls),
 * this harness gives the client a *real* rasterizer: every canvas element is
 * backed by @napi-rs/canvas, pointer events run through a real event pipeline
 * inside jsdom, and the markup is lifted straight out of the Django template.
 * That lets us assert things a stubbed canvas cannot catch — pixels landing
 * where the pointer was, hi-dpi backing stores, real Path2D/roundRect calls,
 * compositing, font metrics — i.e. exactly the bugs that only appear in a real
 * browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { JSDOM, VirtualConsole } from 'jsdom';

/* the same module instances the client uses (same specifier → same import) */
export async function geometry() {
    return import(path.join(SRC, 'wb/geometry.js'));
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = process.env.WB_REPO || path.resolve(HERE, '..');
export const BUILD = path.join(HERE, '.build');
const SRC = path.join(BUILD, 'src');

/* ------------------------------------------------------------------ */
/* sources: work on a copy so the repo is never touched                */
/* ------------------------------------------------------------------ */
export function syncSources() {
    fs.mkdirSync(BUILD, { recursive: true });
    fs.rmSync(SRC, { recursive: true, force: true });
    fs.cpSync(path.join(REPO, 'static/js'), SRC, { recursive: true });
    fs.writeFileSync(path.join(SRC, 'package.json'), JSON.stringify({ type: 'module' }));
    return SRC;
}

/** Extract the whiteboard view from the Django template (div-balanced). */
function whiteboardMarkup() {
    const tpl = fs.readFileSync(path.join(REPO, 'classrooms/templates/classrooms/room.html'), 'utf8');
    const start = tpl.indexOf('id="view-whiteboard"');
    if (start < 0) throw new Error('view-whiteboard not found in the template');
    let open = tpl.lastIndexOf('<div', start);
    let depth = 0;
    let i = open;
    const tag = /<div\b|<\/div>/g;
    tag.lastIndex = open;
    let match;
    while ((match = tag.exec(tpl))) {
        depth += match[0] === '</div>' ? -1 : 1;
        i = tag.lastIndex;
        if (depth === 0) break;
    }
    const block = tpl.slice(open, i);
    return block.replace(/\{%[^%]*%\}/g, '').replace(/\{\{[^}]*\}\}/g, '');
}

/* ------------------------------------------------------------------ */
/* fake socket                                                         */
/* ------------------------------------------------------------------ */
class FakeSocket {
    static instances = [];

    constructor(url) {
        this.url = String(url);
        this.readyState = 0; // CONNECTING
        this.sent = [];
        FakeSocket.instances.push(this);
    }

    /* -- test-side controls ---------------------------------------- */
    open() {
        this.readyState = 1;
        this.onopen?.({});
    }

    serverSend(payload) {
        this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    }

    serverClose(code = 1006) {
        this.readyState = 3;
        this.onclose?.({ code, wasClean: code === 1000 });
    }

    sentOf(action) {
        return this.frames().filter((frame) => frame.action === action);
    }

    frames() {
        return this.sent.map((raw) => JSON.parse(raw));
    }

    ops() {
        const out = [];
        for (const frame of this.frames()) {
            if (frame.action === 'op' && frame.op) out.push(frame.op);
            if (frame.action === 'ops' && Array.isArray(frame.ops)) out.push(...frame.ops);
        }
        return out;
    }

    /* -- WebSocket surface ----------------------------------------- */
    send(data) {
        this.sent.push(String(data));
    }

    close(code = 1000) {
        this.readyState = 3;
        this.onclose?.({ code, wasClean: true });
    }

    addEventListener() {}
    removeEventListener() {}
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

/** jsdom's "not implemented" chatter is noise; page logs are interesting. */
/**
 * The client modules are imported by *Node*, so their ``console`` calls go to
 * the real process console, not to jsdom's virtual one.  Tee the global
 * console into an array so a suite can assert on what the client logged.
 */
const pageLog = [];

for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        pageLog.push(args.map((value) => String(value)).join(' '));
        original(...args);
    };
}

export function quietConsole() {
    const virtualConsole = new VirtualConsole();
    const logged = [];
    virtualConsole.on('jsdomError', (err) => {
        // navigation/downloads are not implemented in jsdom — ignore those,
        // but a real script error would still show up in the page log
        if (!/Not implemented/.test(String(err && err.message))) {
            logged.push(`jsdomError: ${err && err.message}`);
        }
    });
    for (const level of ['log', 'info', 'warn', 'error']) {
        virtualConsole.on(level, (...args) => logged.push(args.map(String).join(' ')));
    }
    quietConsole.logged = logged;
    return virtualConsole;
}
/* Every boot gets its own module instance: the facade is a singleton, so a
   second boot() in one process must not hand back the first environment's
   board (that silently made permission/canvas assertions read stale state). */
let bootCount = 0;

export async function boot({
    canDraw = true, dpr = 1, width = 1000, height = 620, online = true, layer = 'redis',
} = {}) {
    const instance = (bootCount += 1);
    syncSources();
    const dom = new JSDOM(
        `<!doctype html><html><body>
            <div id="classroom-root" data-participant-name="سارا" data-wb-build="__BUILD__">
                <div class="stage" id="stage">
                    ${whiteboardMarkup()}
                </div>
            </div>
        </body></html>`,
        {
            url: 'https://class.example.test/room/ABCDE/',
            pretendToBeVisual: true,
            virtualConsole: quietConsole(),
        },
    );
    const { window } = dom;

    /* --- real 2d contexts ---------------------------------------- */
    const backing = new WeakMap();
    const contextFor = (element) => {
        const w = Math.max(1, element.width || 300);
        const h = Math.max(1, element.height || 150);
        let entry = backing.get(element);
        if (!entry) {
            const canvas = createCanvas(w, h);
            entry = { canvas, ctx: canvas.getContext('2d') };
            backing.set(element, entry);
        }
        if (entry.canvas.width !== w) entry.canvas.width = w;
        if (entry.canvas.height !== h) entry.canvas.height = h;
        return entry.ctx;
    };
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        writable: true,
        value(type) { return type === '2d' ? contextFor(this) : null; },
    });
    /* a real browser reallocates (and clears) the backing store the moment
       width/height are assigned; do the same or later getContext() clears the
       frame the client just drew */
    for (const prop of ['width', 'height']) {
        const descriptor = Object.getOwnPropertyDescriptor(window.HTMLCanvasElement.prototype, prop);
        Object.defineProperty(window.HTMLCanvasElement.prototype, prop, {
            configurable: true,
            get() { return descriptor.get.call(this); },
            set(value) {
                descriptor.set.call(this, value);
                const entry = backing.get(this);
                if (entry) {
                    const next = Math.max(1, Math.round(Number(this[prop]) || 1));
                    if (entry.canvas[prop] !== next) entry.canvas[prop] = next;
                }
            },
        });
    }
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'toDataURL', {
        configurable: true,
        writable: true,
        value() { return backing.get(this)?.canvas.toDataURL('image/png') || 'data:,'; },
    });
    /* drawImage() must unwrap jsdom canvas elements to their real canvas */
    const nativeProto = Object.getPrototypeOf(createCanvas(4, 4).getContext('2d'));
    const nativeDrawImage = nativeProto.drawImage;
    nativeProto.drawImage = function drawImage(source, ...rest) {
        const entry = source && source.nodeName === 'CANVAS' ? backing.get(source) : null;
        return nativeDrawImage.call(this, entry ? entry.canvas : source, ...rest);
    };

    /* --- layout: real, non-zero boxes ---------------------------- */
    let boxes = new Map();
    window.Element.prototype.getBoundingClientRect = function rect() {
        const box = boxes.get(this);
        if (box) return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height };
        return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    };
    const layout = (el, left, top, w, h) => boxes.set(el, { left, top, width: w, height: h });
    Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get() { return this.classList.contains('hidden') ? null : (this.parentElement || null); },
    });
    window.Element.prototype.scrollIntoView = function scrollIntoView() {};
    window.devicePixelRatio = dpr;

    /* --- browser APIs jsdom lacks -------------------------------- */
    window.ResizeObserver = class ResizeObserver {
        constructor(cb) { this.cb = cb; }
        observe() {} unobserve() {} disconnect() {}
    };
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    /* anchor downloads: jsdom cannot navigate, so record them instead */
    window.__downloads = [];
    window.HTMLAnchorElement.prototype.click = function click() {
        this.__clicked = this.href;
        this.__downloaded = this.download;
        window.__downloads.push({ href: this.href, download: this.download });
    };
    window.PointerEvent = class PointerEvent extends window.MouseEvent {
        constructor(type, init = {}) {
            super(type, init);
            this.pointerId = init.pointerId ?? 1;
            this.pointerType = init.pointerType || 'mouse';
            this.isPrimary = init.isPrimary !== false;
            this.pressure = init.pressure ?? (type === 'pointerup' ? 0 : 0.5);
            this.width = 1; this.height = 1;
        }
    };
    window.HTMLCanvasElement.prototype.setPointerCapture = function setPointerCapture() {};
    window.HTMLCanvasElement.prototype.releasePointerCapture = function releasePointerCapture() {};
    /* <dialog>: jsdom ships the element but not the imperative API */
    if (!window.HTMLDialogElement) {
        window.HTMLDialogElement = class HTMLDialogElement extends window.HTMLElement {};
    }
    const dialogProto = window.HTMLDialogElement.prototype;
    const define = (name, value) => Object.defineProperty(dialogProto, name, {
        configurable: true, writable: true, value,
    });
    if (typeof dialogProto.showModal !== 'function') {
        define('showModal', function showModal() { this.setAttribute('open', ''); });
    }
    if (typeof dialogProto.show !== 'function') {
        define('show', function show() { this.setAttribute('open', ''); });
    }
    if (typeof dialogProto.close !== 'function') {
        define('close', function close(value) {
            if (value !== undefined) this.returnValue = String(value);
            this.removeAttribute('open');
            // real dialogs fire 'close' as a separate task
            window.setTimeout(() => this.dispatchEvent(new window.Event('close')), 0);
        });
    }
    window.open = () => ({
        document: { write() {}, close() {}, body: { innerHTML: '' } },
        focus() {}, print() {}, close() {},
    });

    /* --- timers/rAF come from jsdom so the client's own scheduling
           (rAF render loop, setTimeout throttle) is exercised ------ */
    window.WebSocket = FakeSocket;
    FakeSocket.OPEN = 1;
    FakeSocket.CONNECTING = 0;
    FakeSocket.CLOSING = 2;
    FakeSocket.CLOSED = 3;

    /* --- globals ------------------------------------------------- */
    const globals = {
        window, document: window.document, location: window.location,
        HTMLElement: window.HTMLElement, HTMLCanvasElement: window.HTMLCanvasElement,
        HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
        HTMLSelectElement: window.HTMLSelectElement, HTMLDialogElement: window.HTMLDialogElement,
        Element: window.Element, Node: window.Node, Event: window.Event,
        CustomEvent: window.CustomEvent, MouseEvent: window.MouseEvent,
        KeyboardEvent: window.KeyboardEvent, PointerEvent: window.PointerEvent,
        WebSocket: FakeSocket, ResizeObserver: window.ResizeObserver,
        requestAnimationFrame: window.requestAnimationFrame.bind(window),
        cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
        getComputedStyle: window.getComputedStyle.bind(window),
    };
    for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true, writable: true, value: window.navigator,
    });

    const view = window.document.getElementById('view-whiteboard');
    const wrap = window.document.getElementById('wb-canvas-wrap');
    const canvas = window.document.getElementById('whiteboard-canvas');
    layout(view, 0, 0, width, height);
    layout(wrap, 0, 0, width, height);
    layout(canvas, 0, 0, width, height);

    const { Whiteboard, BUILD } = await import(`${path.join(SRC, 'whiteboard.js')}?boot=${instance}`);
    window.document.getElementById('classroom-root').dataset.wbBuild = BUILD;
    const { opPoints, opX, opY, PAGE_W, PAGE_H } = await import(path.join(SRC, 'wb/geometry.js'));
    window.__wb = Whiteboard;
    Whiteboard.init({ roomCode: 'ABCDE', identity: 'u:7', canDraw, participantName: 'سارا' });
    const socket = FakeSocket.instances.at(-1);
    if (online) {
        socket.open();
        socket.serverSend({
            type: 'whiteboard_history',
            board: { page_count: 1, pages: {}, revision: 0 },
            events: [],
            seq: 0,
            full: true,
            limits: { max_op_bytes: 65536, max_points: 4096, batch: 64, layer },
            you: { identity: 'u:7', name: 'سارا', can_draw: canDraw },
        });
    }
    await tick(30);

    const helpers = {
        /** dispatch a pointer event at client (x, y) — element-local here since
         *  the canvas sits at 0,0, except for the offset test which relayouts */
        pointer(type, x, y, extra = {}) {
            const event = new window.PointerEvent(type, {
                bubbles: true, cancelable: true, clientX: x, clientY: y,
                button: 0, buttons: type === 'pointerup' ? 0 : 1, ...extra,
            });
            canvas.dispatchEvent(event);
            return event;
        },
        async stroke(points, { steps = points.length } = {}) {
            helpers.pointer('pointerdown', ...points[0]);
            for (let i = 1; i < steps; i += 1) helpers.pointer('pointermove', ...points[i]);
            helpers.pointer('pointerup', ...points[points.length - 1]);
            await tick(40);
        },
        key(type, key, extra = {}) {
            const event = new window.KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...extra });
            window.document.dispatchEvent(event);
            return event;
        },
        click(selector) {
            const el = typeof selector === 'string' ? window.document.querySelector(selector) : selector;
            if (!el) throw new Error(`click: ${selector} not found`);
            el.click();
            return el;
        },
        pixel(x, y) {
            const ctx = canvas.getContext('2d');
            const ratio = window.devicePixelRatio || 1;
            const data = ctx.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data;
            return [data[0], data[1], data[2], data[3]];
        },
        /** every non-transparent, non-white pixel count on the live canvas */
        inkCount() {
            const ctx = canvas.getContext('2d');
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let ink = 0;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] > 8 && (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240)) ink += 1;
            }
            return ink;
        },
        /** bounding box (in css px) of pixels matching ``match`` */
        inkBox(match) {
            const ctx = canvas.getContext('2d');
            const ratio = window.devicePixelRatio || 1;
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] <= 8) continue;
                if (!match([data[i], data[i + 1], data[i + 2]])) continue;
                const index = i / 4;
                const x = (index % canvas.width) / ratio;
                const y = Math.floor(index / canvas.width) / ratio;
                minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
            return maxX < 0 ? null : { minX, minY, maxX, maxY };
        },
        /** accept the next modal.js confirmation */
        async acceptDialog() {
            await tick(10);
            const ok = window.document.querySelector('#app-dialog-body')
                ?.closest('dialog')?.querySelector('[data-act="ok"]');
            if (!ok) throw new Error('no dialog to accept');
            ok.click();
            await tick(10);
        },
        /** client px of a point of an op, via the client's own mapping.
         *  ``norm: 1`` ops carry fractions of the page, so they are multiplied
         *  by the page size first (the same rule the renderer uses). */
        clientPointOf(op, index = 0) {
            const points = opPoints(op);
            let px = opX(op);
            let py = opY(op);
            if (points.length > index) [px, py] = points[index];
            else if (points.length) [px, py] = points[0];
            const scaleX = op.norm ? PAGE_W : 1;
            const scaleY = op.norm ? PAGE_H : 1;
            return Whiteboard.renderer.toClient(px * scaleX, py * scaleY);
        },
        /** client px of one point of an op (via the client's own mapping) */
        clientPoint(op, index = 0) {
            const points = opPoints(op);
            const [px, py] = points[index] || points[0] || [opX(op), opY(op)];
            return Whiteboard.renderer.toClient(px, py);
        },
        layout,
        relayout(dprRatio = null) {
            layout(canvas, 0, 0, window.innerWidth || width, height);
            if (dprRatio) window.devicePixelRatio = dprRatio;
        },
    };

    return {
        dom, window, document: window.document, Whiteboard, socket, canvas, wrap, view, helpers,
        instance,
        /** everything the client logged (plus jsdom's own errors) */
        log: () => [...(quietConsole.logged || []), ...pageLog],
        /** push a server frame into the socket the client is using right now
         *  (the transport replaces its socket after every disconnect) */
        send: (frame) => (Whiteboard.socket.ws || socket).serverSend(frame),
    };
}

export const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
export { FakeSocket };
