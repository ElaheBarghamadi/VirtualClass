/**
 * whiteboard.js — collaborative, multi-page whiteboard on Fabric.js.
 *
 * Synchronisation model: every stroke/shape/text/clear/page op is a
 * structured operation (JSON) sent over the whiteboard WebSocket — never
 * a canvas image.  The server validates permissions + shape, persists
 * the op (tagged with its page) and relays it; on connect we replay the
 * stored history page by page.
 *
 * Geometry
 * --------
 * The canvas has a FIXED internal coordinate system (``REF_W × REF_H``)
 * and a viewport transform that maps it onto whatever size the wrapper
 * has.  A stroke therefore keeps its place when the window is resized,
 * the side panel opens or the stage goes fullscreen — without repainting
 * a single object (a resize is one matrix write instead of a full
 * history replay).  Coordinates on the wire are normalised (0..1) with
 * ``norm: 1``, so they mean the same thing on every screen.
 *
 * Background
 * ----------
 * The page colour + grid/dots pattern live in a DOM layer *under* the
 * fabric canvas, and the canvas itself is transparent.  Two wins: the
 * grid is never re-drawn or erased with the ink, and the eraser can use
 * ``destination-out`` — it really rubs ink out (revealing the page
 * beneath it) instead of painting a fake stroke in the page colour.
 *
 * Load
 * ----
 * Everything that can be delayed, merged or skipped locally is:
 *   * one render per animation frame instead of one per pointer event,
 *   * pointer decimation (sub-pixel points are dropped before they ever
 *     reach the wire),
 *   * page background changes are coalesced into a single op/DB row,
 *   * the laser pointer is throttled and dropped while the socket is
 *     backed up,
 *   * ops produced while offline are queued and flushed once instead of
 *     being thrown away.
 *
 * Laser ops are ephemeral — relayed live, never stored.
 * Local undo/redo affects only this user's own operations.
 */

/** Internal drawing surface. All coordinates/shapes are expressed in it. */
const REF_W = 1200;
const REF_H = 700;
/** Minimum distance (in reference px) between two recorded stroke points. */
const POINT_EPSILON = 1.6;
/** Laser pointer updates: at most this often, and never while backed up. */
const LASER_MIN_MS = 80;
const WS_BUFFER_LIMIT = 16 * 1024;
/** Page background changes are merged over this window before being sent. */
const SETUP_DEBOUNCE_MS = 220;
const MAX_QUEUED_OPS = 200;
const MAX_UNDO = 60;

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
        this._replaying = false;   // history replay: record only, paint once
        this.canDraw = false;
        this.unavailable = false;  // fabric failed to load
        this.identity = null;
        this.retryDelay = 1000;
        // multi-page state
        this.page = 1;
        this.pageCount = 1;
        this._pageOps = new Map();    // page → ordered ops (source of truth for repaint)
        this._pageIds = new Map();    // page → Set(op id) — O(1) dedupe
        this._pageColors = new Map(); // page → '#rrggbb'
        this._pageGrid = new Map();   // page → 'none'|'grid'|'dots'
        // canvas objects currently painted, keyed by the op that owns them
        this._objects = new Map();    // opId → fabric object (or [objects])
        this._lastLaser = 0;
        this._laserTimer = null;
        this._outbox = [];            // ops produced while the socket was down
        this._pendingSetup = null;    // coalesced page_setup (colour/grid)
        this._setupTimer = null;
        this._renderQueued = false;
        this._resizeQueued = false;
        this._editor = null;          // inline text editor element
        this._editing = null;         // op being edited (text tool), if any
    }

    init({ roomCode, identity, canDraw }) {
        this.identity = identity;
        this.canDraw = canDraw;
        this._syncDrawGate();
        // Clear, permanent feedback for viewers who may not draw — instead of
        // a toolbar that looks usable but silently does nothing.

        if (typeof fabric === 'undefined') {
            this._showUnavailable('کتابخانهٔ تخته بارگذاری نشد. صفحه را تازه‌سازی کنید؛ اگر مشکل ادامه داشت، به پشتیبانی اطلاع دهید.');
            console.warn('[whiteboard] fabric.js is not loaded');
            return;
        }
        const el = document.getElementById('whiteboard-canvas');
        if (!el) {
            this._showUnavailable('بوم تخته پیدا نشد. صفحه را تازه‌سازی کنید.');
            return;
        }
        try {
            this.canvas = new fabric.Canvas(el, {
                // The page colour/pattern lives in the DOM layer below, so the
                // canvas must stay transparent (and the eraser can punch
                // through to the layer instead of faking a white stroke).
                backgroundColor: '',
                selection: false,
                isDrawingMode: false,
                preserveObjectStacking: true,
                // Rendering is driven by _render()/_scheduleRender(): adding a
                // hundred replay objects must not cause a hundred repaints.
                renderOnAddRemove: false,
                stopContextMenu: true,
            });
        } catch (err) {
            this._showUnavailable('بوم تخته ساخته نشد. صفحه را تازه‌سازی کنید؛ اگر مشکل ادامه داشت، به پشتیبانی اطلاع دهید.');
            console.error('[whiteboard] canvas initialization failed:', err);
            return;
        }
        this.unavailable = false;
        this._ensureBgLayer();
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
        this._bindKeys();
        this._connect(roomCode);
        this._syncEditState();
    }

    /**
     * Read-only viewers get a slimmed-down dock: drawing tools disappear
     * entirely (instead of turning grey), a «فقط نمایش» chip explains why, and
     * page navigation / fullscreen / save stay usable.
     */
    _syncDrawGate() {
        const on = Boolean(this.canDraw);
        document.querySelector('.wb-toolbar')?.classList.toggle('no-draw', !on);
        document.getElementById('wb-mode-chip')?.classList.toggle('hidden', on);
        document.getElementById('wb-nodraw-hint')?.classList.toggle('hidden', on);
        document.getElementById('view-whiteboard')?.classList.toggle('readonly', !on);
        if (!on) this._closeEditor();
    }

    _showUnavailable(message) {
        this.unavailable = true;
        const hint = document.getElementById('wb-error-hint');
        if (hint) {
            hint.textContent = message;
            hint.classList.remove('hidden');
        }
        document.querySelector('.wb-toolbar')?.classList.add('is-unavailable');
    }

    /** The element whose size the canvas should match (.wb-canvas-wrap). */
    _wrapEl() {
        // fabric wraps our <canvas> in .canvas-container (wrapperEl);
        // the layout parent of THAT is what we must measure.
        return this.canvas?.wrapperEl?.parentElement || null;
    }

    _w() { return (this.canvas && this.canvas.getWidth()) || 1; }
    _h() { return (this.canvas && this.canvas.getHeight()) || 1; }
    /** CSS px → reference units (the canvas' internal coordinate system). */
    _sx() { return this._w() / REF_W; }
    _sy() { return this._h() / REF_H; }

    // ------------------------------------------------------------ transport
    _connect(roomCode) {
        this._roomCode = roomCode;
        // Never keep two sockets alive: a duplicate reconnect timer would
        // otherwise leave the old one's close handler scheduling yet another.
        if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
            this.ws._retired = true;
            try { this.ws.close(); } catch { /* already gone */ }
        }
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        let ws;
        try {
            ws = new WebSocket(`${proto}://${location.host}/ws/classroom/${roomCode}/whiteboard/`);
        } catch (err) {
            console.warn('[whiteboard] socket failed', err);
            return;
        }
        this.ws = ws;
        ws.onopen = () => {
            this.retryDelay = 1000;
            // History is pushed by the server right after accept; the flush
            // waits for it so locally-kept ops are re-applied on top of the
            // snapshot instead of being wiped by it.
            clearTimeout(this._flushTimer);
            this._flushTimer = setTimeout(() => this._flushOutbox(), 2500);
        };
        ws.onclose = (evt) => {
            if (ws._retired) return;                              // replaced on purpose
            if (evt.code === 4401 || evt.code === 4403) return;   // never retry these
            setTimeout(() => this._connect(roomCode), this.retryDelay = Math.min(this.retryDelay * 2, 15000));
        };
        ws.onmessage = (evt) => {
            let data;
            try { data = JSON.parse(evt.data); } catch { return; }
            if (data.type === 'whiteboard_history') {
                this._pageOps.clear();
                this._pageIds.clear();
                this._pageColors.clear();
                this._pageGrid.clear();
                this._replaying = true;
                (data.events || []).forEach((e) => this._applyOp(e.op));
                this._replaying = false;
                this.page = Math.max(1, Math.min(this.pageCount, this.page));
                // one clean repaint for the page we end up on
                this._repaintPage();
                this._updatePageUI();
                this._syncEditState();
                clearTimeout(this._flushTimer);
                this._flushOutbox();
            } else if (data.type === 'whiteboard_operation') {
                if (data.actor_identity === this.identity) return; // already applied locally
                this._applyOp(data.op, data.actor_name);
                this._updatePageUI();
                this._syncEditState();
            } else if (data.type === 'error') {
                import('./toast.js').then(({ toast }) => toast(data.message || 'خطا در تخته.', 'error'));
            }
        };
    }

    /**
     * Send one op.  When the socket is down the op is queued instead of being
     * dropped: a two-second Wi-Fi hiccup must not erase what was just drawn.
     */
    _sendOp(op) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ action: 'op', op }));
            return true;
        }
        this._outbox.push(op);
        if (this._outbox.length > MAX_QUEUED_OPS) this._outbox.shift();
        return false;
    }

    /** Re-send ops produced while offline (once, in order). */
    _flushOutbox() {
        if (!this._outbox.length || this.ws?.readyState !== WebSocket.OPEN) return;
        const ops = this._outbox;
        this._outbox = [];
        for (const op of ops) {
            // The history snapshot may have dropped them: re-apply locally so
            // the drawing survives the reconnect (the server echo is filtered).
            if (op.type !== 'laser') this._applyOp(op);
            this.ws.send(JSON.stringify({ action: 'op', op }));
        }
        this._render();
    }

    // ------------------------------------------------------------ tools
    _bindToolbar() {
        // Scope strictly to OUR toolbar: the presentation toolbar reuses the
        // .wb-tool/.wb-action classes, and unscoped handlers used to fight
        // over `active` states (and set this.tool to undefined).
        document.querySelectorAll('.wb-toolbar .wb-tool').forEach((btn) => {
            btn.addEventListener('click', () => this.setTool(btn.dataset.tool));
        });
        document.querySelectorAll('.wb-toolbar .wb-action').forEach((btn) => {
            btn.addEventListener('click', () => this.run(btn.dataset.action));
        });
        document.getElementById('wb-color')?.addEventListener('input', (e) => { this.color = e.target.value; });
        document.getElementById('wb-width')?.addEventListener('input', (e) => { this.width = Number(e.target.value); });

        // page background colour — a colour-picker drag fires dozens of input
        // events; they are merged into ONE op (and one DB row).
        document.getElementById('wb-bg')?.addEventListener('input', (e) => {
            if (!this.canDraw) return this._deny();
            this._queueSetup({ color: e.target.value });
        });
        // grid style cycler: none → grid → dots → none
        document.getElementById('wb-grid')?.addEventListener('click', () => {
            if (!this.canDraw) return this._deny();
            const order = ['none', 'grid', 'dots'];
            const cur = this._pendingSetup?.grid || this._pageGrid.get(this.page) || 'none';
            const next = order[(order.indexOf(cur) + 1) % order.length];
            this._queueSetup({ grid: next }, { immediate: true });
        });
    }

    /** Activate a tool (also used by the keyboard shortcuts). */
    setTool(tool) {
        if (!tool) return;
        if (!this.canDraw && tool !== 'laser') return this._deny();
        this.tool = tool;
        document.querySelectorAll('.wb-toolbar .wb-tool').forEach((b) => {
            const on = b.dataset.tool === tool;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        const wrap = this._wrapEl();
        if (wrap) wrap.dataset.wbTool = tool;
    }

    /**
     * Page background/grid changes: applied locally at once (a CSS write) and
     * sent as one coalesced `page_setup` op once the user stops fiddling.
     */
    _queueSetup(patch, { immediate = false } = {}) {
        this._pendingSetup = { ...(this._pendingSetup || {}), ...patch };
        const page = this.page;
        if (patch.color) this._pageColors.set(page, patch.color);
        if (patch.grid) this._pageGrid.set(page, patch.grid);
        this._applyBg();
        clearTimeout(this._setupTimer);
        this._setupTimer = setTimeout(() => this._commitSetup(), immediate ? 0 : SETUP_DEBOUNCE_MS);
    }

    _commitSetup() {
        clearTimeout(this._setupTimer);
        const pending = this._pendingSetup;
        this._pendingSetup = null;
        if (!pending) return;
        const op = { type: 'page_setup', page: this.page, id: this._id(), ...pending };
        this._applyOp(op);
        this._sendOp(op);
    }

    _bindPages() {
        document.getElementById('wb-prev')?.addEventListener('click', () => this.setPage(this.page - 1));
        document.getElementById('wb-next')?.addEventListener('click', () => this.setPage(this.page + 1));
        document.getElementById('wb-new-page')?.addEventListener('click', () => this.addPage());
        document.getElementById('wb-save')?.addEventListener('click', () => this.exportPNG());
    }

    _bindKeys() {
        document.addEventListener('keydown', (e) => this._onKey(e));
    }

    _visible() {
        const view = document.getElementById('view-whiteboard');
        return !!view && !view.classList.contains('hidden');
    }

    _onKey(e) {
        if (!this._visible() || !this.canvas) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        if (e.altKey) return;
        const mod = e.ctrlKey || e.metaKey;
        const key = (e.key || '').toLowerCase();

        if (mod) {
            if (key === 'z' && !e.shiftKey) { e.preventDefault(); this.run('undo'); }
            else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); this.run('redo'); }
            return;
        }
        const tools = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'laser', t: 'text' };
        if (tools[key]) {
            e.preventDefault();
            this.setTool(tools[key]);
            return;
        }
        if (key === 'escape') {
            if (this._editing) this._closeEditor(true);
            else this._cancelStroke();
        }
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
            // The button is icon-based (SVG); only legacy glyph buttons get
            // their label rewritten — otherwise textContent would wipe the icon.
            if (!gridBtn.querySelector('svg')) {
                // Tiny inline glyphs, not emoji: grid = squares, dots = dots.
                gridBtn.innerHTML = mode === 'dots'
                    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="7" r="1.6"/><circle cx="12" cy="7" r="1.6"/><circle cx="17" cy="7" r="1.6"/><circle cx="7" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="17" cy="12" r="1.6"/><circle cx="7" cy="17" r="1.6"/><circle cx="12" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/></svg>'
                    : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.2"/><rect x="13" y="4" width="7" height="7" rx="1.2"/><rect x="4" y="13" width="7" height="7" rx="1.2"/><rect x="13" y="13" width="7" height="7" rx="1.2"/></svg>';
            }
            gridBtn.classList.toggle('active', mode !== 'none');
            gridBtn.setAttribute('aria-pressed', String(mode !== 'none'));
            gridBtn.title = mode === 'none' ? 'پس‌زمینهٔ شطرنجی (G)' : (mode === 'grid' ? 'پس‌زمینهٔ نقطه‌ای' : 'بدون پس‌زمینه');
        }
        this._syncEditState();
    }

    /** Undo/redo buttons mirror what is actually available on this page. */
    _syncEditState() {
        const hasUndo = this.myUndo.some((o) => o.page === this.page);
        const hasRedo = this.myRedo.some((o) => o.page === this.page);
        const undo = document.querySelector('.wb-toolbar [data-action="undo"]');
        const redo = document.querySelector('.wb-toolbar [data-action="redo"]');
        if (undo) { undo.disabled = !hasUndo || !this.canDraw; undo.setAttribute('aria-disabled', String(undo.disabled)); }
        if (redo) { redo.disabled = !hasRedo || !this.canDraw; redo.setAttribute('aria-disabled', String(redo.disabled)); }
    }

    setPage(n, { broadcast = true } = {}) {
        n = Math.max(1, Math.min(this.pageCount, n));
        if (n === this.page) return;
        if (this._editing) this._commitEditor();   // keep a label typed on this page
        this._commitSetup();   // don't carry a background change to another page
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

    /** Re-render the current page from its recorded ops (one render pass). */
    _repaintPage() {
        if (!this.canvas) return;
        this.canvas.clear();
        this._objects.clear();
        this._applyBg();
        for (const op of this._pageOps.get(this.page) || []) this._paintOp(op);
        this._render();
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

    /** The DOM layer painted behind the (transparent) fabric canvas. */
    _ensureBgLayer() {
        const wrap = this._wrapEl();
        if (!wrap) return null;
        let el = wrap.querySelector('.wb-bg');
        if (!el) {
            el = document.createElement('div');
            el.className = 'wb-bg';
            el.setAttribute('aria-hidden', 'true');
            wrap.insertBefore(el, wrap.firstChild);
        }
        return el;
    }

    /**
     * Paint the page background.  This is a CSS write on a div — no canvas
     * work at all — so changing the colour or grid is instant and free.
     */
    _applyBg() {
        const el = this._ensureBgLayer();
        if (!el) return;
        const color = this._pageColor();
        const mode = this._pageGrid.get(this.page) || 'none';
        el.style.backgroundColor = color;
        el.style.setProperty('--wb-line', this._shade(color, -26));
        el.classList.toggle('grid', mode === 'grid');
        el.classList.toggle('dots', mode === 'dots');
    }

    /** Export the visible page as a downloadable PNG (background included). */
    exportPNG() {
        if (!this.canvas) return;
        const mult = 2;
        const outW = Math.max(1, Math.round(this._w() * mult));
        const outH = Math.max(1, Math.round(this._h() * mult));
        // Ink goes on its own transparent layer first: eraser strokes are
        // `destination-out`, so they must punch holes in the ink only — if the
        // page background were already under them, they would erase it too.
        const art = document.createElement('canvas');
        art.width = outW;
        art.height = outH;
        const actx = art.getContext('2d');
        actx.save();
        actx.setTransform(outW / REF_W, 0, 0, outH / REF_H, 0, 0);
        for (const obj of this.canvas.getObjects()) {
            try { obj.render(actx); } catch (err) { console.warn('[whiteboard] export: object skipped', err); }
        }
        actx.restore();

        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        const ctx = out.getContext('2d');
        this._paintBg(ctx, outW, outH, mult);
        ctx.drawImage(art, 0, 0);

        const a = document.createElement('a');
        a.href = out.toDataURL('image/png');
        a.download = `whiteboard-page-${this.page}.png`;
        a.click();
    }

    /** Draw colour + grid/dots into a 2d context (used by the PNG export). */
    _paintBg(ctx, w, h, scale) {
        const color = this._pageColor();
        const mode = this._pageGrid.get(this.page) || 'none';
        const line = this._shade(color, -26);
        const cell = 28 * scale;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, w, h);
        if (mode === 'none') return;
        if (mode === 'grid') {
            ctx.strokeStyle = line;
            ctx.lineWidth = Math.max(1, scale);
            ctx.beginPath();
            for (let x = cell; x < w; x += cell) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
            for (let y = cell; y < h; y += cell) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
            ctx.stroke();
        } else {
            ctx.fillStyle = line;
            for (let x = cell; x < w; x += cell) {
                for (let y = cell; y < h; y += cell) {
                    ctx.beginPath();
                    ctx.arc(x, y, 1.5 * scale, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }
    }

    // ------------------------------------------------------------ drawing
    _bindDrawing() {
        this.canvas.on('mouse:down', (opt) => this._down(opt));
        this.canvas.on('mouse:move', (opt) => this._move(opt));
        this.canvas.on('mouse:up', () => this._up());
        this.canvas.on('mouse:dblclick', (opt) => this._dblclick(opt));
        // A touch/pen pointer can be lifted outside Fabric's canvas element.
        // Finish the stroke on the window too; _up() safely ignores duplicates.
        const finishStroke = () => this._up();
        window.addEventListener('mouseup', finishStroke);
        window.addEventListener('pointerup', finishStroke);
        window.addEventListener('pointercancel', finishStroke);
        window.addEventListener('touchend', finishStroke, { passive: true });
    }

    _deny(reason = 'برای حساب شما نوشتن روی تخته فعال نیست. از مالک کلاس بخواهید مجوز «تختهٔ اشتراکی» را روشن کند و در صورت نیاز تنظیمات کلاس را بررسی کند.') {
        if (!this._warned) {
            import('./toast.js').then(({ toast }) => toast(reason, 'warning'));
            this._warned = true;
            setTimeout(() => { this._warned = false; }, 4000);
        }
        return false;
    }

    /**
     * Pointer position in REFERENCE coordinates.
     *
     * `opt.pointer` is the raw position inside the canvas element (CSS px);
     * `opt.absolutePointer` is the same point with the viewport transform
     * undone — which is the space every object lives in.  Using `pointer`
     * here drew the ink at 0.8× of where the user actually clicked.
     */
    _pt(opt) {
        const abs = opt?.absolutePointer;
        if (abs) return { x: abs.x, y: abs.y };
        const p = opt?.pointer || { x: 0, y: 0 };
        return { x: p.x * (REF_W / this._w()), y: p.y * (REF_H / this._h()) };
    }

    /** Current pen width in reference units (the slider is in CSS px). */
    _penWidth() {
        return Math.max(0.5, this.width * (REF_H / this._h()));
    }

    _down(opt) {
        if (!this.canDraw) return this._deny();
        if (this.tool === 'laser') return; // laser needs no down/up
        const p = this._pt(opt);

        if (this.tool === 'text') {
            this._openEditor(p);
            return;
        }

        this.drawing = true;
        this.startPoint = p;
        const isStroke = this.tool === 'pen' || this.tool === 'highlighter' || this.tool === 'eraser';
        if (isStroke) {
            this.liveShape = this._makeStroke(this.tool, p);
            this.canvas.add(this.liveShape);
            this._scheduleRender();
        } else if (['line', 'arrow', 'rectangle', 'circle'].includes(this.tool)) {
            this.liveShape = this._makeShape(this.tool, p, p);
            this.liveShape._wbTool = this.tool;
            this.canvas.add(this.liveShape);
            this._scheduleRender();
        }
    }

    /** A fresh live stroke in the current tool's style. */
    _makeStroke(tool, p) {
        const opaque = {
            selectable: false,
            evented: false,
            objectCaching: false,
            strokeLineCap: 'round',
            strokeLineJoin: 'round',
            fill: '',
            strokeWidth: tool === 'eraser' ? this._penWidth() * 6 : this._penWidth(),
        };
        let shape;
        if (tool === 'eraser') {
            // destination-out really removes ink: the (transparent) canvas is
            // punched through and the page background below shows up again.
            shape = new fabric.Polyline([p, p], {
                ...opaque,
                stroke: 'rgba(0,0,0,1)',
                globalCompositeOperation: 'destination-out',
            });
        } else {
            shape = new fabric.Polyline([p, p], {
                ...opaque,
                stroke: this.color,
                opacity: tool === 'highlighter' ? 0.35 : 1,
            });
        }
        shape._wbTool = tool;
        return shape;
    }

    _move(opt) {
        if (this.tool === 'laser') {
            if (!this.canDraw) return;
            const p = this._pt(opt);
            const now = (window.performance || Date).now();
            // Feedback first (it is local and free), then maybe tell the room.
            this._showLaser(p.x * this._sx(), p.y * this._sy());
            if (now - this._lastLaser < LASER_MIN_MS) return;
            this._lastLaser = now;
            if ((this.ws?.bufferedAmount || 0) > WS_BUFFER_LIMIT) return; // socket is behind: drop this frame
            this._sendOp({
                type: 'laser', page: this.page, norm: 1,
                x: +(p.x / REF_W).toFixed(4), y: +(p.y / REF_H).toFixed(4),
            });
            return;
        }
        if (!this.drawing || !this.liveShape) return;
        const p = this._pt(opt);
        if (this.liveShape.type === 'polyline') {
            const pts = this.liveShape.points;
            const last = pts[pts.length - 1];
            // Decimation: sub-epsilon movement adds nothing but bytes.
            if (last && Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < POINT_EPSILON) return;
            pts.push(p);
            this.liveShape.set({ points: pts });
            this._scheduleRender();
        } else {
            this._updateShape(this.liveShape, this.startPoint, p);
        }
    }

    _cancelStroke() {
        if (!this.drawing) return;
        if (this.liveShape) this.canvas.remove(this.liveShape);
        this.liveShape = null;
        this.drawing = false;
        this._render();
    }

    _up() {
        if (!this.drawing || !this.liveShape) { this.drawing = false; return; }
        const obj = this.liveShape;
        this.liveShape = null;
        this.drawing = false;

        const op = this._serialize(obj);
        if (!op || this._degenerate(op)) { this.canvas.remove(obj); this._render(); return; }
        op.page = this.page;
        obj.set('data', { opId: op.id });
        // Register the live object under its op id so applying the op does
        // not paint a duplicate on top of it.
        this._index(op.id, obj);
        this._applyOp(op);
        this._sendOp(op);
        this._pushUndo(op);
        this._render();
    }

    /**
     * A tap that never moved (or a zero-size box) is not worth an op, a
     * server row and a broadcast to the whole class.
     */
    _degenerate(op) {
        if (op.type !== 'draw') return false;
        if (op.points) {
            const span = Math.abs(op.points[0][0] - op.points[op.points.length - 1][0])
                + Math.abs(op.points[0][1] - op.points[op.points.length - 1][1]);
            if (span < 0.002) return true;   // < ~2px on a 1000px-wide board
        }
        if (op.w !== undefined && op.w < 0.002 && op.h < 0.002) return true;
        if (op.rx !== undefined && op.rx < 0.002 && op.ry < 0.002) return true;
        return false;
    }

    _makeShape(tool, a, b) {
        const common = {
            stroke: this.color,
            strokeWidth: this._penWidth(),
            fill: '',
            selectable: false,
            evented: false,
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
        this._scheduleRender();
    }

    // ------------------------------------------------------------ text tool
    /**
     * Inline text entry instead of a `prompt()`: the label is typed right
     * where it will land, in the current colour, and Enter commits it.
     */
    _editorEl() {
        if (this._editor && this._editor.isConnected) return this._editor;
        const wrap = this._wrapEl();
        if (!wrap) return null;
        let box = wrap.querySelector('#wb-text-edit');
        if (!box) {
            box = document.createElement('div');
            box.id = 'wb-text-edit';
            box.className = 'wb-text-edit hidden';
            box.innerHTML = '<input type="text" id="wb-text-input" maxlength="500" autocomplete="off" spellcheck="false" aria-label="متن روی تخته">';
            wrap.appendChild(box);
        }
        const input = box.querySelector('input');
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); this._commitEditor(); }
            else if (e.key === 'Escape') { e.preventDefault(); this._closeEditor(true); }
        });
        // Clicking anywhere else commits what was typed — the same muscle
        // memory as editing a cell in a spreadsheet.
        input.addEventListener('blur', () => { if (this._editing) this._commitEditor(); });
        box.addEventListener('pointerdown', (e) => e.stopPropagation());
        box.addEventListener('mousedown', (e) => e.stopPropagation());
        this._editor = box;
        return box;
    }

    _openEditor(point, { text = '', replaceId = null } = {}) {
        const box = this._editorEl();
        if (!box || !this.canvas) return;
        const input = box.querySelector('input');
        const fontSizeWorld = 18 + this.width * 2;
        this._editing = { point, replaceId, fontSizeWorld };
        box.classList.remove('hidden');
        box.style.left = '0px';
        box.style.top = '0px';
        // Measure first, then clamp: tapping near the right edge (or on a
        // phone) used to push the typing box outside the board.
        const bw = box.offsetWidth || 180;
        const left = Math.max(2, Math.min(this._w() - bw - 2, point.x * this._sx()));
        const top = Math.max(2, Math.min(this._h() - 24, point.y * this._sy()));
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.setProperty('--wb-text-color', replaceId ? (this._opById(replaceId)?.color || this.color) : this.color);
        box.style.fontSize = `${Math.max(12, fontSizeWorld * this._sy())}px`;
        input.value = text;
        // Focus on the next task: the pointerdown that opened the editor is
        // still running, and the browser's default action for it moves focus
        // to <body> — which used to swallow every keystroke.
        setTimeout(() => { if (this._editing) { input.focus(); input.select(); } }, 20);
    }

    _opById(id) {
        for (const list of this._pageOps.values()) {
            const hit = list.find((o) => o.id === id);
            if (hit) return hit;
        }
        return null;
    }

    _closeEditor(clearOnly = false) {
        const box = this._editor;
        if (box) {
            box.classList.add('hidden');
            const input = box.querySelector('input');
            if (input) input.value = '';
        }
        this._editing = null;
        if (clearOnly) this.canvas?.requestRenderAll();
    }

    _commitEditor() {
        const state = this._editing;
        const box = this._editor;
        if (!state || !box) return;
        const input = box.querySelector('input');
        const text = (input?.value || '').trim().slice(0, 500);
        if (!text) return this._closeEditor(true);
        const { point, replaceId, fontSizeWorld } = state;
        this._closeEditor(true);
        if (replaceId) {
            const remove = { type: 'remove', id: replaceId, page: this.page };
            this._applyOp(remove);
            this._sendOp(remove);
        }
        const op = {
            type: 'text', id: this._id(), page: this.page, norm: 1,
            x: +(point.x / REF_W).toFixed(4), y: +(point.y / REF_H).toFixed(4),
            text, color: this.color, size: +fontSizeWorld.toFixed(1),
        };
        this._applyOp(op);
        this._sendOp(op);
        this._pushUndo(op);
    }

    /** Double-click an existing label to rewrite it. */
    _dblclick(opt) {
        if (!this.canDraw || !opt?.target) return;
        const id = opt.target.data?.opId;
        if (!id) return;
        const op = this._opById(id);
        if (!op || op.type !== 'text') return;
        const point = op.norm
            ? { x: op.x * REF_W, y: op.y * REF_H }
            : { x: op.x * (REF_W / this._w()), y: op.y * (REF_H / this._h()) };
        this.setTool('text');
        this._openEditor(point, { text: op.text, replaceId: id });
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
        // Coordinates travel NORMALISED (0..1 of the reference surface) so the
        // same op renders in the same relative place on any screen size.
        // `norm:1` marks new ops; legacy pixel ops render 1:1.
        const nx = (v) => +(v / REF_W).toFixed(4);
        const ny = (v) => +(v / REF_H).toFixed(4);
        const tool = obj._wbTool || 'pen';
        const common = {
            id: obj.data?.opId || this._id(), tool, norm: 1,
            // Server cap is 512; a huge window on a tiny screen could exceed it.
            width: +Math.min(512, Math.max(0.4, Number(obj.strokeWidth) || 1)).toFixed(2),
        };
        if (obj.type === 'polyline') {
            // The live shape starts as [p, p]; repeated points cost bytes on
            // the wire, in the DB and on every future replay.
            const pts = [];
            for (const pt of obj.points || []) {
                const x = nx(pt.x), y = ny(pt.y);
                const last = pts[pts.length - 1];
                if (last && Math.abs(last[0] - x) < 0.0008 && Math.abs(last[1] - y) < 0.0008) continue;
                pts.push([x, y]);
            }
            if (pts.length < 2) return null;
            return {
                type: 'draw', ...common,
                points: pts,
                color: tool === 'eraser' ? null : obj.stroke,
            };
        }
        if (obj.type === 'line') {
            return {
                type: 'draw', ...common,
                points: [[nx(obj.x1), ny(obj.y1)], [nx(obj.x2), ny(obj.y2)]],
                color: obj.stroke,
            };
        }
        if (obj.type === 'rect') {
            // NB: shape size uses w/h — the `width` key is the STROKE width
            // (a legacy duplicate-key bug had collapsed the two).
            return {
                type: 'draw', ...common,
                left: nx(obj.left), top: ny(obj.top),
                w: nx(obj.width), h: ny(obj.height),
                color: obj.stroke,
            };
        }
        if (obj.type === 'ellipse') {
            return {
                type: 'draw', ...common,
                left: nx(obj.left), top: ny(obj.top),
                rx: nx(obj.rx), ry: ny(obj.ry),
                color: obj.stroke,
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
            if (!this._replaying && pg === this.page) {
                let { x, y } = op;
                if (op.norm) {
                    // Normalised → this canvas' CSS pixels.
                    x *= this._w(); y *= this._h();
                }
                // (Legacy pixel ops are CSS pixels of the sender: use as-is.)
                this._showLaser(x, y);
            }
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
            if (pg === this.page && !this._replaying) this._applyBg();
            // keep it in the page ops so replay-after-clear still knows the style
            if (!this._hasOp(pg, op.id)) this._addOp(pg, op);
            return;
        }

        // ---- page content ------------------------------------------------
        if (op.type === 'clear') {
            // compaction (mirrors the server): keep page_setup markers
            const kept = (this._pageOps.get(pg) || []).filter((o) => o.type === 'page_setup');
            this._pageOps.set(pg, kept);
            this._pageIds.set(pg, new Set(kept.map((o) => o.id)));
        } else if (op.type === 'remove') {
            // The op leaves the replay history; it is not itself recorded.
            this._dropOp(pg, op.id);
        } else if (!this._hasOp(pg, op.id)) {
            // Idempotency: an op may arrive both in the snapshot and live.
            this._addOp(pg, op);
        }
        if (pg > this.pageCount) this.pageCount = pg;

        if (pg === this.page && !this._replaying) {
            if (op.type === 'clear') {
                this.canvas.clear();
                this._objects.clear();
                this._applyBg();
                this.myUndo = [];
                this.myRedo = [];
                this._syncEditState();
                this._render();
            } else if (op.type === 'remove') {
                this._removeById(op.id);
            } else {
                this._paintOp(op);
                this._scheduleRender();
            }
        }
    }

    _hasOp(page, id) {
        if (!id) return false;
        return this._pageIds.get(page)?.has(id) || false;
    }

    _addOp(page, op) {
        const list = this._pageOps.get(page) || [];
        list.push(op);
        this._pageOps.set(page, list);
        let ids = this._pageIds.get(page);
        if (!ids) { ids = new Set(); this._pageIds.set(page, ids); }
        if (op.id) ids.add(op.id);
    }

    _dropOp(page, id) {
        const list = this._pageOps.get(page) || [];
        const next = list.filter((o) => o.id !== id);
        if (next.length !== list.length) this._pageOps.set(page, next);
        this._pageIds.get(page)?.delete(id);
    }

    /** Canvas-level rendering of a single op (current page assumed). */
    _paintOp(op) {
        if (!op.id || !this._objects) return;
        if (this._objects.has(op.id)) return;    // already on screen (O(1) dedupe)
        if (op.type === 'text') {
            const n = !!op.norm;
            const x = n ? op.x * REF_W : op.x * (REF_W / this._w());
            const y = n ? op.y * REF_H : op.y * (REF_H / this._h());
            const size = n ? (op.size || 20) : (op.size || 20) * (REF_H / this._h());
            const text = new fabric.Text(op.text, {
                left: x,
                top: y,
                fill: op.color || '#111827',
                fontSize: size,
                selectable: false,
                evented: false,
            });
            text.set('data', { opId: op.id });
            this.canvas.add(text);
            this._index(op.id, text);
            return;
        }
        if (op.type === 'draw') {
            const obj = this._opToShape(op);
            if (!obj) return;
            obj.set('data', { opId: op.id });
            this.canvas.add(obj);
            this._index(op.id, obj);
            if (op.tool === 'arrow') this._addArrowHead(op, obj);
        }
    }

    _index(opId, obj) {
        const cur = this._objects.get(opId);
        if (!cur) this._objects.set(opId, [obj]);
        else if (Array.isArray(cur)) cur.push(obj);
        else this._objects.set(opId, [cur, obj]);
    }

    _opToShape(op) {
        const isEraser = op.tool === 'eraser';
        // New ops (norm:1) carry 0..1 coordinates of the reference surface;
        // legacy ops carry CSS px of whatever size the sender had.
        const n = !!op.norm;
        const px = (v, dim) => (n ? v * dim : v * (dim / (dim === REF_W ? this._w() : this._h())));
        const common = {
            stroke: isEraser ? 'rgba(0,0,0,1)' : (op.color || '#000'),
            strokeWidth: Math.max(0.4, op.width || 3),
            fill: '',
            selectable: false,
            evented: false,
            objectCaching: isEraser ? false : true,
            strokeLineCap: 'round',
            strokeLineJoin: 'round',
        };
        if (isEraser) common.globalCompositeOperation = 'destination-out';

        switch (op.tool) {
            case 'pen':
            case 'highlighter':
            case 'eraser': {
                const pts = (op.points || []).map(([x, y]) => ({ x: px(x, REF_W), y: px(y, REF_H) }));
                if (pts.length < 2) return null;
                return new fabric.Polyline(pts, {
                    ...common,
                    opacity: op.tool === 'highlighter' ? 0.35 : 1,
                });
            }
            case 'line':
            case 'arrow': {
                const [a, b] = op.points || [[0, 0], [0, 0]];
                const A = { x: px(a[0], REF_W), y: px(a[1], REF_H) };
                const B = { x: px(b[0], REF_W), y: px(b[1], REF_H) };
                return new fabric.Line([A.x, A.y, B.x, B.y], common);
            }
            case 'rectangle': {
                const w = op.w !== undefined ? px(op.w, REF_W) : (op.width || 0);
                const h = op.h !== undefined ? px(op.h, REF_H) : (op.height || 0);
                return new fabric.Rect({ left: px(op.left, REF_W), top: px(op.top, REF_H), width: w, height: h, ...common });
            }
            case 'circle':
                return new fabric.Ellipse({ left: px(op.left, REF_W), top: px(op.top, REF_H), rx: px(op.rx, REF_W), ry: px(op.ry, REF_H), ...common });
            default:
                return null;
        }
    }

    /** Arrow heads are extra objects that belong to the line's op id. */
    _addArrowHead(op, line) {
        const a = { x: line.x1, y: line.y1 };
        const b = { x: line.x2, y: line.y2 };
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const size = 8 + (line.strokeWidth || 3) * 2;
        const p1 = { x: b.x - size * Math.cos(angle - Math.PI / 7), y: b.y - size * Math.sin(angle - Math.PI / 7) };
        const p2 = { x: b.x - size * Math.cos(angle + Math.PI / 7), y: b.y - size * Math.sin(angle + Math.PI / 7) };
        const head = new fabric.Polygon([b, p1, p2], {
            fill: line.stroke, stroke: line.stroke, selectable: false, evented: false,
        });
        head.set('data', { opId: op.id }); // removed together with the line
        this.canvas.add(head);
        this._index(op.id, head);
    }

    // ------------------------------------------------------------ actions
    run(action) {
        if (action === 'undo') {
            if (!this.canDraw) return this._deny();
            // undo only touches this user's ops on the CURRENT page
            for (let i = this.myUndo.length - 1; i >= 0; i--) {
                if (this.myUndo[i].page !== this.page) continue;
                const [op] = this.myUndo.splice(i, 1);
                this._applyOp({ type: 'remove', id: op.id, page: this.page });
                this._sendOp({ type: 'remove', id: op.id, page: this.page });
                this.myRedo.push(op);
                this._syncEditState();
                return;
            }
            this._syncEditState();
        } else if (action === 'redo') {
            if (!this.canDraw) return this._deny();
            for (let i = this.myRedo.length - 1; i >= 0; i--) {
                if (this.myRedo[i].page !== this.page) continue;
                const [op] = this.myRedo.splice(i, 1);
                this._applyOp(op);
                this._sendOp(op);
                this.myUndo.push(op);
                this._syncEditState();
                return;
            }
            this._syncEditState();
        } else if (action === 'clear') {
            if (!this.canDraw) return this._deny();
            if (!confirm('فقط صفحهٔ جاری برای همه پاک شود؟')) return;
            const op = { type: 'clear', id: this._id(), page: this.page };
            this._applyOp(op);
            this._sendOp(op);
            this._syncEditState();
        }
    }

    _removeById(id) {
        const targets = this._objects.get(id);
        if (targets) {
            const list = Array.isArray(targets) ? targets : [targets];
            if (list.length) this.canvas.remove(...list);
            this._objects.delete(id);
            this._scheduleRender();
        }
    }

    _pushUndo(op) {
        this.myUndo.push(op);
        this.myRedo = [];
        if (this.myUndo.length > MAX_UNDO) this.myUndo.shift();
        this._syncEditState();
    }

    // ------------------------------------------------------------ rendering
    _render() {
        if (this.canvas) this.canvas.requestRenderAll();
    }

    /** At most one render per animation frame — pointer events can outpace 60 Hz. */
    _scheduleRender() {
        if (this._renderQueued) return;
        this._renderQueued = true;
        const run = () => {
            this._renderQueued = false;
            this._render();
        };
        if (window.requestAnimationFrame) window.requestAnimationFrame(run);
        else setTimeout(run, 16);
    }

    resize() {
        // Coalesced: ResizeObserver fires on every pixel while a panel is
        // dragged, and a repaint per event made the board feel heavy.
        if (this._resizeQueued) return;
        this._resizeQueued = true;
        const run = () => { this._resizeQueued = false; this._resizeNow(); };
        if (window.requestAnimationFrame) window.requestAnimationFrame(run);
        else setTimeout(run, 16);
    }

    _resizeNow() {
        if (!this.canvas) return;
        const wrap = this._wrapEl();
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;
        const changed =
            Math.abs(this.canvas.getWidth() - rect.width) > 0.5 ||
            Math.abs(this.canvas.getHeight() - rect.height) > 0.5;
        if (!changed) return;
        this.canvas.setDimensions({ width: rect.width, height: rect.height });
        // Nothing is re-drawn: the fixed reference surface is simply mapped
        // onto the new size, so every stroke keeps its relative place.
        this.canvas.setViewportTransform([rect.width / REF_W, 0, 0, rect.height / REF_H, 0, 0]);
        this._render();
    }

    setPermission(canDraw) {
        // Live grant/revoke: the dock and the «فقط نمایش» chip must flip
        // immediately, otherwise a newly-authorized user still faces a
        // locked board (and a revoked one keeps drawing tools).
        this.canDraw = canDraw;
        this._syncDrawGate();
        if (this.canvas) this.canvas.selection = canDraw;
        this._syncEditState();
    }
}

/** Reference surface used to normalise coordinates and stroke sizes. */
WhiteboardImpl.REF_W = REF_W;
WhiteboardImpl.REF_H = REF_H;

export const Whiteboard = new WhiteboardImpl();
