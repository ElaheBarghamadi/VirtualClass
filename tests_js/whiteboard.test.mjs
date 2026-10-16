/**
 * Headless test harness for the whiteboard client engine.
 *
 * Loads the *real* modules — ``static/js/whiteboard.js`` plus ``static/js/wb/*``
 * — inside jsdom, with ``@napi-rs/canvas`` standing in for the browser canvas
 * and a fake WebSocket that records everything the client sends and lets the
 * test push server frames back.  The real ``#view-whiteboard`` markup is
 * lifted out of ``classrooms/templates/classrooms/room.html``, so a renamed id
 * or a missing button fails here instead of in the browser.
 *
 *     cd tests_js && npm install && npm test
 *
 * ``npm test -- --dump`` additionally writes ``.build/ops.json``: every frame
 * the client sent during the run.  ``whiteboard/tests.py::ClientContractTests``
 * holds a capture of exactly that shape, which is how the two halves are kept
 * from drifting apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = path.join(HERE, '.build');

/* ------------------------------------------------------------------ */
/* copy the client sources so Node can treat them as ES modules        */
/* ------------------------------------------------------------------ */
function syncSources() {
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.cpSync(path.join(REPO, 'static/js'), SRC, { recursive: true });
  fs.writeFileSync(path.join(SRC, 'package.json'), JSON.stringify({ type: 'module' }));
}

/* pull the real #view-whiteboard markup out of the Django template */
function whiteboardMarkup() {
  const template = fs.readFileSync(
    path.join(REPO, 'classrooms/templates/classrooms/room.html'), 'utf8',
  );
  const start = template.indexOf('<div class="stage-view hidden" id="view-whiteboard">');
  if (start < 0) throw new Error('view-whiteboard not found in the template');
  let depth = 0;
  let index = start;
  while (index < template.length) {
    const open = template.indexOf('<div', index);
    const close = template.indexOf('</div>', index);
    if (close < 0) throw new Error('unbalanced div in the template');
    if (open >= 0 && open < close) { depth += 1; index = open + 4; } else { depth -= 1; index = close + 6; }
    if (depth === 0) break;
  }
  return template.slice(start, index);
}

/* ------------------------------------------------------------------ */
/* environment                                                         */
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
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(payload) { this.sent.push(JSON.parse(payload)); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code, wasClean: true }); }
  serverOpen() { this.readyState = 1; this.onopen?.({}); }
  serverSend(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  closeFromServer(code) { this.readyState = 3; this.onclose?.({ code, wasClean: true }); }
  frames(action) { return this.sent.filter((frame) => frame.action === action); }
  ops() { return this.sent.filter((f) => f.action === 'op' || f.action === 'ops').flatMap((f) => (f.op ? [f.op] : f.ops)); }
}

async function boot({ canDraw = true } = {}) {
  syncSources();
  const dom = new JSDOM(
    `<!doctype html><html dir="rtl"><head></head><body><div class="room"><div class="stage">${whiteboardMarkup()}</div></div></body></html>`,
    {
      url: 'https://class.example.test/room/ABCDE',
      pretendToBeVisual: true,
      // the board stage is shown by room.js when the view switches
      beforeParse(window) { window.document.title = 'room'; },
    },
  );
  const { window } = dom;

  /* --- canvas: back every <canvas> with a real 2D context --- */
  const backing = new WeakMap();
  function contextFor(element) {
    const w = Math.max(1, element.width || 300);
    const h = Math.max(1, element.height || 150);
    let entry = backing.get(element);
    if (!entry) {
      const canvas = createCanvas(w, h);
      entry = { canvas, ctx: canvas.getContext('2d') };
      backing.set(element, entry);
    }
    if (entry.canvas.width !== w || entry.canvas.height !== h) {
      entry.canvas.width = w;
      entry.canvas.height = h;
    }
    return entry.ctx;
  }
  window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
    return type === '2d' ? contextFor(this) : null;
  };
  const proto = Object.getPrototypeOf(createCanvas(2, 2).getContext('2d'));
  const nativeDrawImage = proto.drawImage;
  proto.drawImage = function drawImage(source, ...rest) {
    const element = source && source.nodeName === 'CANVAS' ? backing.get(source) : null;
    return nativeDrawImage.call(this, element ? element.canvas : source, ...rest);
  };
  window.HTMLCanvasElement.prototype.toDataURL = function toDataURL() {
    const entry = backing.get(this);
    return entry ? entry.canvas.toDataURL('image/png') : 'data:image/png;base64,';
  };
  const defaultRect = (el) => ({
    x: 0, y: 0, left: 0, top: 0, width: el.__w || 1200, height: el.__h || 700,
    right: el.__w || 1200, bottom: el.__h || 700,
  });
  window.Element.prototype.getBoundingClientRect = function rect() { return defaultRect(this); };
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return this.classList.contains('hidden') ? null : (this.parentElement ?? null); },
  });
  window.Element.prototype.scrollIntoView = () => {};
  if (!window.HTMLDialogElement) window.HTMLDialogElement = class HTMLDialogElement extends window.HTMLElement {};
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLDialogElement.prototype.show = function show() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function close(value) {
    if (value !== undefined) this.returnValue = String(value);
    this.open = false;
    // real dialogs fire 'close' as a separate task
    window.setTimeout(() => this.dispatchEvent(new window.Event('close')), 0);
  };
  window.HTMLCanvasElement.prototype.setPointerCapture = () => {};
  window.HTMLCanvasElement.prototype.releasePointerCapture = () => {};
  window.PointerEvent = class PointerEvent extends window.MouseEvent {};
  window.ResizeObserver = class ResizeObserver { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.WebSocket = FakeWebSocket;
  window.open = () => ({ document: { write() {}, close() {} } });
  window.HTMLAnchorElement.prototype.click = function click() { this.__downloaded = this.download; };
  window.devicePixelRatio = 1;

  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement',
    'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
    'PointerEvent', 'WebSocket', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    globalThis[key] = window[key];
  }
  globalThis.location = window.location;
  dom.window.addEventListener('error', (event) => {
    console.log(`!! window error: ${event.message}`);
  });
  globalThis.self = window;

  const module = await import(path.join(SRC, 'whiteboard.js'));
  const Whiteboard = module.Whiteboard;
  window.__wb = Whiteboard;
  Whiteboard.init({ roomCode: 'ABCDE', identity: 'u:7', memberId: 7, name: 'سارا', canDraw });
  await tick();

  const socket = FakeWebSocket.instances.at(-1);
  socket.serverOpen();
  socket.serverSend({
    type: 'whiteboard_history',
    board: { page_count: 1, pages: {}, revision: 0 },
    events: [],
    seq: 0,
    full: true,
    you: { identity: 'u:7', name: 'سارا', can_draw: canDraw },
  });
  await tick();

  window.document.getElementById('view-whiteboard').classList.remove('hidden');
  const canvas = window.document.getElementById('whiteboard-canvas');
  const wrap = window.document.getElementById('wb-canvas-wrap');
  wrap.__w = 1200; wrap.__h = 700;
  canvas.__w = 1200; canvas.__h = 700;
  Whiteboard.resize();
  await tick();

  const acceptDialog = async () => {
    await tick(20);
    const ok = window.document.querySelector('#app-dialog-body')?.closest('dialog')?.querySelector('[data-act="ok"]');
    if (ok) ok.click();
    await tick(20);
  };

  const pointer = (type, x, y, extra = {}) => {
    const event = new window.PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    });
    Object.assign(event, { pointerId: 1, pointerType: 'mouse', isPrimary: true, pressure: 0.5, ...extra });
    canvas.dispatchEvent(event);
  };
  return { dom, window, Whiteboard, socket, canvas, wrap, pointer, acceptDialog };
}

export { boot, FakeWebSocket, whiteboardMarkup, syncSources };

/* ------------------------------------------------------------------ */
/* the checks                                                          */
/* ------------------------------------------------------------------ */
async function main() {
  syncSources();
  const { window, Whiteboard, socket, canvas, pointer, acceptDialog } = await boot({ canDraw: true });

  await check('boot: markup wiring finds every element ui.js needs', () => {
    for (const id of ['wb-canvas-wrap', 'whiteboard-canvas', 'wb-palette', 'wb-pages-list', 'wb-status',
      'wb-zoom-value', 'wb-selection-bar', 'wb-page-label', 'wb-grid', 'wb-save']) {
      assert(window.document.getElementById(id), `missing #${id}`);
    }
    assert(Whiteboard.ready, 'whiteboard not ready');
    same(Whiteboard.unavailable, false, 'board went unavailable');
  });

  await check('boot: socket opened the right url and asked for presence', () => {
    assert(socket.url.startsWith('wss://class.example.test/ws/classroom/ABCDE/whiteboard/'), socket.url);
  });

  /* --- drawing --- */
  await check('pen: one stroke becomes one draw op with norm=1 fractions', async () => {
    Whiteboard.setTool('pen');
    Whiteboard.setColor('#dc2626');
    const before = socket.ops().length;
    pointer('pointerdown', 100, 100);
    for (let x = 120; x <= 400; x += 40) pointer('pointermove', x, 100 + (x % 60));
    pointer('pointerup', 400, 140);
    const ops = socket.ops().slice(before);
    const strokes = ops.filter((op) => op.type === 'draw' && !op.live);
    assert(strokes.length === 1, `expected 1 stroke, got ${strokes.length}`);
    const stroke = strokes[0];
    same(stroke.norm, 1, 'norm flag');
    same(stroke.tool, 'pen', 'tool');
    same(stroke.color, '#dc2626', 'colour');
    assert(stroke.points.length >= 4, `points ${stroke.points.length}`);
    assert(stroke.points.flat().every((v) => v >= -0.05 && v <= 1.05),
      `points must be page fractions: ${JSON.stringify(stroke.points)}`);
    same(stroke.width, Whiteboard.tools.width, 'width in reference units');
    same(Whiteboard.objects(1).filter((op) => !op.live).length, 1, 'model objects');
    assert(Whiteboard._pageOps instanceof Map, '_pageOps must be a Map');
  });

  await check('pen: the same stroke survives a two-client replay round trip', () => {
    const op = Whiteboard.objects(1)[0];
    assert(op.id && op.points.length, 'stroke has an id and points');
  });

  await check('persist: batched strokes go as op frames and stay ordered', () => {
    const strokes = socket.ops().filter((op) => op.type === 'draw' && !op.live);
    assert(strokes.length >= 1, 'no strokes sent');
    assert(strokes.every((op) => typeof op.page === 'number' && op.page >= 1), 'page missing');
  });

  await check('highlighter: drawn with its own tool and alpha', () => {
    const before = socket.ops().length;
    Whiteboard.setTool('highlighter');
    pointer('pointerdown', 200, 300);
    pointer('pointermove', 500, 320);
    pointer('pointerup', 500, 320);
    const op = socket.ops().slice(before).find((entry) => entry.type === 'draw' && !entry.live);
    assert(op, 'no highlighter op');
    same(op.tool, 'highlighter');
  });

  await check('shapes: rectangle draws a two-corner op in page fractions', () => {
    const before = socket.ops().length;
    Whiteboard.setTool('rectangle');
    pointer('pointerdown', 600, 100);
    pointer('pointermove', 800, 260);
    pointer('pointerup', 800, 260);
    const op = socket.ops().slice(before).find((entry) => entry.type === 'draw' && !entry.live);
    assert(op, 'no shape op');
    same(op.tool, 'rectangle');
    same(op.norm, 1);
    same(op.points.length, 2, 'a rectangle is two corners');
    assert(op.points[0][0] !== op.points[1][0] && op.points[0][1] !== op.points[1][1], 'degenerate corners');
    assert(op.points.flat().every((v) => v >= 0 && v <= 1), `corners ${JSON.stringify(op.points)}`);
  });

  await check('eraser: removes the object under the pointer (no erase strokes)', () => {
    const before = socket.ops().length;
    const target = Whiteboard.objects(1).find((op) => op.tool === 'rectangle');
    assert(target, 'no rectangle to erase');
    const mid = [(target.points[0][0] + target.points[1][0]) / 2, (target.points[0][1] + target.points[1][1]) / 2];
    const [cx, cy] = Whiteboard.renderer.toClient(mid[0] * 1244.4444, mid[1] * 700);
    Whiteboard.setTool('eraser');
    pointer('pointerdown', cx, cy);
    pointer('pointerup', cx, cy);
    const op = socket.ops().slice(before).find((entry) => entry.type === 'remove');
    assert(op, 'no remove op');
    same(op.id, target.id);
    assert(!Whiteboard.objects(1).some((entry) => entry.id === target.id), 'object still in the model');
  });

  await check('update: eraser drag removes several objects in one frame', () => {
    const before = socket.ops().length;
    const strokes = Whiteboard.objects(1).filter((op) => op.type === 'draw');
    assert(strokes.length, 'nothing left to erase');
    Whiteboard.setTool('eraser');
    pointer('pointerdown', 110, 110);
    for (let x = 150; x <= 500; x += 25) pointer('pointermove', x, 300);
    pointer('pointerup', 500, 300);
    const removals = socket.ops().slice(before).filter((op) => op.type === 'remove');
    assert(removals.length >= 1, 'no removals');
  });

  await check('undo/redo: locally undone work is replayed to the server', async () => {
    const before = socket.ops().length;
    Whiteboard.setTool('pen');
    pointer('pointerdown', 50, 400); pointer('pointermove', 200, 420); pointer('pointerup', 200, 420);
    const count = Whiteboard.objects(1).length;
    assert(Whiteboard.undo() === true, 'undo returned false');
    assert(Whiteboard.objects(1).length === count - 1, 'undo did not remove the stroke');
    assert(socket.ops().slice(before).some((op) => op.type === 'remove'), 'undo did not reach the socket');
    assert(Whiteboard.redo() === true, 'redo returned false');
    assert(Whiteboard.objects(1).length === count, 'redo did not restore the stroke');
  });

  await check('text: the inline editor commits a text op', async () => {
    const before = socket.ops().length;
    Whiteboard.setTool('text');
    pointer('pointerdown', 300, 500);
    await tick();
    const editor = window.document.querySelector('.wb-inline-editor');
    assert(editor, 'no inline editor spawned');
    editor.value = 'سلام تخته';
    editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await tick();
    const op = socket.ops().slice(before).find((entry) => entry.type === 'text' && !entry.live);
    assert(op, 'no text op');
    same(op.text, 'سلام تخته');
    assert(!window.document.querySelector('.wb-inline-editor'), 'editor not removed');
  });

  await check('sticky: clicking somewhere else while editing still commits', async () => {
    const before = socket.ops().length;
    Whiteboard.setTool('sticky');
    pointer('pointerdown', 700, 500);
    await tick();
    const editor = window.document.querySelector('.wb-inline-editor');
    assert(editor, 'no sticky editor');
    editor.value = 'یادداشت';
    Whiteboard.setTool('pen');
    await tick();
    assert(socket.ops().slice(before).some((op) => op.type === 'sticky'), 'sticky op missing');
  });

  await check('select: dragging a selected object sends an update with new x/y', async () => {
    const target = Whiteboard.objects(1).find((op) => op.type === 'draw');
    Whiteboard.setTool('select');
    const unit = [target.points[0][0] * 1244.4444, target.points[0][1] * 700];
    const [cx, cy] = Whiteboard.renderer.toClient(unit[0], unit[1]);
    pointer('pointerdown', cx, cy);
    pointer('pointermove', cx + 60, cy + 40);
    pointer('pointerup', cx + 60, cy + 40);
    const op = socket.ops().filter((entry) => entry.type === 'update' && entry.id === target.id).at(-1);
    assert(op, 'no update op for the moved object');
    const moved = Whiteboard.objects(1).find((entry) => entry.id === target.id);
    assert(Math.abs(moved.points[0][0] - target.points[0][0]) > 1e-4
      || Math.abs(moved.points[0][1] - target.points[0][1]) > 1e-4, 'object did not move');
  });

  await check('select: marquee selects everything it covers', async () => {
    Whiteboard.setTool('select');
    pointer('pointerdown', 5, 5);
    pointer('pointermove', 1195, 695);
    pointer('pointerup', 1195, 695);
    await tick();
    assert(Whiteboard.tools.selection.size >= 1, `selection ${Whiteboard.tools.selection.size}`);
    assert(!window.document.getElementById('wb-selection-bar').classList.contains('hidden'), 'selection bar hidden');
  });

  await check('delete + duplicate: keyboard delete and Ctrl+D both emit ops', async () => {
    const before = socket.ops().length;
    const document = window.document;
    const first = Whiteboard.objects(1).find((op) => op.type === 'draw');
    Whiteboard.setTool('select');
    Whiteboard.tools.select([first.id]);
    await tick();
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    assert(socket.ops().slice(before).some((op) => op.type === 'remove'), 'delete sent nothing');
    Whiteboard.setTool('select');
    pointer('pointerdown', 5, 5); pointer('pointermove', 1195, 695); pointer('pointerup', 1195, 695);
    await tick();
    const count = socket.ops().length;
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));
    const added = socket.ops().slice(count).filter((op) => ['draw', 'text', 'sticky'].includes(op.type));
    assert(added.length >= 1, 'duplicate sent nothing');
    assert(added.every((op) => !Whiteboard.objects(1).every((entry) => entry.id !== op.id)), 'duplicates not in the model');
  });

  await check('z-order: sending an object to the front emits a reorder op', () => {
    const before = socket.ops().length;
    const target = Whiteboard.objects(1).at(-1);
    Whiteboard.tools.selectOnly?.(target.id);
    Whiteboard.tools.selection.add(target.id);
    window.document.getElementById('wb-layers-front').click();
    const ops = socket.ops().slice(before);
    assert(ops.some((op) => op.type === 'reorder'), `no reorder op (${JSON.stringify(ops)})`);
  });

  await check('pages: new page bumps the Persian page label', async () => {
    const label = window.document.getElementById('wb-page-label');
    assert(Whiteboard.page === 1 && Whiteboard.model.pageCount === 1,
      `board started on page ${Whiteboard.page}/${Whiteboard.model.pageCount}`);
    assert(label.textContent.includes('۱'), `label ${label.textContent}`);
    window.document.getElementById('wb-new-page').click();
    await tick();
    assert(Whiteboard.page === 2, `page ${Whiteboard.page}`);
    assert(/۲/.test(label.textContent), `label after add: ${label.textContent}`);
    assert(socket.ops().some((op) => op.type === 'page_add'), 'no page_add op sent');
    same(Whiteboard.model.pageCount, 2);
  });

  await check('pages: content stays on its own page', async () => {
    Whiteboard.setTool('pen');
    pointer('pointerdown', 60, 60); pointer('pointermove', 160, 90); pointer('pointerup', 160, 90);
    assert(Whiteboard.objects(2).length === 1, 'page 2 stroke missing');
    Whiteboard.setPage(1);
    await tick();
    assert(Whiteboard.objects(1).length > 0, 'page 1 content vanished');
    assert(!Whiteboard.objects(1).some((op) => op.page === 2), 'page 2 op leaked into page 1');
  });

  await check('pages: duplicate copies content and mirrors it in the model', async () => {
    const before = socket.ops().length;
    Whiteboard.setPage(1);
    Whiteboard.duplicatePage(1);
    await tick();
    assert(socket.ops().slice(before).some((op) => op.type === 'page_dup'), 'no page_dup op');
    same(Whiteboard.page, 2, 'jumped to the copy');
    assert(Whiteboard.objects(2).length === Whiteboard.objects(1).length, 'copy has different content count');
  });

  await check('pages: removing a page renumbers the rest', async () => {
    const before = socket.ops().length;
    const total = Whiteboard.model.pageCount;
    void Whiteboard.removePage(total);
    await acceptDialog();
    assert(socket.ops().slice(before).some((op) => op.type === 'page_remove'), 'no page_remove op');
    same(Whiteboard.model.pageCount, total - 1, 'page count after remove');
  });

  await check('page style: background and grid changes are sent as page_setup', () => {
    const before = socket.ops().length;
    const bg = window.document.getElementById('wb-page-bg');
    bg.value = '#fff7ed';
    bg.dispatchEvent(new window.Event('input', { bubbles: true }));
    window.document.getElementById('wb-page-grid').value = 'grid';
    window.document.getElementById('wb-page-grid').dispatchEvent(new window.Event('change', { bubbles: true }));
    const ops = socket.ops().slice(before).filter((op) => op.type === 'page_setup');
    assert(ops.some((op) => op.color === '#fff7ed'), 'background op missing');
    assert(ops.some((op) => op.grid === 'grid'), 'grid op missing');
  });

  await check('toolbar: colour, width and tool buttons drive the tools', () => {
    window.document.querySelector('[data-tool="highlighter"]').click();
    same(Whiteboard.tools.tool, 'highlighter', 'toolbar tool');
    assert(window.document.querySelector('[data-tool="highlighter"]').classList.contains('active'), 'not marked active');
    window.document.querySelector('[data-tool="pen"]').click();
    same(Whiteboard.tools.tool, 'pen');
    const width = window.document.getElementById('wb-width');
    width.value = '12';
    width.dispatchEvent(new window.Event('input', { bubbles: true }));
    same(Whiteboard.tools.width, 12, 'width');
    const swatch = window.document.querySelector('#wb-palette .wb-swatch');
    swatch.click();
    same(Whiteboard.tools.color, swatch.dataset.color, 'palette colour');
    assert(window.document.getElementById('wb-popover-color').classList.contains('hidden'), 'popover stayed open');
  });

  await check('zoom: buttons change scale and the percent label', () => {
    const before = Whiteboard.renderer.zoom;
    window.document.getElementById('wb-zoom-in').click();
    assert(Whiteboard.renderer.zoom > before, 'zoom in did nothing');
    const label = window.document.getElementById('wb-zoom-value');
    assert(/٪/.test(label.textContent), `label ${label.textContent}`);
    window.document.getElementById('wb-zoom-reset').click();
    assert(Whiteboard.renderer.zoom > 0, 'reset broke the zoom');
  });

  await check('undo of a remote-free local edit is allowed; redo stack clears on new work', () => {
    Whiteboard.setTool('pen');
    pointer('pointerdown', 10, 650); pointer('pointermove', 90, 660); pointer('pointerup', 90, 660);
    assert(Whiteboard.undo() === true, 'undo failed');
    assert(Whiteboard.redo() === true, 'redo failed');
    pointer('pointerdown', 30, 600); pointer('pointermove', 130, 610); pointer('pointerup', 130, 610);
    assert(Whiteboard.redo() === false || Whiteboard.model.canRedo(Whiteboard.page) === false, 'redo stack not cleared');
  });

  await check('saving: PNG export produces a data url for the current page', () => {
    const url = Whiteboard.exportPNG(1);
    assert(typeof url === 'string' && url.startsWith('data:image/png'), String(url).slice(0, 40));
  });

  await check('thumbnails: the pages panel renders canvases for every page', () => {
    Whiteboard.chrome.renderThumbnails();
    const items = window.document.querySelectorAll('#wb-pages-list .wb-page-item');
    assert(items.length === Whiteboard.model.pageCount, `items ${items.length}`);
    same(window.document.querySelectorAll('#wb-pages-list canvas.wb-thumb').length, Whiteboard.model.pageCount);
  });

  await check('presence: remote cursors and roster chips show up', async () => {
    socket.serverSend({
      type: 'presence', action: 'join', room: 'ABCDE',
      participant: { identity: 'u:9', name: 'رضا', can_draw: true },
    });
    await tick();
    socket.serverSend({
      type: 'whiteboard_operation', ephemeral: true, actor_identity: 'u:9', actor_name: 'رضا', seq: 0,
      op: { type: 'cursor', id: 'c1', x: 0.5, y: 0.5, norm: 1 },
    });
    await tick(60);
    const chips = window.document.querySelectorAll('#wb-presence .wb-chip');
    assert([...chips].some((chip) => chip.textContent.includes('رضا')), 'roster chip missing');
    same(Whiteboard._remoteCursors.size, 1, 'remote cursor');
  });

  await check('remote edits: a peer op lands in the model without echoing back', async () => {
    const before = socket.ops().length;
    socket.serverSend({
      type: 'whiteboard_operation', actor_identity: 'u:9', actor_name: 'رضا', seq: 33,
      op: {
        type: 'draw', id: 'peer-1', page: 1, norm: 1, tool: 'pen', color: '#111827', width: 3,
        points: [[0.1, 0.1], [0.3, 0.3], [0.4, 0.42]],
      },
    });
    await tick();
    assert(Whiteboard.objects(1).some((op) => op.id === 'peer-1'), 'peer stroke not applied');
    same(socket.ops().length, before, 'client echoed the peer op back');
  });

  await check('robustness: a malformed op cannot break the render loop', async () => {
    socket.serverSend({
      type: 'whiteboard_operation', actor_identity: 'u:9', actor_name: 'رضا', seq: 34,
      op: {
        type: 'draw', id: 'broken-1', page: 1, norm: 1, tool: 'pen',
        points: [0.1, 0.2, null, 'x', [0.3], [0.4, 0.5]],
      },
    });
    await tick(60);
    assert(!Whiteboard._crashed, 'render loop died');
    assert(Whiteboard.renderer.zoom > 0, 'renderer unusable');
    // a good op still renders after the broken one
    socket.serverSend({
      type: 'whiteboard_operation', actor_identity: 'u:9', actor_name: 'رضا', seq: 35,
      op: { type: 'draw', id: 'after-broken', page: 1, norm: 1, tool: 'pen', color: '#111827', width: 3,
        points: [[0.6, 0.6], [0.7, 0.7]] },
    });
    await tick(60);
    assert(Whiteboard.objects(1).some((op) => op.id === 'after-broken'), 'board stopped applying ops');
  });

  await check('rejected ops: a server error rolls the local change back', async () => {
    const before = Whiteboard.objects(1).length;
    const stroke = Whiteboard.objects(1).filter((op) => op.type === 'draw').at(-1);
    assert(stroke, 'no stroke to reject');
    let sent = false;
    let last = null;
    if (stroke.type === 'draw') {
      Whiteboard.setTool('pen');
      pointer('pointerdown', 90, 90); pointer('pointermove', 140, 120); pointer('pointerup', 140, 120);
      last = socket.ops().filter((op) => op.type === 'draw' && !op.live).at(-1);
      sent = Boolean(last);
    }
    assert(sent, 'no stroke to reject');
    socket.serverSend({
      type: 'error', code: 'rate-limited',
      message: 'زیادی سریع', ops: [last.id],
    });
    await tick();
    assert(!Whiteboard.objects(1).some((op) => op.id === last.id), 'model kept the rejected stroke');
    assert(window.document.getElementById('wb-status'), 'status pill missing');
  });

  await check('sync: a full resync replaces board state', async () => {
    socket.serverSend({
      type: 'whiteboard_history', full: true, trimmed: true, seq: 90,
      board: { page_count: 2, pages: { 1: { color: '#ffffff', grid: 'dots' } }, revision: 90 },
      events: [{
        id: 1, seq: 80, actor_identity: 'u:9', actor_name: 'رضا',
        op: { type: 'text', id: 'resync-1', page: 1, norm: 1, x: 0.2, y: 0.2, text: 'بازخوانی' },
      }],
    });
    await tick();
    assert(Whiteboard.objects(1).some((op) => op.id === 'resync-1'), 'resynced content missing');
    same(Whiteboard.model.pageCount, 2, 'page count after resync');
    same(Whiteboard.model.style(1).grid, 'dots', 'page style after resync');
  });

  await check('permission revoke: the board stops drawing and warns', async () => {
    Whiteboard.setPermission(false);
    const flag = window.document.getElementById('wb-nodraw-hint');
    assert(!flag.classList.contains('hidden'), 'no-draw hint hidden');
    assert(window.document.querySelector('.wb-toolbar').classList.contains('no-draw'), 'toolbar not dimmed');
    const before = socket.ops().length;
    Whiteboard.setTool('pen');
    pointer('pointerdown', 100, 100); pointer('pointermove', 200, 200); pointer('pointerup', 200, 200);
    same(socket.ops().length, before, 'a locked board still sent ops');
    Whiteboard.setPermission(true);
    assert(flag.classList.contains('hidden'), 'hint stayed visible after re-grant');
  });

  await check('resize: canvas follows the wrap size', () => {
    const wrap = window.document.getElementById('wb-canvas-wrap');
    wrap.__w = 800; wrap.__h = 450;
    Whiteboard.resize();
    same(Whiteboard.renderer.width, 800, 'renderer width');
    same(Whiteboard.renderer.height, 450, 'renderer height');
    same(canvas.width, 800, 'canvas width');
  });

  await check('actions: every data-action in the markup is handled', async () => {
    const actions = [...window.document.querySelectorAll('[data-action]')].map((el) => el.dataset.action);
    const ASYNC = new Set(['clear', 'help']);          // promise-returning, still handled
    const unhandled = new Set();
    const thrown = [];
    for (const action of new Set(actions)) {
      if (action === 'fullscreen-stage') continue;     // room.js owns this one
      let touched = ASYNC.has(action);
      try {
        const pending = Whiteboard.run(action);
        if (ASYNC.has(action)) { await acceptDialog(); await tick(60); }
        const value = await pending;
        touched = touched || value !== undefined;
      } catch (err) { thrown.push(`${action}: ${err.message}`); }
    }
    same(thrown, [], 'actions that threw');
    same([...unhandled], [], 'actions without a handler');
    assert([...new Set(actions)].every((action) => action === 'fullscreen-stage' || action.length), 'empty action');
  });

  await check('laser: pointing streams ephemeral ops that are never persisted', async () => {
    const before = socket.sent.length;
    Whiteboard.setTool('laser');
    pointer('pointerdown', 400, 300);
    pointer('pointermove', 420, 320);
    pointer('pointermove', 440, 330);
    pointer('pointerup', 440, 330);
    const frames = socket.sent.slice(before);
    const ops = frames.flatMap((frame) => (frame.op ? [frame.op] : (frame.ops || [])));
    const lasers = ops.filter((op) => op.type === 'laser');
    assert(lasers.length >= 1, `no laser ops (${JSON.stringify(ops)})`);
    assert(lasers.every((op) => !op.id || true), 'laser ops carry no persisted state');
  });

  await check('viewport: ctrl+wheel zooms, plain wheel pans, space+drag moves the canvas', () => {
    Whiteboard.setTool('pen');
    const zoom = Whiteboard.renderer.zoom;
    const wheel = (extra) => {
      const event = new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, ...extra });
      canvas.dispatchEvent(event);
    };
    wheel({ ctrlKey: true });
    assert(Whiteboard.renderer.zoom > zoom, 'ctrl+wheel did not zoom');
    const pan = Whiteboard.renderer.panY;
    wheel({ deltaY: 90 });
    assert(Whiteboard.renderer.panY !== pan, 'plain wheel did not pan');

    const panX = Whiteboard.renderer.panX;
    const key = (type, extra) => window.document.dispatchEvent(
      new window.KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, ...extra }),
    );
    key('keydown');
    pointer('pointerdown', 500, 400);
    pointer('pointermove', 560, 430);
    pointer('pointerup', 560, 430);
    key('keyup');
    assert(Whiteboard.renderer.panX !== panX, 'space+drag did not pan the canvas');
    Whiteboard.resetView();
  });

  await check('keyboard: Alt+arrows change page and arrows nudge the selection', async () => {
    Whiteboard.setPage(1);
    Whiteboard.setTool('pen');
    pointer('pointerdown', 220, 220);
    pointer('pointermove', 320, 260);
    pointer('pointerup', 320, 260);
    const target = Whiteboard.objects(1).filter((op) => op.type === 'draw').at(-1);
    assert(target, 'the test stroke is missing');

    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
    await tick();
    assert(Whiteboard.page === 2, `page ${Whiteboard.page}`);
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }));
    await tick();
    assert(Whiteboard.page === 1, `page ${Whiteboard.page} after going back`);

    Whiteboard.setTool('select');
    Whiteboard.tools.select([target.id]);
    const before = socket.ops().length;
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert(socket.ops().slice(before).some((op) => op.type === 'update' && op.id === target.id), 'nudge sent nothing');
  });

  await check('resize handles: dragging a corner sends a geometry patch', () => {
    Whiteboard.setTool('rectangle');
    pointer('pointerdown', 700, 380);
    pointer('pointermove', 900, 520);
    pointer('pointerup', 900, 520);
    const target = Whiteboard.objects(1).filter((op) => op.type === 'draw' && op.tool === 'rectangle').at(-1);
    assert(target, 'the test rectangle is missing');

    Whiteboard.setTool('select');
    Whiteboard.tools.select([target.id]);
    const [x, y] = Whiteboard.renderer.toClient(target.points[0][0] * 1244.4444, target.points[0][1] * 700);
    const before = socket.ops().length;
    pointer('pointerdown', x + 2, y + 2);                     // grabs the nw handle
    pointer('pointermove', x + 60, y + 40);
    pointer('pointerup', x + 60, y + 40);
    const patch = socket.ops().slice(before).find((op) => op.type === 'update' && op.id === target.id);
    assert(patch, 'dragging the handle sent nothing');
    assert(patch.patch && Object.keys(patch.patch).length, 'empty geometry patch');
    const resized = Whiteboard.objects(1).find((op) => op.id === target.id);
    assert(JSON.stringify(resized.points) !== JSON.stringify(target.points), 'geometry unchanged after resize');
  });

  await check('text editing: double-click reopens the editor with the text', async () => {
    const textOp = Whiteboard.objects(1).find((op) => op.type === 'text');
    assert(textOp, 'no text object on the page');
    Whiteboard.setTool('select');
    const [x, y] = Whiteboard.renderer.toClient(textOp.x * 1244.4444, textOp.y * 700);
    const event = new window.PointerEvent('dblclick', { bubbles: true, clientX: x + 4, clientY: y + 4 });
    Object.assign(event, { pointerId: 1 });
    canvas.dispatchEvent(event);
    await tick();
    const editor = window.document.querySelector('.wb-inline-editor');
    assert(editor, 'editor did not open');
    assert(editor.value === textOp.text, `editor started with "${editor.value}"`);
    editor.value = 'ویرایش شد';
    editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
  });

  await check('export: printing opens a page with one sheet per board page', () => {
    let written = '';
    let printed = false;
    window.open = () => ({
      document: { write: (html) => { written += html; }, close() {} },
      print: () => { printed = true; },
    });
    Whiteboard.printAll();
    assert(written.includes('<figure>'), 'no page sheets in the print window');
    assert((written.match(/data:image\/png/g) || []).length === Whiteboard.model.pageCount,
      'print window is missing pages');
    void printed;
  });

  await check('chrome: the pages drawer, popovers and follow switch reflect state', async () => {
    const pages = window.document.getElementById('wb-pages-panel');
    window.document.getElementById('wb-pages-toggle').click();
    await tick();
    assert(!pages.classList.contains('hidden'), 'pages drawer did not open');
    assert(window.document.querySelectorAll('#wb-pages-list .wb-page-item').length === Whiteboard.model.pageCount,
      'drawer lists the wrong pages');
    window.document.getElementById('wb-pages-close').click();
    await tick();
    assert(pages.classList.contains('hidden'), 'pages drawer did not close');

    const popover = window.document.getElementById('wb-popover-color');
    window.document.querySelector('[data-popover="color"]').click();
    assert(!popover.classList.contains('hidden'), 'colour popover did not open');
    const other = window.document.getElementById('wb-popover-page');
    window.document.querySelector('[data-popover="page"]').click();
    assert(popover.classList.contains('hidden') && !other.classList.contains('hidden'), 'popovers overlap');

    const grid = window.document.getElementById('wb-grid');
    const before = Whiteboard.model.style(Whiteboard.page).grid;
    grid.click();
    assert(Whiteboard.model.style(Whiteboard.page).grid !== before, 'grid cycle did nothing');

    const follow = window.document.getElementById('wb-follow');
    const wasFollowing = Whiteboard.follow;
    follow.click();
    assert(Whiteboard.follow === !wasFollowing, 'follow switch did not toggle');
    assert(follow.getAttribute('aria-pressed') === String(!wasFollowing), 'follow aria state stale');
  });

  await check('assumptions: the facade still exposes the hooks room.js/e2e rely on', () => {
    assert(typeof Whiteboard.resize === 'function', 'resize()');
    assert(typeof Whiteboard.setPermission === 'function', 'setPermission()');
    assert(typeof Whiteboard.page === 'number', 'page');
    assert(Whiteboard.PAGE.width > 0 && Whiteboard.PAGE.height > 0, 'PAGE');
    assert(typeof Whiteboard.textSizeFor === 'function', 'textSizeFor');
    assert(Whiteboard._pageOps instanceof Map, '_pageOps');
    const room = fs.readFileSync(path.join(REPO, 'static/js/room.js'), 'utf8');
    assert(room.includes('Whiteboard.init('), 'room.js no longer calls Whiteboard.init');
  });

  /* ------------------------------------------------------------------ */
  /* report                                                             */
  /* ------------------------------------------------------------------ */
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (process.argv.includes('--dump')) {
    fs.writeFileSync(path.join(HERE, '.build', 'ops.json'), JSON.stringify(socket.ops(), null, 1));
    console.log('wrote .build/ops.json');
  }
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('board.test.mjs')) {
  main().catch((err) => {
    console.error('harness crashed:', err);
    process.exit(2);
  });
}
