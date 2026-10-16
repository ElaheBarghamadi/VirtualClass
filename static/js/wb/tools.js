/**
 * wb/tools.js — pointer, wheel and keyboard interaction for the whiteboard.
 *
 * Every tool follows the same contract: it previews locally (ghost shape,
 * marquee, eraser hints) or updates the model optimistically while dragging,
 * and on release hands *finished wire operations* to the caller.  Nothing
 * here talks to the network or builds DOM beyond the inline text editors,
 * which keeps the interaction layer small, testable and easy to reason about.
 *
 * Tools: pen, highlighter, stroke-eraser, line, arrow, rectangle, ellipse,
 * triangle, diamond, star, text, sticky note, laser pointer, select (move,
 * resize, marquee, duplicate, z-order) and pan/zoom.
 */
import {
    MAX_WIDTH,
    MIN_WIDTH,
    PAGE_H,
    PAGE_W,
    clamp,
    inflate,
    opBounds,
    opPoints,
    opRect,
    opSize,
    round,
    smoothPoints,
} from './geometry.js';

const LIVE_INTERVAL = 70;      // ms between streamed in-progress strokes
const POINTER_INTERVAL = 45;   // ms between remote cursor updates
const SHAPE_TOOLS = new Set(['line', 'arrow', 'rectangle', 'ellipse', 'triangle', 'diamond', 'star']);
const FREEHAND_TOOLS = new Set(['pen', 'highlighter']);
const DEFAULT_STICKY = { w: 330, h: 250 };
const DEFAULT_TEXT_SIZE = 30;
const DRAG_THRESHOLD = 2;

export class BoardTools {
    /**
     * @param {object} options
     * @param {HTMLCanvasElement} options.canvas
     * @param {import('./render.js').BoardRenderer} options.renderer
     * @param {() => import('./model.js').BoardModel} options.getModel
     * @param {() => number} options.getPage
     * @param {(ops: object[], meta?: object) => void} options.commit
     * @param {(op: object) => void} options.ephemeral
     * @param {() => void} options.requestRender
     * @param {() => string} options.newId
     */
    constructor(options) {
        this.canvas = options.canvas;
        this.renderer = options.renderer;
        this.getModel = options.getModel;
        this.getPage = options.getPage;
        this.commit = options.commit;
        this.ephemeral = options.ephemeral;
        this.requestRender = options.requestRender;
        this.newId = options.newId;
        this.host = options.getHost ? options.getHost() : document.body;

        this.tool = 'pen';
        this.color = '#2563eb';
        this.width = 4;
        this.stickyColor = '#fde68a';
        this.locked = false;

        this.selection = new Set();
        this.ghost = null;
        this.marquee = null;
        this.eraserHint = [];
        this.editingId = null;
        this.spaceHeld = false;

        this._mode = null;
        this._start = null;
        this._points = [];
        this._lastLiveAt = 0;
        this._lastCursorAt = 0;
        this._moved = false;
        this._origin = null;
        this._editor = null;
    }

    /* ------------------------------------------------------------------ */
    /* settings                                                           */
    /* ------------------------------------------------------------------ */

    setTool(tool) {
        this.tool = tool;
        if (tool !== 'select') this.clearSelection();
        if (this._editor) this.commitEditing();
        this._refreshCursor();
        this.requestRender();
    }

    setColor(color) {
        this.color = color;
        if (this.selection.size) this.applyToSelection({ color }, { undoHint: 'style' });
    }

    setWidth(width) {
        this.width = clamp(Number(width) || 3, MIN_WIDTH, MAX_WIDTH);
        const selected = this.selectedOps();
        if (selected.length === 1 && selected[0].type === 'text') {
            this.applyToSelection({ size: textSizeFor(this.width) }, { undoHint: 'style' });
        } else if (this.selection.size) {
            this.applyToSelection({ width: this.width }, { undoHint: 'style' });
        }
    }

    setLocked(locked) {
        this.locked = Boolean(locked);
        if (this.locked) {
            this.clearSelection();
            this.commitEditing();
        }
        this.requestRender();
    }

    state() {
        return {
            tool: this.tool,
            ghost: this.ghost,
            selection: [...this.selection],
            marquee: this.marquee,
            eraserHint: this.eraserHint,
            editing: this.editingId,
        };
    }

    _refreshCursor() {
        if (this.spaceHeld || this._mode === 'pan') this.canvas.style.cursor = 'grab';
        else if (this.tool === 'pan') this.canvas.style.cursor = 'grab';
        else if (this.tool === 'laser') this.canvas.style.cursor = 'none';
        else if (this.tool === 'text') this.canvas.style.cursor = 'text';
        else if (this.tool === 'select') this.canvas.style.cursor = 'default';
        else if (this.locked) this.canvas.style.cursor = 'not-allowed';
        else this.canvas.style.cursor = 'crosshair';
    }

    /* ------------------------------------------------------------------ */
    /* selection                                                          */
    /* ------------------------------------------------------------------ */

    clearSelection() {
        if (!this.selection.size) return;
        this.selection.clear();
        this.requestRender();
    }

    selectedOps() {
        const model = this.getModel();
        const page = this.getPage();
        return [...this.selection].map((id) => model.getOp(page, id)).filter(Boolean);
    }

    select(ids, { additive = false } = {}) {
        if (!additive) this.selection.clear();
        for (const id of ids) this.selection.add(id);
        this.requestRender();
    }

    selectAll() {
        const model = this.getModel();
        this.select(model.objects(this.getPage()).map((op) => op.id));
    }

    /** Apply a patch to every selected object (also used for colour/width). */
    applyToSelection(patch, { record = true, undoHint = 'style' } = {}) {
        if (!this.selection.size || this.locked) return;
        const model = this.getModel();
        const page = this.getPage();
        const ops = [];
        for (const id of this.selection) {
            const op = model.getOp(page, id);
            if (!op) continue;
            const wire = this.wirePatch(op, patch);
            if (!wire) continue;
            ops.push({ type: 'update', id, page, norm: 1, patch: wire });
        }
        if (ops.length) this.commit(ops, { record, undoHint });
        this.requestRender();
    }

    nudge(dx, dy) {
        this.applyToSelection({ dx, dy }, { undoHint: 'move' });
    }

    duplicateSelection() {
        const ops = [];
        const ids = [];
        for (const op of this.selectedOps()) {
            const copy = { ...op };
            if (op.type === 'text' || op.type === 'sticky') {
                const patch = this.wirePatch(op, { dx: 30, dy: 30 });
                Object.assign(copy, patch);
            } else {
                const moved = opPoints(op).map(([x, y]) => [x + 30, y + 30]);
                Object.assign(copy, { points: this.wirePoints(op, moved) });
            }
            copy.id = this.newId();
            ops.push(copy);
            ids.push(copy.id);
        }
        if (!ops.length) return;
        this.commit(ops, { record: true, undoHint: 'duplicate' });
        this.select(ids);
    }

    deleteSelection() {
        if (!this.selection.size || this.locked) return;
        const page = this.getPage();
        const ops = [...this.selection].map((id) => ({ type: 'remove', id, page, norm: 1 }));
        this.commit(ops, { record: true, undoHint: 'remove' });
        this.clearSelection();
    }

    reorder(move) {
        const page = this.getPage();
        const ops = [...this.selection].map((id) => ({ type: 'reorder', id, page, norm: 1, move }));
        if (ops.length) this.commit(ops, { record: false });
        this.requestRender();
    }

    /* ------------------------------------------------------------------ */
    /* wire conversions (board units <-> protocol values)                 */
    /* ------------------------------------------------------------------ */

    /** Points in board units → protocol points. */
    wirePoints(op, points) {
        return points.map(([x, y]) => (op.norm
            ? [round(x / PAGE_W), round(y / PAGE_H)]
            : [round(x, 1), round(y, 1)]));
    }

    wirePoint(op, x, y) {
        return op.norm
            ? { x: round(x / PAGE_W), y: round(y / PAGE_H) }
            : { x: round(x, 1), y: round(y, 1) };
    }

    /**
     * Translate a high-level patch expressed in board units into protocol
     * values: ``{dx, dy}`` moves, ``{w, h}``/``{x, y}`` boxes and ``{size}``.
     */
    wirePatch(op, patch) {
        const wire = {};
        if (patch.color !== undefined) wire.color = patch.color;
        if (patch.opacity !== undefined) wire.opacity = patch.opacity;
        if (patch.text !== undefined) wire.text = patch.text;

        const dx = patch.dx || 0;
        const dy = patch.dy || 0;
        const isBox = op.type === 'text' || op.type === 'sticky';

        if (patch.size !== undefined) wire.size = round(op.norm ? patch.size : patch.size, 1);
        if (isBox) {
            const pos = this.wirePoint(op, (op.norm ? op.x * PAGE_W : op.x) + dx, (op.norm ? op.y * PAGE_H : op.y) + dy);
            wire.x = pos.x;
            wire.y = pos.y;
            if (patch.w !== undefined || patch.h !== undefined) {
                const rect = opRect(op);
                const w = patch.w ?? rect.w;
                const h = patch.h ?? rect.h;
                if (op.norm) {
                    wire.w = round(w / PAGE_W);
                    wire.h = round(h / PAGE_H);
                } else {
                    wire.w = round(w, 1);
                    wire.h = round(h, 1);
                }
            }
            return wire;
        }

        const geometryChanged = dx !== 0 || dy !== 0
            || patch.scaleX !== undefined || patch.scaleY !== undefined;
        if (geometryChanged) {
            const points = opPoints(op).map(([x, y]) => [x + dx, y + dy]);
            wire.points = this.wirePoints(op, this._scaledPoints(op, points, patch));
        }
        return wire;
    }

    _scaledPoints(op, points, patch) {
        const scaleX = patch.scaleX;
        const scaleY = patch.scaleY;
        if (scaleX === undefined && scaleY === undefined) return points;
        const bounds = opBounds(op);
        return points.map(([x, y]) => [
            bounds.x + (x - bounds.x) * (scaleX ?? 1),
            bounds.y + (y - bounds.y) * (scaleY ?? 1),
        ]);
    }

    /* ------------------------------------------------------------------ */
    /* pointer handling                                                   */
    /* ------------------------------------------------------------------ */

    localPoint(event) {
        const rect = this.canvas.getBoundingClientRect();
        return [event.clientX - rect.left, event.clientY - rect.top];
    }

    onPointerDown(event) {
        if (event.button === 2) return; // right button: leave the context menu alone
        try {
            this.canvas.setPointerCapture(event.pointerId);
        } catch (err) { /* capture is best effort */ }
        const [cx, cy] = this.localPoint(event);
        const [x, y] = this.renderer.toPage(cx, cy);
        this._start = [x, y];
        this._moved = false;

        if (this.spaceHeld || this.tool === 'pan' || event.button === 1) {
            this._beginPan(cx, cy);
            return;
        }
        if (this.locked) {
            this._beginMarquee(x, y);
            return;
        }

        switch (this.tool) {
            case 'select':
                this._beginSelect(event, x, y);
                return;
            case 'eraser':
                this._mode = 'erase';
                this._points = [[x, y]];
                this._updateEraser();
                return;
            case 'text':
                this._openEditorAt(x, y);
                return;
            case 'sticky':
                this._createSticky(x, y);
                return;
            default:
                if (SHAPE_TOOLS.has(this.tool)) {
                    this._mode = 'shape';
                } else if (FREEHAND_TOOLS.has(this.tool)) {
                    this._mode = 'freehand';
                    this._points = [[x, y]];
                    this._lastLiveAt = 0;
                } else if (this.tool === 'laser') {
                    this._mode = 'laser';
                }
                this._emitCursor(x, y, true);
        }
    }

    _beginPan(cx, cy) {
        this._mode = 'pan';
        this._origin = { client: [cx, cy], pan: [this.renderer.panX, this.renderer.panY] };
        this.canvas.style.cursor = 'grabbing';
    }

    _beginMarquee(x, y) {
        this._mode = 'marquee';
        this.marquee = { x, y, w: 0, h: 0 };
        this.requestRender();
    }

    _beginSelect(event, x, y) {
        const model = this.getModel();
        const page = this.getPage();
        const tolerance = 9 / this.renderer.scale;
        const handle = this.selection.size === 1 ? this._handleAt(x, y) : null;

        if (handle) {
            this._mode = 'resize';
            this._origin = { handle, snapshot: { ...this.selectedOps()[0] }, start: [x, y] };
            return;
        }

        const hit = model.hitTest(page, x, y, tolerance);
        const additive = event.shiftKey || event.metaKey || event.ctrlKey;
        if (hit) {
            if (additive && this.selection.has(hit.id)) {
                this.selection.delete(hit.id);
                this.requestRender();
                return;
            }
            if (!this.selection.has(hit.id)) this.select([hit.id], { additive });
            this._mode = 'move';
            this._origin = {
                start: [x, y],
                snapshots: this.selectedOps().map((op) => ({ ...op })),
            };
            return;
        }
        if (!additive) this.clearSelection();
        this._beginMarquee(x, y);
    }

    _handleAt(x, y) {
        const [op] = this.selectedOps();
        if (!op) return null;
        const bounds = inflate(opBounds(op), 6);
        const grab = 13 / this.renderer.scale;
        const handles = {
            nw: [bounds.x, bounds.y],
            n: [bounds.x + bounds.w / 2, bounds.y],
            ne: [bounds.x + bounds.w, bounds.y],
            e: [bounds.x + bounds.w, bounds.y + bounds.h / 2],
            se: [bounds.x + bounds.w, bounds.y + bounds.h],
            s: [bounds.x + bounds.w / 2, bounds.y + bounds.h],
            sw: [bounds.x, bounds.y + bounds.h],
            w: [bounds.x, bounds.y + bounds.h / 2],
        };
        for (const [name, [hx, hy]] of Object.entries(handles)) {
            if (Math.abs(hx - x) <= grab && Math.abs(hy - y) <= grab) return name;
        }
        return null;
    }

    onPointerMove(event) {
        const [cx, cy] = this.localPoint(event);
        const [x, y] = this.renderer.toPage(cx, cy);
        if (!this._mode) {
            this._emitCursor(x, y);
            if (this.tool === 'select') this._hoverHandle(x, y);
            return;
        }
        const distance = Math.hypot(x - this._start[0], y - this._start[1]);
        if (distance > DRAG_THRESHOLD) this._moved = true;

        switch (this._mode) {
            case 'pan':
                this.renderer.setViewport({
                    panX: this._origin.pan[0] + (cx - this._origin.client[0]),
                    panY: this._origin.pan[1] + (cy - this._origin.client[1]),
                });
                this.requestRender();
                return;
            case 'freehand': {
                this._points.push([x, y]);
                const preview = smoothPoints(this._points, { minDistance: 1.4 });
                this.ghost = this._freehandOp(preview, null);
                this._streamStroke(preview);
                this.requestRender();
                return;
            }
            case 'shape': {
                const end = this._constrainShape(this._start, [x, y], event);
                this.ghost = this._shapeOp(this._start, end, null);
                this.requestRender();
                return;
            }
            case 'erase': {
                this._points.push([x, y]);
                this._updateEraser();
                this.requestRender();
                return;
            }
            case 'marquee': {
                this.marquee = {
                    x: Math.min(this._start[0], x),
                    y: Math.min(this._start[1], y),
                    w: Math.abs(x - this._start[0]),
                    h: Math.abs(y - this._start[1]),
                };
                this.requestRender();
                return;
            }
            case 'move': {
                const dx = x - this._origin.start[0];
                const dy = y - this._origin.start[1];
                this._applyLocal(this._origin.snapshots, (op) => this.wirePatch(op, { dx, dy }));
                this.requestRender();
                return;
            }
            case 'resize': {
                const dx = x - this._origin.start[0];
                const dy = y - this._origin.start[1];
                const patch = this._resizePatch(this._origin.snapshot, this._origin.handle, dx, dy);
                this._applyLocal([this._origin.snapshot], () => patch);
                this.requestRender();
                return;
            }
            default:
        }
    }

    onPointerUp(event) {
        const mode = this._mode;
        this._mode = null;
        const [cx, cy] = this.localPoint(event);
        const [x, y] = this.renderer.toPage(cx, cy);
        this._refreshCursor();

        if (mode === 'freehand') {
            const points = smoothPoints(this._points, { minDistance: 1.6 });
            this.ghost = null;
            this._points = [];
            if (points.length >= 2) {
                const op = this._freehandOp(points, this.newId());
                this.commit([op], { record: true, undoHint: 'add' });
            }
            this.requestRender();
            return;
        }
        if (mode === 'shape') {
            const end = this._constrainShape(this._start, [x, y], event);
            this.ghost = null;
            if (Math.hypot(end[0] - this._start[0], end[1] - this._start[1]) > 3) {
                const op = this._shapeOp(this._start, end, this.newId());
                this.commit([op], { record: true, undoHint: 'add' });
            }
            this.requestRender();
            return;
        }
        if (mode === 'erase') {
            const touched = this.getModel().touchedByStroke(this.getPage(), this._points, 14 / Math.max(0.2, this.renderer.scale));
            this.eraserHint = [];
            this._points = [];
            if (touched.length) {
                const page = this.getPage();
                this.commit(
                    touched.map((op) => ({ type: 'remove', id: op.id, page, norm: 1 })),
                    { record: true, undoHint: 'erase' },
                );
            }
            this.requestRender();
            return;
        }
        if (mode === 'marquee') {
            const marquee = this.marquee;
            this.marquee = null;
            if (marquee && (marquee.w > 4 || marquee.h > 4)) {
                const hits = this.getModel().opsInBounds(this.getPage(), marquee).map((op) => op.id);
                this.select(hits, { additive: event.shiftKey });
            }
            this.requestRender();
            return;
        }
        if (mode === 'move' || mode === 'resize') {
            const origin = this._origin;
            this._origin = null;
            if (this._moved && origin) {
                const dx = x - origin.start[0];
                const dy = y - origin.start[1];
                const ops = [];
                if (mode === 'move') {
                    for (const snapshot of origin.snapshots) {
                        ops.push({
                            type: 'update',
                            id: snapshot.id,
                            page: this.getPage(),
                            norm: 1,
                            patch: this.wirePatch(snapshot, { dx, dy }),
                        });
                    }
                } else {
                    ops.push({
                        type: 'update',
                        id: origin.snapshot.id,
                        page: this.getPage(),
                        norm: 1,
                        patch: this._resizePatch(origin.snapshot, origin.handle, dx, dy),
                    });
                }
                this.commit(ops, { record: true, undoHint: mode });
            }
            this.requestRender();
            return;
        }
        this.requestRender();
    }

    /** Apply an uncommitted patch to the local model (live drag feedback). */
    _applyLocal(snapshots, patchFor) {
        const model = this.getModel();
        const page = this.getPage();
        for (const snapshot of snapshots) {
            const patch = patchFor(snapshot);
            if (!patch) continue;
            model.apply({ type: 'update', id: snapshot.id, page, norm: 1, patch });
        }
    }

    /** Right-click shortcut: erase the topmost object under the pointer. */
    eraseAtPointer(event) {
        if (this.locked) return this.deny?.();
        const [cx, cy] = this.localPoint(event);
        const [x, y] = this.renderer.toPage(cx, cy);
        const page = this.getPage();
        const op = this.getModel().hitTest(page, x, y, 12 / this.renderer.scale);
        if (!op) return;
        this.commit([{ type: 'remove', id: op.id, page, norm: 1 }], { record: true, undoHint: 'erase' });
        this.requestRender();
    }

    onDoubleClick(event) {
        const [cx, cy] = this.localPoint(event);
        const [x, y] = this.renderer.toPage(cx, cy);
        const op = this.getModel().hitTest(this.getPage(), x, y, 10 / this.renderer.scale);
        if (!op || this.locked) return;
        if (op.type === 'text' || op.type === 'sticky') {
            this.select([op.id]);
            this._openEditorFor(op);
        }
    }

    onPointerLeave() {
        if (!this._mode) this._emitCursor(null);
    }

    /* ------------------------------------------------------------------ */
    /* operation construction                                             */
    /* ------------------------------------------------------------------ */

    _freehandOp(points, id) {
        const op = {
            type: 'draw',
            tool: this.tool,
            page: this.getPage(),
            norm: 1,
            color: this.color,
            width: this.width,
            points: points.map(([x, y]) => [round(x / PAGE_W), round(y / PAGE_H)]),
        };
        if (this.tool === 'highlighter') op.opacity = 0.35;
        if (id) op.id = id;
        return op;
    }

    _shapeOp(start, end, id) {
        const op = {
            type: 'draw',
            tool: this.tool,
            page: this.getPage(),
            norm: 1,
            color: this.color,
            width: this.width,
            points: [start, end].map(([x, y]) => [round(x / PAGE_W), round(y / PAGE_H)]),
        };
        if (id) op.id = id;
        return op;
    }

    _constrainShape(start, end, event) {
        if (!event.shiftKey) return end;
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const size = Math.max(Math.abs(dx), Math.abs(dy));
        return [
            start[0] + (dx === 0 ? size : Math.sign(dx) * size),
            start[1] + (dy === 0 ? size : Math.sign(dy) * size),
        ];
    }

    _resizePatch(op, handle, dx, dy) {
        const bounds = opBounds(op);
        let { x, y, w, h } = bounds;
        if (handle.includes('w')) {
            x += dx;
            w -= dx;
        }
        if (handle.includes('e')) w += dx;
        if (handle.includes('n')) {
            y += dy;
            h -= dy;
        }
        if (handle.includes('s')) h += dy;
        w = Math.max(8, w);
        h = Math.max(8, h);

        if (op.type === 'sticky') {
            const wire = this.wirePatch(op, { dx: x - bounds.x, dy: y - bounds.y, w, h });
            return wire;
        }
        if (op.type === 'text') {
            // text has no box: resizing scales the font and re-anchors it
            const ratio = bounds.h > 0 ? clamp(h / bounds.h, 0.3, 4) : 1;
            return this.wirePatch(op, {
                dx: x - bounds.x,
                dy: y - bounds.y,
                size: clamp(opSize(op) * ratio, 8, 400),
            });
        }
        const scaleX = bounds.w > 0 ? w / bounds.w : 1;
        const scaleY = bounds.h > 0 ? h / bounds.h : 1;
        const points = opPoints(op).map(([px, py]) => [
            x + (px - bounds.x) * scaleX,
            y + (py - bounds.y) * scaleY,
        ]);
        return { points: this.wirePoints(op, points) };
    }

    _createSticky(x, y) {
        const op = {
            type: 'sticky',
            id: this.newId(),
            page: this.getPage(),
            norm: 1,
            x: round(x / PAGE_W),
            y: round(y / PAGE_H),
            w: round(DEFAULT_STICKY.w / PAGE_W),
            h: round(DEFAULT_STICKY.h / PAGE_H),
            text: '',
            size: 26,
            color: this.stickyColor,
        };
        this.commit([op], { record: true, undoHint: 'add' });
        this.select([op.id]);
        this._openEditorFor(op);
    }

    _updateEraser() {
        const tolerance = 14 / Math.max(0.2, this.renderer.scale);
        this.eraserHint = this.getModel().touchedByStroke(this.getPage(), this._points, tolerance);
    }

    /* ------------------------------------------------------------------ */
    /* inline text editing                                                */
    /* ------------------------------------------------------------------ */

    _openEditorAt(x, y) {
        this._spawnEditor({
            left: x,
            top: y,
            width: 260 / this.renderer.scale,
            fontSize: DEFAULT_TEXT_SIZE,
            value: '',
            op: null,
            anchor: [x, y],
        });
    }

    _openEditorFor(op) {
        const rect = op.type === 'sticky'
            ? opRect(op)
            : { x: op.x * PAGE_W, y: op.y * PAGE_H, w: 320, h: opSize(op) * 1.4 };
        this._spawnEditor({
            left: rect.x,
            top: rect.y,
            width: Math.max(140, rect.w || 320),
            height: op.type === 'sticky' ? rect.h : null,
            fontSize: opSize(op) || DEFAULT_TEXT_SIZE,
            value: op.text || '',
            op,
            anchor: [rect.x, rect.y],
        });
    }

    _spawnEditor(options) {
        if (this._editor) this.commitEditing();
        const editor = document.createElement('textarea');
        editor.className = 'wb-inline-editor';
        editor.dir = 'auto';
        editor.spellcheck = false;
        editor.setAttribute('aria-label', 'متن روی تخته');

        const scale = this.renderer.scale;
        const canvasRect = this.canvas.getBoundingClientRect();
        const hostRect = this.host.getBoundingClientRect();
        const [cx, cy] = this.renderer.toClient(options.left, options.top);
        editor.style.left = `${canvasRect.left - hostRect.left + cx}px`;
        editor.style.top = `${canvasRect.top - hostRect.top + cy}px`;
        editor.style.width = `${Math.max(120, (options.width || 260) * scale)}px`;
        if (options.height) editor.style.height = `${Math.max(80, options.height * scale)}px`;
        editor.style.fontSize = `${Math.max(12, (options.fontSize || DEFAULT_TEXT_SIZE) * scale)}px`;
        editor.value = options.value || '';

        const finish = (save) => {
            if (!this._editor) return;
            this._editor = null;
            const text = editor.value.trim();
            editor.remove();
            this.editingId = null;
            const op = options.op;
            if (!save) {
                if (op && !op.text) {
                    this.commit([{ type: 'remove', id: op.id, page: this.getPage(), norm: 1 }], { record: false });
                }
                this.requestRender();
                return;
            }
            if (op) {
                if (text !== (op.text || '')) {
                    this.commit(
                        [{ type: 'update', id: op.id, page: this.getPage(), norm: 1, patch: { text } }],
                        { record: true, undoHint: 'text' },
                    );
                }
            } else if (text) {
                this.commit(
                    [{
                        type: 'text',
                        id: this.newId(),
                        page: this.getPage(),
                        norm: 1,
                        x: round(options.anchor[0] / PAGE_W),
                        y: round(options.anchor[1] / PAGE_H),
                        text,
                        size: DEFAULT_TEXT_SIZE,
                        color: this.color,
                    }],
                    { record: true, undoHint: 'add' },
                );
            }
            this.requestRender();
        };

        editor.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                finish(false);
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                finish(true);
            }
        });
        editor.addEventListener('blur', () => finish(true));

        this.host.appendChild(editor);
        this._editor = editor;
        this.editingId = options.op ? options.op.id : null;
        setTimeout(() => {
            editor.focus();
            editor.select();
        }, 0);
    }

    /** Save the open inline editor (the toolbar calls this before switching views). */
    commitEditing() {
        if (this._editor) this._editor.blur();
    }

    cancelEditing() {
        if (this._editor) {
            const editor = this._editor;
            this._editor = null;
            editor.remove();
        }
        this.editingId = null;
    }

    /* ------------------------------------------------------------------ */
    /* ephemeral traffic                                                  */
    /* ------------------------------------------------------------------ */

    _emitCursor(x, y, force = false) {
        const now = performance.now();
        if (!force && now - this._lastCursorAt < POINTER_INTERVAL) return;
        this._lastCursorAt = now;
        if (x === null || x === undefined) {
            this.ephemeral({ type: 'cursor', page: this.getPage(), gone: true });
            return;
        }
        if (this.tool === 'laser') {
            this.ephemeral({
                type: 'laser', page: this.getPage(), norm: 1,
                x: round(x / PAGE_W), y: round(y / PAGE_H),
            });
            return;
        }
        this.ephemeral({
            type: 'cursor', page: this.getPage(), norm: 1, tool: this.tool,
            x: round(x / PAGE_W), y: round(y / PAGE_H),
        });
    }

    _streamStroke(points) {
        const now = performance.now();
        if (now - this._lastLiveAt < LIVE_INTERVAL) return;
        this._lastLiveAt = now;
        const op = this._freehandOp(
            smoothPoints(points, { minDistance: 3, maxPoints: 320 }),
            null,
        );
        op.live = true;
        this.ephemeral(op);
    }

    /* ------------------------------------------------------------------ */
    /* wheel + keyboard                                                   */
    /* ------------------------------------------------------------------ */

    onWheel(event) {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
            const [cx, cy] = this.localPoint(event);
            this.renderer.zoomAt(cx, cy, event.deltaY < 0 ? 1.12 : 1 / 1.12);
        } else {
            this.renderer.setViewport({
                panX: this.renderer.panX - event.deltaX,
                panY: this.renderer.panY - event.deltaY,
            });
        }
        this.requestRender();
    }

    handleKeyDown(event) {
        const target = event.target;
        if (this._editor || target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
            return false;
        }
        const meta = event.ctrlKey || event.metaKey;
        const key = (event.key || '').toLowerCase();

        if (event.code === 'Space') {
            if (!this.spaceHeld) {
                this.spaceHeld = true;
                this._refreshCursor();
            }
            event.preventDefault();
            return true;
        }
        if (meta && key === 'z') {
            event.preventDefault();
            this.onUndo?.(event.shiftKey ? 'redo' : 'undo');
            return true;
        }
        if (meta && key === 'y') {
            event.preventDefault();
            this.onUndo?.('redo');
            return true;
        }
        if (meta && key === 'd') {
            event.preventDefault();
            this.duplicateSelection();
            return true;
        }
        if (meta && key === 'a') {
            event.preventDefault();
            this.selectAll();
            return true;
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
            if (this.selection.size) {
                event.preventDefault();
                this.deleteSelection();
                return true;
            }
            return false;
        }
        if (event.key === 'Escape') {
            if (this._editor) {
                this.cancelEditing();
                return true;
            }
            if (this.selection.size) {
                this.clearSelection();
                return true;
            }
            return false;
        }
        if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            this.onPageChange?.(event.key === 'ArrowRight' ? 1 : -1);
            return true;
        }
        const step = event.shiftKey ? 20 : 2;
        const moves = {
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
            ArrowLeft: [-step, 0],
            ArrowRight: [step, 0],
        };
        if (moves[event.key] && this.selection.size) {
            event.preventDefault();
            this.nudge(...moves[event.key]);
            return true;
        }
        return false;
    }

    handleKeyUp(event) {
        if (event.code === 'Space') {
            this.spaceHeld = false;
            this._refreshCursor();
        }
    }
}

export function textSizeFor(width) {
    return clamp(18 + Number(width) * 2, 14, 120);
}
