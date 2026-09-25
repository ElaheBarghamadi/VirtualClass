/**
 * whiteboard.js — collaborative whiteboard on Fabric.js.
 *
 * Synchronisation model: every stroke/shape/text/clear is a structured
 * operation (JSON) sent over the whiteboard WebSocket — never a canvas
 * image.  The server validates permissions + shape, persists the op and
 * relays it; on connect we replay the stored history.
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
        this.userId = null;
        this.retryDelay = 1000;
    }

    init({ roomCode, userId, canDraw }) {
        this.userId = userId;
        this.canDraw = canDraw;
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

        this._bindToolbar();
        this._bindDrawing();
        this._connect(roomCode);
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
                this.remote = true;
                data.events.forEach((e) => this._applyOp(e.op));
                this.remote = false;
            } else if (data.type === 'whiteboard_operation') {
                if (data.actor_id === this.userId) return; // already applied locally
                this.remote = true;
                this._applyOp(data.op);
                this.remote = false;
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
                    type: 'text', id: this._id(), x: p.x, y: p.y,
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
        return `${this.userId}-${Date.now()}-${++this.idCounter}`;
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
    _applyOp(op) {
        if (!op || !op.type) return;
        if (op.type === 'clear') {
            this.canvas.clear();
            this.canvas.backgroundColor = '#ffffff';
            this.canvas.requestRenderAll();
            this.myUndo = [];
            this.myRedo = [];
            return;
        }
        if (op.type === 'remove') {
            const target = this.canvas.getObjects().find((o) => o.data?.opId === op.id);
            if (target) this.canvas.remove(target);
            return;
        }
        // Idempotency: an op may arrive both in the snapshot and live.
        if (op.id && this.canvas.getObjects().some((o) => o.data?.opId === op.id)) return;
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
            const op = this.myUndo.pop();
            if (!op) return;
            this._removeById(op.id);
            this._sendOp({ type: 'remove', id: op.id });
            this.myRedo.push(op);
        } else if (action === 'redo') {
            const op = this.myRedo.pop();
            if (!op) return;
            this._applyOp(op);
            this._sendOp(op);
            this._pushUndo(op);
        } else if (action === 'clear') {
            if (!this.canDraw) return this._deny();
            if (!confirm('کل تخته برای همه پاک شود؟')) return;
            const op = { type: 'clear', id: this._id() };
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
        const wrap = this.canvas.getElement().parentElement;
        if (!wrap || wrap.offsetParent === null) return;
        const rect = wrap.getBoundingClientRect();
        if (rect.width < 10) return;
        this.canvas.setDimensions({ width: rect.width, height: rect.height });
        this.canvas.requestRenderAll();
    }

    setPermission(canDraw) {
        this.canDraw = canDraw;
    }
}

export const Whiteboard = new WhiteboardImpl();
