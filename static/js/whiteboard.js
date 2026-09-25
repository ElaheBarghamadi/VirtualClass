/**
 * whiteboard.js — collaborative, multi-page whiteboard on Fabric.js.
 *
 * Synchronisation model: every stroke/shape/text/clear/page-add is a
 * structured operation (JSON) sent over the whiteboard WebSocket — never
 * a canvas image.  The server validates permissions + shape, persists
 * the op (tagged with its page) and relays it; on connect we replay the
 * stored history page by page.
 *
 * Pages: every op carries `page`.  Each client freely navigates pages;
 * "new page" broadcasts a page_add op so everybody's page count stays
 * in sync.  Pages are persisted server-side automatically — the 💾
 * button additionally exports the visible page as a PNG download.
 *
 * Local undo/redo affects only this user's own operations.
 */
class WhiteboardImpl {
    constructor() {
        this.canvas = null;        // fabric.Canvas
        this.ws = null;
        this.tool = 'pen';
        this.color = '#2563eb';
        this.width = 3;
        this.drawing = false;
        this.startPoint = null;
        this.liveShape = null;
        this.idCounter = 0;
        this.myUndo = [];
        this.myRedo = [];
        this.remote = false;       // suppress broadcast while applying remote ops
        this.canDraw = false;
        this.unavailable = false;  // fabric failed to load
        this.identity = null;
        this.retryDelay = 1000;
        // multi-page state
        this.page = 1;
        this.pageCount = 1;
        this._pageOps = new Map(); // page → ordered ops (source of truth for repaint)
    }

    init({ roomCode, identity, canDraw }) {
        this.identity = identity;
        this.canDraw = canDraw;
        if (typeof fabric === 'undefined') {
            // library failed to load — degrade, don't crash the room
            this.unavailable = true;
            console.warn('[whiteboard] fabric.js is not loaded');
            return;
        }
        const el = document.getElementById('whiteboard-canvas');
        if (!el) return;
        this.canvas = new fabric.Canvas(el, {
            backgroundColor: '#ffffff',
            selection: false,
            isDrawingMode: false,
            preserveObjectStacking: true,
        });
        this.resize();
        window.addEventListener('resize', () => this.resize());
        // The wrap changes size on view-switch, panel toggles and
        // fullscreen — observe it directly instead of guessing.
        const wrap = this._wrapEl();
        if (wrap && window.ResizeObserver) {
            this._resizeObs = new ResizeObserver(() => this.resize());
            this._resizeObs.observe(wrap);
        }

        this._bindToolbar();
        this._bindPages();
        this._bindDrawing();
        this._connect(roomCode);
    }

    /** The element whose size the canvas should match (.wb-canvas-wrap). */
    _wrapEl() {
        // fabric wraps our <canvas> in .canvas-container (wrapperEl);
        // the layout parent of THAT is what we must measure.
        return this.canvas?.wrapperEl?.parentElement || null;
    }

    // ------------------------------------------------------------ transport
    _connect(roomCode) {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${location.host}/ws/classroom/${roomCode}/whiteboard/`);
        this.ws.onopen = () => { this.retryDelay = 1000; };
        this.ws.onclose = () => setTimeout(() => this._connect(roomCode), this.retryDelay = Math.min(this.retryDelay * 2, 15000));
        this.ws.onmessage = (evt) => {
            const data = JSON.parse(evt.data);
            if (data.type === 'whiteboard_history') {
                this._pageOps.clear();
                this.remote = true;
                data.events.forEach((e) => this._applyOp(e.op));
                this.remote = false;
                this._updatePageUI();
            } else if (data.type === 'whiteboard_operation') {
                if (data.actor_identity === this.identity) return; // already applied locally
                this.remote = true;
                this._applyOp(data.op);
                this.remote = false;
                this._updatePageUI();
            }
        };
    }

    _sendOp(op) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ action: 'op', op }));
        }
    }

    // ------------------------------------------------------------ tools
    _bindToolbar() {
        document.querySelectorAll('.wb-tool').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.wb-tool').forEach((b) => {
                    b.classList.remove('active');
                    b.setAttribute('aria-pressed', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-pressed', 'true');
                this.tool = btn.dataset.tool;
            });
        });
        document.querySelectorAll('.wb-action').forEach((btn) => {
            btn.addEventListener('click', () => this.run(btn.dataset.action));
        });
        document.getElementById('wb-color')?.addEventListener('input', (e) => { this.color = e.target.value; });
        document.getElementById('wb-width')?.addEventListener('input', (e) => { this.width = Number(e.target.value); });
    }

    _bindPages() {
        document.getElementById('wb-prev')?.addEventListener('click', () => this.setPage(this.page - 1));
        document.getElementById('wb-next')?.addEventListener('click', () => this.setPage(this.page + 1));
        document.getElementById('wb-new-page')?.addEventListener('click', () => this.addPage());
        document.getElementById('wb-save')?.addEventListener('click', () => this.exportPNG());
    }

    _updatePageUI() {
        const label = document.getElementById('wb-page-label');
        if (label) label.textContent = `صفحهٔ ${this.page} از ${this.pageCount}`;
        const prev = document.getElementById('wb-prev');
        const next = document.getElementById('wb-next');
        if (prev) prev.disabled = this.page <= 1;
        if (next) next.disabled = this.page >= this.pageCount;
    }

    setPage(n) {
        n = Math.max(1, Math.min(this.pageCount, n));
        if (n === this.page) return;
        this.page = n;
        this._repaintPage();
        this._updatePageUI();
    }

    addPage() {
        if (!this.canDraw) return this._deny();
        const target = this.pageCount + 1;
        const op = { type: 'page_add', page: target, id: this._id() };
        // apply locally first (we are the actor — server echo is filtered out)
        this._applyOp(op);
        this._sendOp(op);
        this._updatePageUI();
    }

    /** Re-render the current page from its recorded ops. */
    _repaintPage() {
        if (!this.canvas) return;
        this.canvas.clear();
        this.canvas.backgroundColor = '#ffffff';
        for (const op of this._pageOps.get(this.page) || []) this._paintOp(op);
        this.canvas.requestRenderAll();
    }

    /** Export the visible page as a downloadable PNG. */
    exportPNG() {
        if (!this.canvas) return;
        const url = this.canvas.toDataURL({ format: 'png', multiplier: 2 });
        const a = document.createElement('a');
        a.href = url;
        a.download = `whiteboard-page-${this.page}.png`;
        a.click();
    }

    _bindDrawing() {
        this.canvas.on('mouse:down', (opt) => this._down(opt));
        this.canvas.on('mouse:move', (opt) => this._move(opt));
        this.canvas.on('mouse:up', () => this._up());
    }

    _deny(reason = 'شما اجازهٔ استفاده از تخته را ندارید.') {
        if (!this._warned) {
            import('./toast.js').then(({ toast }) => toast(reason, 'warning'));
            this._warned = true;
            setTimeout(() => { this._warned = false; }, 4000);
        }
        return false;
    }

    _down(opt) {
        if (!this.canDraw) return this._deny();
        const p = { x: opt.pointer.x, y: opt.pointer.y };

        if (this.tool === 'text') {
            const text = prompt('متن مورد نظر:');
            if (text && text.trim()) {
                const op = {
                    type: 'text', id: this._id(), page: this.page, x: p.x, y: p.y,
                    text: text.slice(0, 500), color: this.color, size: 18 + this.width * 2,
                };
                this._applyOp(op);
                this._sendOp(op);
                this._pushUndo(op);
            }
            return;
        }

        this.drawing = true;
        this.startPoint = p;
        if (this.tool === 'pen' || this.tool === 'highlighter' || this.tool === 'eraser') {
            this.liveShape = new fabric.Polyline([p, p], {
                stroke: this.tool === 'eraser' ? '#ffffff' : this.color,
                strokeWidth: this.tool === 'eraser' ? this.width * 6 : this.width,
                strokeLineCap: 'round',
                strokeLineJoin: 'round',
                fill: '',
                opacity: this.tool === 'highlighter' ? 0.35 : 1,
                selectable: false,
                objectCaching: false,
            });
            this.canvas.add(this.liveShape);
        } else if (['line', 'arrow', 'rectangle', 'circle'].includes(this.tool)) {
            this.liveShape = this._makeShape(this.tool, p, p);
            this.canvas.add(this.liveShape);
        }
    }

    _move(opt) {
        if (!this.drawing || !this.liveShape) return;
        const p = { x: opt.pointer.x, y: opt.pointer.y };
        if (['pen', 'highlighter', 'eraser'].includes(this.tool)) {
            const pts = this.liveShape.points;
            pts.push(p);
            this.liveShape.set({ points: pts });
            this.canvas.requestRenderAll();
        } else {
            this._updateShape(this.liveShape, this.startPoint, p);
        }
    }

    _up() {
        if (!this.drawing || !this.liveShape) { this.drawing = false; return; }
        const obj = this.liveShape;
        this.liveShape = null;
        this.drawing = false;

        const op = this._serialize(obj);
        if (!op) { this.canvas.remove(obj); return; }
        op.page = this.page;
        obj.set('data', { opId: op.id });
        this._sendOp(op);
        this._pushUndo(op);
    }

    _makeShape(tool, a, b) {
        const common = {
            stroke: this.color,
            strokeWidth: this.width,
            fill: '',
            selectable: false,
            objectCaching: false,
        };
        if (tool === 'line' || tool === 'arrow') {
            return new fabric.Line([a.x, a.y, b.x, b.y], common);
        }
        const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        if (tool === 'rectangle') return new fabric.Rect({ left, top, width: w, height: h, ...common });
        return new fabric.Ellipse({ left, top, rx: w / 2, ry: h / 2, ...common });
    }

    _updateShape(shape, a, b) {
        if (shape.type === 'line') {
            shape.set({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        } else if (shape.type === 'rect') {
            shape.set({
                left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
                width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y),
            });
        } else if (shape.type === 'ellipse') {
            shape.set({
                left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
                rx: Math.abs(b.x - a.x) / 2, ry: Math.abs(b.y - a.y) / 2,
            });
        }
        shape.setCoords();
        this.canvas.requestRenderAll();
    }

    // ------------------------------------------------------------ serialization
    _id() {
        return `${this.identity}-${Date.now()}-${++this.idCounter}`;
    }

    _serialize(obj) {
        const common = { id: obj.data?.opId || this._id() };
        if (obj.type === 'polyline') {
            const stroke = obj.stroke;
            let tool = 'pen';
            if (stroke === '#ffffff') tool = 'eraser';
            else if (obj.opacity < 1) tool = 'highlighter';
            return {
                type: 'draw', tool, id: common.id,
                points: obj.points.map((p) => [Math.round(p.x), Math.round(p.y)]),
                color: stroke, width: obj.strokeWidth,
            };
        }
        if (obj.type === 'line') {
            const isArrow = this.tool === 'arrow';
            return {
                type: 'draw', tool: isArrow ? 'arrow' : 'line', id: common.id,
                points: [[Math.round(obj.x1), Math.round(obj.y1)], [Math.round(obj.x2), Math.round(obj.y2)]],
                color: obj.stroke, width: obj.strokeWidth,
            };
        }
        if (obj.type === 'rect') {
            return {
                type: 'draw', tool: 'rectangle', id: common.id,
                left: Math.round(obj.left), top: Math.round(obj.top),
                width: Math.round(obj.width), height: Math.round(obj.height),
                color: obj.stroke, width: obj.strokeWidth,
            };
        }
        if (obj.type === 'ellipse') {
            return {
                type: 'draw', tool: 'circle', id: common.id,
                left: Math.round(obj.left), top: Math.round(obj.top),
                rx: Math.round(obj.rx), ry: Math.round(obj.ry),
                color: obj.stroke, width: obj.strokeWidth,
            };
        }
        return null;
    }

    // ------------------------------------------------------------ applying ops
    /** Record an op, track page count, and paint it when it is visible. */
    _applyOp(op) {
        if (!op || !op.type) return;
        const pg = Math.max(1, parseInt(op.page || 1, 10) || 1);
        op = { ...op, page: pg };

        if (op.type === 'page_add') {
            if (pg > this.pageCount) this.pageCount = pg;
            // the actor jumps to the fresh page; viewers stay put
            if (op.id && String(op.id).startsWith(`${this.identity}-`)) this.setPage(pg);
            return;
        }

        // per-page source of truth
        const list = this._pageOps.get(pg) || [];
        if (op.type === 'clear') {
            this._pageOps.set(pg, []);           // compaction (mirrors server)
        } else if (op.type === 'remove') {
            this._pageOps.set(pg, list.filter((o) => o.id !== op.id));
        } else if (!list.some((o) => o.id === op.id)) {
            // Idempotency: an op may arrive both in the snapshot and live.
            list.push(op);
            this._pageOps.set(pg, list);
        }
        if (pg > this.pageCount) this.pageCount = pg;

        if (pg === this.page) {
            if (op.type === 'clear') {
                this.canvas.clear();
                this.canvas.backgroundColor = '#ffffff';
                this.myUndo = [];
                this.myRedo = [];
                this.canvas.requestRenderAll();
            } else if (op.type === 'remove') {
                this._removeById(op.id);
            } else {
                this._paintOp(op);
            }
        }
    }

    /** Canvas-level rendering of a single op (current page assumed). */
    _paintOp(op) {
        if (op.type === 'text') {
            const text = new fabric.Text(op.text, {
                left: op.x, top: op.y, fill: op.color,
                fontSize: op.size || 20, selectable: false,
            });
            text.set('data', { opId: op.id });
            this.canvas.add(text);
            return;
        }
        if (op.type === 'draw') {
            if (op.id && this.canvas.getObjects().some((o) => o.data?.opId === op.id)) return;
            const obj = this._opToShape(op);
            if (obj) {
                obj.set('data', { opId: op.id });
                this.canvas.add(obj);
            }
        }
    }

    _opToShape(op) {
        const common = {
            stroke: op.color || '#000',
            strokeWidth: op.width || 3,
            fill: '',
            selectable: false,
            objectCaching: false,
        };
        switch (op.tool) {
            case 'pen':
            case 'highlighter':
            case 'eraser': {
                const pts = (op.points || []).map(([x, y]) => ({ x, y }));
                if (pts.length < 2) return null;
                return new fabric.Polyline(pts, {
                    ...common,
                    stroke: op.tool === 'eraser' ? '#ffffff' : op.color,
                    opacity: op.tool === 'highlighter' ? 0.35 : 1,
                });
            }
            case 'line':
            case 'arrow': {
                const [a, b] = op.points || [[0, 0], [0, 0]];
                const line = new fabric.Line([a[0], a[1], b[0], b[1]], common);
                if (op.tool === 'arrow') this._addArrowHead(op, common);
                return line;
            }
            case 'rectangle':
                return new fabric.Rect({ left: op.left, top: op.top, width: op.width, height: op.height, ...common });
            case 'circle':
                return new fabric.Ellipse({ left: op.left, top: op.top, rx: op.rx, ry: op.ry, ...common });
            default:
                return null;
        }
    }

    _addArrowHead(op, common) {
        const [a, b] = op.points;
        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const size = 8 + (op.width || 3) * 2;
        const p1 = { x: b[0] - size * Math.cos(angle - Math.PI / 7), y: b[1] - size * Math.sin(angle - Math.PI / 7) };
        const p2 = { x: b[0] - size * Math.cos(angle + Math.PI / 7), y: b[1] - size * Math.sin(angle + Math.PI / 7) };
        const head = new fabric.Polygon([b, p1, p2], { fill: op.color, stroke: op.color, selectable: false });
        this.canvas.add(head);
    }

    // ------------------------------------------------------------ actions
    run(action) {
        if (action === 'undo') {
            // undo only touches this user's ops on the CURRENT page
            for (let i = this.myUndo.length - 1; i >= 0; i--) {
                if (this.myUndo[i].page !== this.page) continue;
                const [op] = this.myUndo.splice(i, 1);
                this._applyOp({ type: 'remove', id: op.id, page: this.page });
                this._sendOp({ type: 'remove', id: op.id, page: this.page });
                this.myRedo.push(op);
                return;
            }
        } else if (action === 'redo') {
            for (let i = this.myRedo.length - 1; i >= 0; i--) {
                if (this.myRedo[i].page !== this.page) continue;
                const [op] = this.myRedo.splice(i, 1);
                this._applyOp(op);
                this._sendOp(op);
                this.myUndo.push(op);
                return;
            }
        } else if (action === 'clear') {
            if (!this.canDraw) return this._deny();
            if (!confirm('فقط صفحهٔ جاری برای همه پاک شود؟')) return;
            const op = { type: 'clear', id: this._id(), page: this.page };
            this._applyOp(op);
            this._sendOp(op);
        }
    }

    _removeById(id) {
        const target = this.canvas.getObjects().find((o) => o.data?.opId === id);
        if (target) this.canvas.remove(target);
    }

    _pushUndo(op) {
        this.myUndo.push(op);
        this.myRedo = [];
        if (this.myUndo.length > 50) this.myUndo.shift();
    }

    resize() {
        if (!this.canvas) return;
        const wrap = this._wrapEl();
        if (!wrap || wrap.offsetParent === null) return;
        const rect = wrap.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;
        this.canvas.setDimensions({ width: rect.width, height: rect.height });
        this.canvas.requestRenderAll();
    }

    setPermission(canDraw) {
        this.canDraw = canDraw;
    }
}

export const Whiteboard = new WhiteboardImpl();
