/**
 * whiteboard.js — collaborative, multi-page whiteboard on Fabric.js.
 *
 * Synchronisation model: every stroke/shape/text/clear/page op is a
 * structured operation (JSON) sent over the whiteboard WebSocket — never
 * a canvas image.  The server validates permissions + shape, persists
 * the op (tagged with its page) and relays it; on connect we replay the
 * stored history page by page.
 *
 * Pages: every op carries `page`.  A privileged user's page navigation
 * is SHARED (`page_go`) so the whole class follows the presenter;
 * everybody can still browse locally.  Each page remembers its own
 * background color and grid style (`page_setup`).  Pages persist
 * server-side automatically; 💾 exports the visible page as PNG.
 *
 * Laser pointer ops are ephemeral — relayed live, never stored.
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
        this._replaying = false;   // history replay: record only, paint once
        this.canDraw = false;
        this.unavailable = false;  // fabric failed to load
        this.identity = null;
        this.retryDelay = 1000;
        // multi-page state
        this.page = 1;
        this.pageCount = 1;
        this._pageOps = new Map();    // page → ordered ops (source of truth for repaint)
        this._pageColors = new Map(); // page → '#rrggbb'
        this._pageGrid = new Map();   // page → 'none'|'grid'|'dots'
        this._lastLaser = 0;
        this._laserTimer = null;
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
                this._pageColors.clear();
                this._pageGrid.clear();
                this.remote = true;
                this._replaying = true;
                data.events.forEach((e) => this._applyOp(e.op));
                this._replaying = false;
                this.remote = false;
                // one clean repaint (with the right background) for the
                // page the presenter last shared — much faster than
                // rendering every op as it replays
                this.page = Math.max(1, Math.min(this.pageCount, this.page));
                this._repaintPage();
                this._updatePageUI();
            } else if (data.type === 'whiteboard_operation') {
                if (data.actor_identity === this.identity) return; // already applied locally
                this.remote = true;
                this._applyOp(data.op, data.actor_name);
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

        // page background colour
        document.getElementById('wb-bg')?.addEventListener('input', (e) => {
            if (!this.canDraw) return this._deny();
            this._applyOp({ type: 'page_setup', page: this.page, color: e.target.value, id: this._id() });
            this._sendOp({ type: 'page_setup', page: this.page, color: e.target.value, id: this._id() });
        });
        // grid style cycler: none → grid → dots → none
        const gridBtn = document.getElementById('wb-grid');
        gridBtn?.addEventListener('click', () => {
            if (!this.canDraw) return this._deny();
            const order = ['none', 'grid', 'dots'];
            const cur = this._pageGrid.get(this.page) || 'none';
            const next = order[(order.indexOf(cur) + 1) % order.length];
            const op = { type: 'page_setup', page: this.page, grid: next, id: this._id() };
            this._applyOp(op);
            this._sendOp(op);
        });
    }

    _bindPages() {
        document.getElementById('wb-prev')?.addEventListener('click', () => this.setPage(this.page - 1));
        document.getElementById('wb-next')?.addEventListener('click', () => this.setPage(this.page + 1));
        document.getElementById('wb-new-page')?.addEventListener('click', () => this.addPage());
        document.getElementById('wb-save')?.addEventListener('click', () => this.exportPNG());
    }

    _updatePageUI() {
        const label = document.getElementById('wb-page-label');
        if (label) label.textContent = `صفحهٔ ${Number(this.page).toLocaleString('fa-IR')} از ${Number(this.pageCount).toLocaleString('fa-IR')}`;
        const prev = document.getElementById('wb-prev');
        const next = document.getElementById('wb-next');
        if (prev) prev.disabled = this.page <= 1;
        if (next) next.disabled = this.page >= this.pageCount;
        // reflect current page style on the controls
        const bg = document.getElementById('wb-bg');
        if (bg) bg.value = this._pageColors.get(this.page) || '#ffffff';
        const gridBtn = document.getElementById('wb-grid');
        if (gridBtn) {
            const mode = this._pageGrid.get(this.page) || 'none';
            gridBtn.textContent = mode === 'dots' ? '⁙' : '▦';
            gridBtn.classList.toggle('active', mode !== 'none');
            gridBtn.setAttribute('aria-pressed', String(mode !== 'none'));
            gridBtn.title = mode === 'none' ? 'پس‌زمینهٔ شطرنجی' : (mode === 'grid' ? 'پس‌زمینهٔ نقطه‌ای' : 'بدون پس‌زمینه');
        }
    }

    setPage(n, { broadcast = true } = {}) {
        n = Math.max(1, Math.min(this.pageCount, n));
        if (n === this.page) return;
        this.page = n;
        this._repaintPage();
        this._updatePageUI();
        // presenters take the whole class with them
        if (broadcast && this.canDraw) {
            this._sendOp({ type: 'page_go', page: n, id: this._id() });
        }
    }

    addPage() {
        if (!this.canDraw) return this._deny();
        const target = this.pageCount + 1;
        const op = { type: 'page_add', page: target, id: this._id() };
        // apply locally first (we are the actor — server echo is filtered out)
        this._applyOp(op);
        this._sendOp(op);
        this.setPage(target); // shared: everybody follows to the new page
        this._updatePageUI();
    }

    /** Re-render the current page from its recorded ops. */
    _repaintPage() {
        if (!this.canvas) return;
        this.canvas.clear();
        this._applyBg();
        for (const op of this._pageOps.get(this.page) || []) this._paintOp(op);
        this.canvas.requestRenderAll();
    }

    // ------------------------------------------------------------ page look
    _pageColor() {
        return this._pageColors.get(this.page) || '#ffffff';
    }

    /** Slightly darker shade of a hex colour — for grid lines on any bg. */
    _shade(hex, amt) {
        const n = parseInt(hex.slice(1), 16);
        const r = Math.max(0, Math.min(255, (n >> 16) + amt));
        const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
        const b = Math.max(0, Math.min(255, (n & 0xff) + amt));
        return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
    }

    /** Background: plain colour, or a repeating grid/dots pattern. */
    _applyBg() {
        const color = this._pageColor();
        const mode = this._pageGrid.get(this.page) || 'none';
        if (mode === 'none') {
            this.canvas.backgroundColor = color;
        } else {
            const cell = 28;
            const c = document.createElement('canvas');
            c.width = cell; c.height = cell;
            const ctx = c.getContext('2d');
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, cell, cell);
            const line = this._shade(color, -22);
            if (mode === 'grid') {
                ctx.strokeStyle = line;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, cell - 0.5); ctx.lineTo(cell, cell - 0.5);
                ctx.moveTo(cell - 0.5, 0); ctx.lineTo(cell - 0.5, cell);
                ctx.stroke();
            } else { // dots
                ctx.fillStyle = line;
                ctx.beginPath();
                ctx.arc(cell - 1.5, cell - 1.5, 1.5, 0, Math.PI * 2);
                ctx.fill();
            }
            this.canvas.backgroundColor = new fabric.Pattern({ source: c, repeat: 'repeat' });
        }
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

    // ------------------------------------------------------------ drawing
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
        if (this.tool === 'laser') return; // laser needs no down/up
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
                stroke: this.tool === 'eraser' ? this._pageColor() : this.color,
                strokeWidth: this.tool === 'eraser' ? this.width * 6 : this.width,
                strokeLineCap: 'round',
                strokeLineJoin: 'round',
                fill: '',
                opacity: this.tool === 'highlighter' ? 0.35 : 1,
                selectable: false,
                objectCaching: false,
            });
            this.liveShape._wbTool = this.tool;
            this.canvas.add(this.liveShape);
        } else if (['line', 'arrow', 'rectangle', 'circle'].includes(this.tool)) {
            this.liveShape = this._makeShape(this.tool, p, p);
            this.liveShape._wbTool = this.tool;
            this.canvas.add(this.liveShape);
        }
    }

    _move(opt) {
        if (this.tool === 'laser') {
            if (!this.canDraw) return;
            const now = Date.now();
            if (now - this._lastLaser < 60) return; // ~16 Hz max
            this._lastLaser = now;
            const p = { x: Math.round(opt.pointer.x), y: Math.round(opt.pointer.y) };
            this._showLaser(p.x, p.y);
            this._sendOp({ type: 'laser', page: this.page, x: p.x, y: p.y });
            return;
        }
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
        // record it (source of truth for page switches); the canvas paint
        // is idempotent and skips the object that is already there
        this._applyOp(op);
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

    // ------------------------------------------------------------ laser
    _showLaser(x, y) {
        const wrap = this._wrapEl();
        if (!wrap) return;
        let dot = wrap.querySelector('.laser-dot');
        if (!dot) {
            dot = document.createElement('div');
            dot.className = 'laser-dot';
            wrap.appendChild(dot);
        }
        dot.style.left = `${x}px`;
        dot.style.top = `${y}px`;
        dot.classList.remove('pulse');
        void dot.offsetWidth; // restart the animation
        dot.classList.add('pulse');
        clearTimeout(this._laserTimer);
        this._laserTimer = setTimeout(() => dot.remove(), 900);
    }

    // ------------------------------------------------------------ serialization
    _id() {
        return `${this.identity}-${Date.now()}-${++this.idCounter}`;
    }

    _serialize(obj) {
        const tool = obj._wbTool || 'pen';
        const common = { id: obj.data?.opId || this._id(), tool };
        if (obj.type === 'polyline') {
            return {
                type: 'draw', ...common,
                points: obj.points.map((p) => [Math.round(p.x), Math.round(p.y)]),
                color: tool === 'eraser' ? null : obj.stroke,
                width: obj.strokeWidth,
            };
        }
        if (obj.type === 'line') {
            return {
                type: 'draw', ...common,
                points: [[Math.round(obj.x1), Math.round(obj.y1)], [Math.round(obj.x2), Math.round(obj.y2)]],
                color: obj.stroke, width: obj.strokeWidth,
            };
        }
        if (obj.type === 'rect') {
            return {
                type: 'draw', ...common,
                left: Math.round(obj.left), top: Math.round(obj.top),
                width: Math.round(obj.width), height: Math.round(obj.height),
                color: obj.stroke, width: obj.strokeWidth,
            };
        }
        if (obj.type === 'ellipse') {
            return {
                type: 'draw', ...common,
                left: Math.round(obj.left), top: Math.round(obj.top),
                rx: Math.round(obj.rx), ry: Math.round(obj.ry),
                color: obj.stroke, width: obj.strokeWidth,
            };
        }
        return null;
    }

    // ------------------------------------------------------------ applying ops
    /** Record an op, track page state, paint it when it is visible. */
    _applyOp(op, actorName = '') {
        if (!op || !op.type) return;
        // file-tagged ops are presentation annotations — presentation.js owns them
        if (op.file_id) return;
        const pg = Math.max(1, parseInt(op.page || 1, 10) || 1);
        op = { ...op, page: pg };

        // ---- view ops (not page content) --------------------------------
        if (op.type === 'laser') {
            if (!this._replaying && pg === this.page) this._showLaser(op.x, op.y);
            return;
        }
        if (op.type === 'page_go') {
            if (this._replaying) {
                this.page = pg;                 // silent — repaint happens once
            } else {
                this.setPage(pg, { broadcast: false });
                if (actorName) {
                    import('./toast.js').then(({ toast }) =>
                        toast(`${actorName} به صفحهٔ ${pg} رفت.`, 'info', 2000));
                }
            }
            return;
        }
        if (op.type === 'page_add') {
            if (pg > this.pageCount) this.pageCount = pg;
            // NB: no page jump here — the actor switches in addPage() AFTER
            // the page_add op is on the wire, so remote peers never receive
            // a page_go for a page they don't know about yet.
            return;
        }
        if (op.type === 'page_setup') {
            if (op.color) this._pageColors.set(pg, op.color);
            if (op.grid) this._pageGrid.set(pg, op.grid);
            if (pg === this.page && !this._replaying) {
                this._applyBg();
                // recolour eraser strokes against the new background
                this._repaintPage();
                this._updatePageUI();
            }
            // keep it in the page ops so replay-after-clear still knows the style
            const list = this._pageOps.get(pg) || [];
            if (!list.some((o) => o.id === op.id)) list.push(op);
            this._pageOps.set(pg, list);
            return;
        }

        // ---- page content ------------------------------------------------
        const list = this._pageOps.get(pg) || [];
        if (op.type === 'clear') {
            // compaction (mirrors the server): keep page_add/page_setup markers
            this._pageOps.set(pg, list.filter((o) => o.type === 'page_setup'));
        } else if (op.type === 'remove') {
            this._pageOps.set(pg, list.filter((o) => o.id !== op.id));
        } else if (!list.some((o) => o.id === op.id)) {
            // Idempotency: an op may arrive both in the snapshot and live.
            list.push(op);
            this._pageOps.set(pg, list);
        }
        if (pg > this.pageCount) this.pageCount = pg;

        if (pg === this.page && !this._replaying) {
            if (op.type === 'clear') {
                this.canvas.clear();
                this._applyBg();
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
        const isEraser = op.tool === 'eraser';
        const common = {
            stroke: isEraser ? this._pageColor() : (op.color || '#000'),
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
        const head = new fabric.Polygon([b, p1, p2], { fill: common.stroke, stroke: common.stroke, selectable: false });
        head.set('data', { opId: op.id }); // removed together with the line
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
        const targets = this.canvas.getObjects().filter((o) => o.data?.opId === id);
        if (targets.length) this.canvas.remove(...targets);
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
