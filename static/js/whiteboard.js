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
 * The page is a FIXED rectangle (``refW × refH``, 12:7 by default) and it keeps
 * that shape on *every* device.  The presenter may pick another format from the
 * toolbar and the room is told over the presence socket, but the numbers are
 * room-wide — never per screen.  The viewport transform is a single uniform scale
 * (``_fit()``, the smaller of the two axes) and the leftover space becomes an
 * even letterbox on both sides.  Scaling x and y independently — the old
 * behaviour — stretched the board to whatever the wrapper happened to be, so
 * the same lesson looked 1.7:1 on a laptop and 0.6:1 on a phone and a stroke
 * drawn on one looked wrong on the other.  A resize is still one matrix write
 * (no repaint, no history replay) and nothing on the wire changes: coordinates
 * are normalised (0..1) with ``norm: 1``.
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

/**
 * A polyline that DRAWS as a smooth curve.
 *
 * Handwriting is a stream of sampled points; joining them with straight
 * segments is what makes ink look like a polygon, especially on quick strokes
 * where samples are far apart.  This subclass keeps fabric's point list (and
 * therefore the stored op, the payload size and the eraser's z-order) exactly
 * as before, but renders the path as quadratic curves through the midpoints —
 * the standard "curve through sample midpoints" trick.  Corner fidelity is
 * kept by ending with a straight segment to the newest point, so the ink
 * always reaches the pen tip.
 */
let _SmoothPolyline = null;

/**
 * The subclass is created on first use: `fabric` is fetched on demand (see
 * vendor.js), so importing this module must not touch it.  Creating it once and
 * caching the class keeps identical behaviour with one extra check per stroke.
 */
function SmoothPolylineClass() {
    if (_SmoothPolyline) return _SmoothPolyline;
    _SmoothPolyline = fabric.util.createClass(fabric.Polyline, {
    type: 'polyline',   // keep the base type: serialisers/checks stay valid
    commonRender(ctx) {
        const pts = this.points;
        const n = pts.length;
        if (!n || isNaN(pts[n - 1].y)) return false;
        const ox = this.pathOffset.x;
        const oy = this.pathOffset.y;
        ctx.beginPath();
        ctx.moveTo(pts[0].x - ox, pts[0].y - oy);
        if (n === 2) {
            ctx.lineTo(pts[1].x - ox, pts[1].y - oy);
            return true;
        }
        for (let i = 1; i < n - 1; i++) {
            const mx = (pts[i].x + pts[i + 1].x) / 2 - ox;
            const my = (pts[i].y + pts[i + 1].y) / 2 - oy;
            ctx.quadraticCurveTo(pts[i].x - ox, pts[i].y - oy, mx, my);
        }
        ctx.lineTo(pts[n - 1].x - ox, pts[n - 1].y - oy);
        return true;
    },
    });
    return _SmoothPolyline;
}

/** Default drawing surface. All coordinates/shapes are expressed in it. */
const REF_W = 1200;
const REF_H = 700;
/** Reference-surface bounds; the server (classrooms/board.py) owns the presets. */
const MIN_REF = 480;
const MAX_REF = 2000;
const BOARD_PRESETS = {
    '12:7': [1200, 700],
    '16:9': [1244, 700],
    '4:3': [1200, 900],
    '1:1': [1200, 1200],
    a4: [1200, 1697],
};
/** Minimum distance (in reference px) between two recorded stroke points. */
const POINT_EPSILON = 1.6;
/** Laser pointer updates: at most this often, and never while backed up. */
const LASER_MIN_MS = 80;
const WS_BUFFER_LIMIT = 16 * 1024;
/** Page background changes are merged over this window before being sent. */
const SETUP_DEBOUNCE_MS = 220;
const MAX_QUEUED_OPS = 200;
/** Server-side limits mirrored here (whiteboard/consumers.py): a stroke that
 *  breaks them would be rejected for the whole class but stay on the author's
 *  screen, so it is thinned before it is sent. */
const MAX_OP_POINTS = 1200;
const MAX_PAGES = 999;
const MAX_UNDO = 60;
/** Zoom is magnification of the reference surface: 1 = fit, 4 = 4× detail. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
/** Wheel zoom: exp(-deltaY * WHEEL_ZOOM_RATE) — a trackpad tick is gentle. */
const WHEEL_ZOOM_RATE = 0.0015;

import { toast } from './toast.js';
import { loadVendor } from './vendor.js';

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
        // Structural control (open/close for the room, add/switch pages, page
        // background, clear): OWNER/MODERATOR/PRESENTER only.  A student can be
        // granted ink without ever being allowed to reorganise the board.
        this.canControlBoard = false;
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
        this._undoRestore = new Map(); // opId → op to put back when it is undone
        // view transform (zoom/pan). Coordinates everywhere else stay in
        // reference units, so ink is never rewritten when the view changes.
        this.zoom = MIN_ZOOM;
        this.panX = 0;
        this.panY = 0;
        // The reference surface (page) in reference units.  Chosen by the
        // presenter, identical for every device.  Ops record the size they were
        // written against (`ow`/`oh`), so a format change never rewrites ink.
        this.refW = REF_W;
        this.refH = REF_H;
        this._pan = null;            // active pan gesture
        this._spaceDown = false;
    }

    async init({ roomCode, identity, canDraw, canControlBoard, boardWidth, boardHeight }) {
        this.identity = identity;
        this.canDraw = canDraw;
        this.canControlBoard = Boolean(canControlBoard);
        if (boardWidth && boardHeight) this.setRefSize(boardWidth, boardHeight, { silent: true });
        this._syncDrawGate();
        // Clear, permanent feedback for viewers who may not draw — instead of
        // a toolbar that looks usable but silently does nothing.

        // fabric.js is fetched on demand (~313 KB nobody needs until the board
        // is actually opened).  The toolbar and the socket are wired already, so
        // only the canvas waits.
        try {
            await loadVendor('fabric');
        } catch (err) {
            this._showUnavailable('کتابخانهٔ تخته بارگذاری نشد. صفحه را تازه‌سازی کنید؛ اگر مشکل ادامه داشت، به پشتیبانی اطلاع دهید.');
            console.warn('[whiteboard] fabric.js failed to load', err);
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
        // The canvas exists: drop the «the board is coming» shimmer.
        document.getElementById('wb-loader')?.classList.add('hidden');
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
        this._bindSize();
        this._bindPages();
        this._bindZoom();
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
        const toolbar = document.querySelector('.wb-toolbar');
        toolbar?.classList.toggle('no-draw', !on);
        // Pages / background / clear disappear for anybody who does not own the
        // board — including a student the owner allowed to write on it.
        toolbar?.classList.toggle('no-structure', !this.canControlBoard);
        document.getElementById('wb-mode-chip')?.classList.toggle('hidden', on);
        document.getElementById('wb-nodraw-hint')?.classList.toggle('hidden', on);
        document.getElementById('view-whiteboard')?.classList.toggle('readonly', !on);
        if (!on) this._closeEditor();
    }

    _showUnavailable(message) {
        this.unavailable = true;
        document.getElementById('wb-loader')?.classList.add('hidden');
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

    /**
     * The one scale both axes share: the page is *contained* in the wrapper,
     * never stretched to fit it.  This is what keeps the board's dimensions
     * identical on a phone, a tablet and a projector.
     */
    _fit() {
        const s = Math.min(this._w() / this.refW, this._h() / this.refH);
        return s > 0 ? s : 1;
    }
    /** Letterbox margins: where the page starts inside the wrapper. */
    _ox() { return (this._w() - this.refW * this._fit()) / 2; }
    _oy() { return (this._h() - this.refH * this._fit()) / 2; }
    /** Effective scale: fit-to-page × user zoom. */
    _zs() { return this._fit() * this.zoom; }
    /** The page itself, in CSS px inside the wrapper (what ink may cover). */
    _pageRect() {
        const s = this._zs();
        return {
            x: this._ox() + this.panX,
            y: this._oy() + this.panY,
            w: this.refW * s,
            h: this.refH * s,
        };
    }
    /** CSS px → reference units. Uniform now, so both axes call the same one. */
    _sx() { return this._fit(); }
    _sy() { return this._fit(); }
    _zsx() { return this._zs(); }
    _zsy() { return this._zs(); }

    // ------------------------------------------------------------ view (zoom)
    /** Reference units → CSS px *inside the wrap* (laser dot, text editor). */
    _worldToCss(p) {
        const s = this._zs();
        return { x: this._ox() + p.x * s + this.panX, y: this._oy() + p.y * s + this.panY };
    }

    /**
     * Keep the page in view.  At 100 % the page is smaller than (or equal to)
     * the wrapper on at least one axis, so that axis is simply centred; when
     * zoomed in, panning may never expose the area outside the page — without
     * this a stray middle-drag leaves a blank board with no way back.
     */
    _clampPan() {
        const w = this._w();
        const h = this._h();
        const s = this._zs();
        const ox = this._ox();
        const oy = this._oy();
        const pw = this.refW * s;
        const ph = this.refH * s;
        // page-left ∈ [w - pw, 0] and page-left = ox + panX
        this.panX = pw >= w ? Math.min(-ox, Math.max(w - pw - ox, this.panX)) : 0;
        this.panY = ph >= h ? Math.min(-oy, Math.max(h - ph - oy, this.panY)) : 0;
        if (Math.abs(this.panX) < 0.5) this.panX = 0;
        if (Math.abs(this.panY) < 0.5) this.panY = 0;
    }

    _applyTransform() {
        if (!this.canvas) return;
        const s = this._zs();
        this.canvas.setViewportTransform([s, 0, 0, s, this._ox() + this.panX, this._oy() + this.panY]);
        this._applyBgLayer();
        this._applyCursorScale();
        this._updateZoomUI();
        this._render();
    }

    /** Zoom about a CSS point (default: the centre) so that point stays put. */
    setZoom(next, cxCss, cyCss) {
        if (!this.canvas) return;
        const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next) || MIN_ZOOM));
        const cx = cxCss == null ? this._w() / 2 : cxCss;
        const cy = cyCss == null ? this._h() / 2 : cyCss;
        const s = this._zs();
        const worldX = (cx - this._ox() - this.panX) / s;
        const worldY = (cy - this._oy() - this.panY) / s;
        this.zoom = z;
        const ns = this._zs();
        this.panX = cx - this._ox() - worldX * ns;
        this.panY = cy - this._oy() - worldY * ns;
        this._clampPan();
        this._applyTransform();
    }

    zoomBy(factor, cxCss, cyCss) { this.setZoom(this.zoom * factor, cxCss, cyCss); }

    resetZoom() {
        this.zoom = MIN_ZOOM;
        this.panX = 0;
        this.panY = 0;
        this._applyTransform();
    }

    _updateZoomUI() {
        const btn = document.getElementById('wb-zoom-reset');
        const pct = Math.round(this.zoom * 100);
        if (btn) {
            btn.textContent = `٪${pct.toLocaleString('fa-IR')}`;
            btn.classList.toggle('is-zoomed', this.zoom > MIN_ZOOM);
        }
        const out = document.getElementById('wb-zoom-out');
        const inn = document.getElementById('wb-zoom-in');
        if (out) out.disabled = this.zoom <= MIN_ZOOM + 0.001;
        if (inn) inn.disabled = this.zoom >= MAX_ZOOM - 0.001;
        this._wrapEl()?.classList.toggle('is-zoomed', this.zoom > MIN_ZOOM);
    }

    /** The floating pen ring is sized in field-of-view px, so scale it too. */
    _applyCursorScale() {
        const el = this._wrapEl()?.querySelector('.wb-cursor');
        if (!el || el.classList.contains('hidden')) return;
        const size = Math.max(6, this._toolWidth(this.tool) * this._zsy());
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
    }

    _bindZoom() {
        const wrap = this._wrapEl();
        if (!wrap || !this.canvas) return;
        const surface = this.canvas.upperCanvasEl || this.canvas.wrapperEl;

        // Wheel / trackpad: zoom at the pointer. Never while a stroke is in
        // flight — a stray trackpad tick must not bend a line.
        surface.addEventListener('wheel', (e) => {
            if (!this._visible() || this.drawing) return;
            e.preventDefault();
            const rect = surface.getBoundingClientRect();
            const factor = Math.exp(-(e.deltaY || 0) * WHEEL_ZOOM_RATE);
            this.zoomBy(factor, e.clientX - rect.left, e.clientY - rect.top);
        }, { passive: false });

        // Middle-drag (or space + drag) pans. Captured on the wrap *before*
        // fabric sees it, so the same gesture never starts a stroke.
        wrap.addEventListener('pointerdown', (e) => {
            if (!this._visible()) return;
            const wantsPan = e.button === 1 || (e.button === 0 && this._spaceDown);
            if (!wantsPan) return;
            e.preventDefault();
            e.stopPropagation();
            this._pan = { id: e.pointerId, x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY };
            wrap.classList.add('is-panning');
            const move = (ev) => {
                if (!this._pan || ev.pointerId !== this._pan.id) return;
                this.panX = this._pan.panX + (ev.clientX - this._pan.x);
                this.panY = this._pan.panY + (ev.clientY - this._pan.y);
                this._clampPan();
                this._applyTransform();
            };
            const up = (ev) => {
                if (ev && ev.pointerId !== this._pan?.id) return;
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                window.removeEventListener('pointercancel', up);
                this._pan = null;
                wrap.classList.remove('is-panning');
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
            window.addEventListener('pointercancel', up);
        }, true);

        document.getElementById('wb-zoom-in')?.addEventListener('click', () => this.zoomBy(ZOOM_STEP));
        document.getElementById('wb-zoom-out')?.addEventListener('click', () => this.zoomBy(1 / ZOOM_STEP));
        document.getElementById('wb-zoom-reset')?.addEventListener('click', () => this.resetZoom());

        // Space is the "hand" modifier; released keys can be missed when focus
        // leaves the page, so reset on blur too.
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && !this._isTyping(e.target)) {
                this._spaceDown = true;
                if (this._visible()) this._wrapEl()?.classList.add('is-pan-ready');
            }
        });
        document.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                this._spaceDown = false;
                this._wrapEl()?.classList.remove('is-pan-ready');
            }
        });
        window.addEventListener('blur', () => {
            this._spaceDown = false;
            this._wrapEl()?.classList.remove('is-pan-ready');
        });
    }

    _isTyping(target) {
        const t = target;
        return Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
    }

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
            // A replay always starts with the snapshot (when the board has one)
            // followed by the event tail.  The 2.5 s flush is only a fallback
            // for "the server never sent a replay"; every chunk postpones it so
            // a long replay cannot push queued ops into the middle of it.
            this._incomingSnapshot = null;
            this._snapshotApplied = false;
            this._postponeFlush();
        };
        ws.onclose = (evt) => {
            if (ws._retired) return;                              // replaced on purpose
            if (evt.code === 4401 || evt.code === 4403) return;   // never retry these
            setTimeout(() => this._connect(roomCode), this.retryDelay = Math.min(this.retryDelay * 2, 15000));
        };
        ws.onmessage = (evt) => {
            let data;
            try { data = JSON.parse(evt.data); } catch { return; }
            if (data.type === 'whiteboard_snapshot' || data.type === 'whiteboard_history') {
                this._postponeFlush();
            }
            if (data.type === 'whiteboard_snapshot') {
                // The board as it stands: the server folds older operations
                // into one state (that is what keeps a long class from losing
                // its early pages on reconnect).  A big board arrives in chunks.
                if (!data.chunk) this._incomingSnapshot = [];
                if (this._incomingSnapshot) {
                    for (const op of data.ops || []) this._incomingSnapshot.push(op);
                }
                if (data.more) return;
                const ops = this._incomingSnapshot || data.ops || [];
                this._incomingSnapshot = null;
                this.pageCount = Math.max(1, Number(data.pageCount) || 1);
                this._pageOps.clear();
                this._pageIds.clear();
                this._pageColors.clear();
                this._pageGrid.clear();
                this._replaying = true;
                ops.forEach((op) => this._applyOp(op));
                this._replaying = false;
                // The event tail follows and is applied on top of this state.
                this._snapshotApplied = true;
            } else if (data.type === 'whiteboard_history') {
                // The tail arrives in chunks (a single board can be larger than
                // one WebSocket frame); only the last chunk finishes the replay.
                if (!data.chunk) {
                    this._incomingHistory = [];
                    this._incomingSeq = data.seq || 0;
                    if (!this._snapshotApplied) {
                        // No snapshot: this log IS the whole board.
                        this._pageOps.clear();
                        this._pageIds.clear();
                        this._pageColors.clear();
                        this._pageGrid.clear();
                    }
                }
                if (this._incomingHistory) {
                    for (const e of data.events || []) this._incomingHistory.push(e);
                }
                if (data.more) return;
                const events = this._incomingHistory || data.events || [];
                this._incomingHistory = null;
                this._replaying = true;
                events.forEach((e) => this._applyOp(e.op));
                this._replaying = false;
                this._snapshotApplied = false;
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
                // The server refused an op: drop it here too, otherwise the
                // author keeps ink that nobody else has (and that disappears
                // on the next reload).
                if (data.op_id) this._rollback(data.op_id);
                toast(data.message || 'خطا در تخته.', 'error');
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

    /** Keep the outbox flush waiting while replay data is still arriving. */
    _postponeFlush() {
        clearTimeout(this._flushTimer);
        this._flushTimer = setTimeout(() => this._flushOutbox(), 2500);
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
        document.getElementById('wb-width')?.addEventListener('input', (e) => {
            this.width = Number(e.target.value);
            const cursor = this._wrapEl()?.querySelector('.wb-cursor');
            if (cursor) {
                const size = Math.max(6, this._toolWidth(this.tool) * this._zsy());
                cursor.style.width = `${size}px`;
                cursor.style.height = `${size}px`;
            }
        });

        // page background colour — a colour-picker drag fires dozens of input
        // events; they are merged into ONE op (and one DB row).
        document.getElementById('wb-bg')?.addEventListener('input', (e) => {
            if (!this.canControlBoard) return this._deny();
            this._queueSetup({ color: e.target.value });
        });
        // grid style cycler: none → grid → dots → none
        document.getElementById('wb-grid')?.addEventListener('click', () => {
            if (!this.canControlBoard) return this._deny();
            const order = ['none', 'grid', 'dots'];
            const cur = this._pendingSetup?.grid || this._pageGrid.get(this.page) || 'none';
            const next = order[(order.indexOf(cur) + 1) % order.length];
            this._queueSetup({ grid: next }, { immediate: true });
        });
    }

    /** Activate a tool (also used by the keyboard shortcuts). */
    setTool(tool) {
        if (!tool) return;
        // The laser pointer is a write operation as well: it draws on every
        // screen in the room, so it needs the same grant as the pen.
        if (!this.canDraw) return this._deny();
        this.tool = tool;
        document.querySelectorAll('.wb-toolbar .wb-tool').forEach((b) => {
            const on = b.dataset.tool === tool;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', String(on));
        });
        const wrap = this._wrapEl();
        if (wrap) wrap.dataset.wbTool = tool;
        const cursor = wrap?.querySelector('.wb-cursor');
        if (cursor) {
            cursor.classList.toggle('hidden', !['pen', 'highlighter', 'eraser'].includes(tool));
            const size = Math.max(6, this._toolWidth(tool) * this._zsy());
            cursor.style.width = `${size}px`;
            cursor.style.height = `${size}px`;
            cursor.classList.toggle('is-eraser', tool === 'eraser');
        }
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
            else if (key === '+' || key === '=') { e.preventDefault(); this.zoomBy(ZOOM_STEP); }
            else if (key === '-' || key === '_') { e.preventDefault(); this.zoomBy(1 / ZOOM_STEP); }
            else if (key === '0') { e.preventDefault(); this.resetZoom(); }   // browser zoom stays untouched
            return;
        }
        if (key === '+' || key === '=') { e.preventDefault(); this.zoomBy(ZOOM_STEP); return; }
        if (key === '-' || key === '_') { e.preventDefault(); this.zoomBy(1 / ZOOM_STEP); return; }
        if (key === '0') { e.preventDefault(); this.resetZoom(); return; }
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
        // Only the authority roles take the whole class with them; a granted
        // student flips pages on their own screen and never drags the room.
        if (broadcast && this.canControlBoard) {
            this._sendOp({ type: 'page_go', page: n, id: this._id() });
        }
    }

    addPage() {
        if (!this.canControlBoard) {
            return this._deny('صفحهٔ جدید فقط توسط مالک، مدیر جلسه یا ارائه‌دهنده ساخته می‌شود.');
        }
        if (this.pageCount >= MAX_PAGES) {
            toast(`بیشتر از ${MAX_PAGES.toLocaleString('fa-IR')} صفحه پشتیبانی نمی‌شود.`, 'warning');
            return;
        }
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
        this._applyBgLayer();
    }

    /**
     * The page colour/grid layer is a DOM box, not canvas pixels — so it has to
     * be *placed* like one: exactly under the reference page, letterbox margins
     * included and the grid cell scaled by the same uniform factor as the ink.
     * Left at `inset: 0` it painted a full-bleed white rectangle behind the
     * letterbox, i.e. it hid the fact that the page has a fixed size at all.
     */
    _applyBgLayer() {
        const el = this._ensureBgLayer();
        if (!el) return;
        const page = this._pageRect();
        const s = this._zs();
        const cell = Math.max(6, Math.round(28 * s));
        el.style.inset = 'auto';
        el.style.left = '0';
        el.style.top = '0';
        el.style.width = `${Math.max(1, page.w)}px`;
        el.style.height = `${Math.max(1, page.h)}px`;
        el.style.transform = `translate3d(${page.x}px, ${page.y}px, 0)`;
        el.style.backgroundSize = `${cell}px ${cell}px`;
    }

    /** Export the visible page as a downloadable PNG (background included). */
    exportPNG() {
        if (!this.canvas) return;
        const mult = 2;
        // Fixed output — 1200×700 at 2× — like the page itself.  Sizing the
        // export from the wrapper meant the "same" board saved as 2×1920×1080
        // on a laptop and a tall sliver on a phone.
        const outW = this.refW * mult;
        const outH = this.refH * mult;
        // Ink goes on its own transparent layer first: eraser strokes are
        // `destination-out`, so they must punch holes in the ink only — if the
        // page background were already under them, they would erase it too.
        const art = document.createElement('canvas');
        art.width = outW;
        art.height = outH;
        const actx = art.getContext('2d');
        actx.save();
        actx.setTransform(outW / this.refW, 0, 0, outH / this.refH, 0, 0);
        // The export is the whole page, so it must not depend on where the
        // user happens to be looking: fabric skips objects outside the current
        // viewport, which would silently crop a zoomed-in export.
        const skipOffscreen = this.canvas.skipOffscreen;
        const caching = [];
        this.canvas.skipOffscreen = false;
        try {
            for (const obj of this.canvas.getObjects()) {
                try {
                    // Draw from the vector, not from fabric's bitmap cache: the
                    // cache is sized from the canvas zoom (so a magnified board
                    // exported after zooming came out clipped/faint) and it is
                    // never as sharp as rendering at the export resolution.
                    caching.push([obj, obj.objectCaching]);
                    obj.objectCaching = false;
                    obj.render(actx);
                } catch (err) { console.warn('[whiteboard] export: object skipped', err); }
            }
        } finally {
            this.canvas.skipOffscreen = skipOffscreen;
            for (const [obj, flag] of caching) {
                obj.objectCaching = flag;
                obj.dirty = true;   // the next on-screen paint rebuilds its cache
            }
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
    /** A ring under the pointer that shows the actual pen/rubber width. */
    _cursorEl() {
        const wrap = this._wrapEl();
        if (!wrap) return null;
        let el = wrap.querySelector('.wb-cursor');
        if (!el) {
            el = document.createElement('div');
            el.className = 'wb-cursor hidden';
            el.setAttribute('aria-hidden', 'true');
            wrap.appendChild(el);
        }
        return el;
    }

    _trackCursor(e) {
        const el = this._cursorEl();
        if (!el || !this.canvas) return;
        const stroke = ['pen', 'highlighter', 'eraser'].includes(this.tool);
        if (!stroke) { el.classList.add('hidden'); return; }
        const rect = this.canvas.upperCanvasEl.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientY < rect.top || e.clientX > rect.right || e.clientY > rect.bottom) {
            el.classList.add('hidden');
            return;
        }
        const size = Math.max(6, this._toolWidth(this.tool) * this._zsy());
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
        // The ring follows the *ink*, not the raw pointer: over the letterbox
        // margin the stroke is clamped to the page edge, and a ring floating
        // outside the paper would promise a stroke that lands somewhere else.
        const page = this._pageRect();
        el.style.left = `${Math.min(page.x + page.w, Math.max(page.x, e.clientX - rect.left))}px`;
        el.style.top = `${Math.min(page.y + page.h, Math.max(page.y, e.clientY - rect.top))}px`;
        el.classList.toggle('is-eraser', this.tool === 'eraser');
        el.classList.remove('hidden');
    }

    _bindDrawing() {
        this.canvas.on('mouse:down', (opt) => this._down(opt));
        this.canvas.on('mouse:move', (opt) => this._move(opt));
        this.canvas.on('mouse:up', (opt) => this._up(opt));
        this.canvas.on('mouse:dblclick', (opt) => this._dblclick(opt));
        // High-rate devices (pen, touch, gaming mice) report several samples
        // per frame; fabric only sees one.  Harvesting the coalesced events is
        // what turns a polygon into handwriting.
        this.canvas.upperCanvasEl?.addEventListener('pointermove', (e) => {
            this._onCoalesced(e);
            this._trackCursor(e);
        }, { passive: true });
        this.canvas.upperCanvasEl?.addEventListener('pointerleave', () => this._cursorEl()?.classList.add('hidden'));
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
            toast(reason, 'warning');
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
        if (abs) return this._clampToPage({ x: abs.x, y: abs.y });
        const p = opt?.pointer || { x: 0, y: 0 };
        const s = this._zs();
        return this._clampToPage({
            x: (p.x - this._ox() - this.panX) / s,
            y: (p.y - this._oy() - this.panY) / s,
        });
    }

    /**
     * Ink never leaves the paper: a pointer inside the letterbox margin (or the
     * empty strip when a fixed page does not fill the wrapper) is pulled to the
     * nearest edge of the page, so a stroke that starts on the "desk" does not
     * begin off-canvas and then jump.
     */
    _clampToPage(p) {
        const x = Math.min(this.refW, Math.max(0, Number.isFinite(p.x) ? p.x : 0));
        const y = Math.min(this.refH, Math.max(0, Number.isFinite(p.y) ? p.y : 0));
        return { x, y };
    }

    _down(opt) {
        if (!this.canDraw) return this._deny();
        if (this.tool === 'laser') return; // laser needs no down/up
        const p = this._pt(opt);

        // Which label was hit (if any)?
        const hitId = opt?.target?.data?.opId;
        const hit = hitId ? this._opById(hitId) : null;
        const isLabel = !!hit && hit.type === 'text';
        // Our own double-click detection: the native `dblclick` never reaches
        // a canvas whose pointerdown opens an editor on the first click.
        const now = Date.now();
        const last = this._lastDown;
        this._lastDown = { t: now, x: p.x, y: p.y };
        const doubleClick = !!last && now - last.t < 400
            && Math.abs(p.x - last.x) * this._zsx() < 8
            && Math.abs(p.y - last.y) * this._zsy() < 8;

        if (this.tool === 'text' || (isLabel && doubleClick)) {
            // Clicking an existing label edits it in place; an empty spot
            // starts a new one.
            if (isLabel) {
                this._cancelStroke();
                this._openEditor(this._opPoint(hit), { text: hit.text, replaceId: hitId });
            } else if (this.tool === 'text') {
                this._openEditor(p);
            }
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
    /** Width (reference px) for a tool: a marker is fat, a rubber is broad. */
    _toolWidth(tool) {
        const base = Math.max(0.5, this.width);
        if (tool === 'eraser') return Math.min(110, base * 6);
        if (tool === 'highlighter') return base * 2.4;
        return base;
    }

    _makeStroke(tool, p) {
        const opaque = {
            selectable: false,
            evented: false,
            objectCaching: false,
            strokeLineCap: 'round',
            strokeLineJoin: 'round',
            fill: '',
            // Reference px: the canvas transform scales this with the board, so
            // every peer sees the same relative ink (bug: it used to be divided
            // by the local canvas height, so a student on a smaller stage saw
            // hair-thin strokes).
            strokeWidth: this._toolWidth(tool),
        };
        let shape;
        if (tool === 'eraser') {
            // destination-out really removes ink: the (transparent) canvas is
            // punched through and the page background below shows up again.
            shape = new (SmoothPolylineClass())([p, p], {
                ...opaque,
                stroke: 'rgba(0,0,0,1)',
                globalCompositeOperation: 'destination-out',
            });
        } else {
            shape = new (SmoothPolylineClass())([p, p], {
                ...opaque,
                stroke: this.color,
                opacity: tool === 'highlighter' ? 0.32 : 1,
            });
        }
        shape._wbTool = tool;
        return shape;
    }

    /**
     * Add one sample to the live stroke.
     *
     * Sub-epsilon moves are dropped (they only add bytes) and the render is
     * scheduled once per frame, so a 240 Hz pen does not cost 240 frames.
     */
    _appendPoint(p) {
        if (!this.drawing || !this.liveShape || !Array.isArray(this.liveShape.points)) return false;
        const pts = this.liveShape.points;
        const last = pts[pts.length - 1];
        if (last && Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < POINT_EPSILON) return false;
        pts.push(p);
        this._lastPoint = p;
        this._scheduleRender();
        return true;
    }

    /** Coalesced pointer samples: a pen reports far more than one per frame. */
    _onCoalesced(e) {
        if (!this.drawing || !this.liveShape || !this.canvas) return;
        if (typeof e.getCoalescedEvents !== 'function') return;
        const events = e.getCoalescedEvents() || [];
        if (events.length < 2) return;
        let added = false;
        for (const ev of events) {
            const raw = this.canvas.getPointer(ev);      // absolute (reference) coords
            if (this._appendPoint({ x: raw.x, y: raw.y })) added = true;
        }
        if (added) this._render();
    }

    _move(opt) {
        if (this.tool === 'laser') {
            if (!this.canDraw) return;
            const p = this._pt(opt);
            const now = (window.performance || Date).now();
            // Feedback first (it is local and free), then maybe tell the room.
            const at = this._worldToCss(p);
            this._showLaser(at.x, at.y);
            if (now - this._lastLaser < LASER_MIN_MS) return;
            this._lastLaser = now;
            if ((this.ws?.bufferedAmount || 0) > WS_BUFFER_LIMIT) return; // socket is behind: drop this frame
            this._sendOp({
                type: 'laser', page: this.page, norm: 1,
                ow: this.refW, oh: this.refH,
                x: +(p.x / this.refW).toFixed(4), y: +(p.y / this.refH).toFixed(4),
            });
            return;
        }
        if (!this.drawing || !this.liveShape) return;
        const p = this._pt(opt);
        if (this.liveShape.type === 'polyline') {
            this._appendPoint(p);
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

    _up(opt) {
        if (!this.drawing || !this.liveShape) { this.drawing = false; return; }
        const obj = this.liveShape;
        // The pointer keeps moving between the last `mousemove` and the
        // release; without this the stroke stops a few pixels short.
        const end = opt?.absolutePointer || this._lastPoint;
        if (end && obj.type === 'polyline') this._appendPoint({ x: end.x, y: end.y });
        this.liveShape = null;
        this.drawing = false;
        this._lastPoint = null;

        const op = this._serialize(obj);
        if (!op) { this.canvas.remove(obj); this._render(); return; }
        const dot = this._isDot(op);
        if (dot) {
            // A tap left no length, so the placeholder paints nothing: it is
            // swapped for the round dab that `_applyOp` paints (and that every
            // other client replays as a circle).
            this._dotify(op);
            this.canvas.remove(obj);
        } else if (this._degenerate(op)) { this.canvas.remove(obj); this._render(); return; }
        op.page = this.page;
        if (!dot) {
            obj.set('data', { opId: op.id });
            // Register the live object under its op id so applying the op does
            // not paint a duplicate on top of it.
            this._index(op.id, obj);
        }
        this._applyOp(op);
        this._sendOp(op);
        this._pushUndo(op);
        this._render();
    }

    /** A tap (no travel) — a dot in handwriting, so it must survive. */
    _isDot(op) {
        if (op.type !== 'draw' || !op.points || op.points.length > 2) return false;
        if (!['pen', 'highlighter'].includes(op.tool)) return false;   // shapes/rubber have no dots
        const [a, b] = op.points;
        return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 0.006;
    }

    /**
     * Give a tap a body: a zero-length segment paints nothing, so the dot is
     * a very short round-capped segment the width of the pen.  (Persian
     * letters such as «ن» are unwritable without dots.)
     */
    _dotify(op) {
        // The server wants at least two points; the pair stays where it is and
        // `dot:1` tells every client to paint a circle instead of a segment.
        op.dot = 1;
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
            // Reference px, like the ink: the same op looks the same everywhere.
            strokeWidth: this._toolWidth(tool),
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
        // phone) used to push the typing box outside the board.  The bounds are
        // the *page*, not the wrapper, so the editor always sits on the paper.
        const bw = box.offsetWidth || 180;
        const at = this._worldToCss(point);
        const page = this._pageRect();
        const left = Math.max(page.x + 2, Math.min(page.x + page.w - bw - 2, at.x));
        const top = Math.max(page.y + 2, Math.min(page.y + page.h - 24, at.y));
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
        box.style.setProperty('--wb-text-color', replaceId ? (this._opById(replaceId)?.color || this.color) : this.color);
        box.style.fontSize = `${Math.max(12, fontSizeWorld * this._zsy())}px`;
        input.value = text;
        // Focus on the next task: the pointerdown that opened the editor is
        // still running, and the browser's default action for it moves focus
        // to <body> — which used to swallow every keystroke.
        setTimeout(() => { if (this._editing) { input.focus(); input.select(); } }, 20);
    }

    /** World (reference) position stored in an op. */
    _opPoint(op) {
        const ref = this._opRef(op);
        if (op.norm) return { x: op.x * ref.w, y: op.y * ref.h };
        return { x: op.x * (this.refW / this._w()), y: op.y * (this.refH / this._h()) };
    }

    /**
     * Change the board's format.  Authority-only; the caller is the presence
     * socket's echo, so every device lands on the same numbers.
     */
    setRefSize(width, height, { silent = false } = {}) {
        const clamp = (v, fallback) => {
            const n = Math.round(Number(v));
            return Number.isFinite(n) && n > 0
                ? Math.min(MAX_REF, Math.max(MIN_REF, n))
                : fallback;
        };
        const w = clamp(width, REF_W);
        const h = clamp(height, REF_H);
        const changed = w !== this.refW || h !== this.refH;
        this.refW = w;
        this.refH = h;
        this._syncSizeUI();
        if (changed && this.canvas) {
            this._clampPan();
            this._applyTransform();
        }
        if (changed && !silent) this._render();
        return changed;
    }

    /** Preset key for the current surface ('custom' when it is not one). */
    sizeKey() {
        for (const [key, [w, h]] of Object.entries(BOARD_PRESETS)) {
            if (w === this.refW && h === this.refH) return key;
        }
        return 'custom';
    }

    /** The toolbar's size picker follows whatever the room is on. */
    _syncSizeUI() {
        const sel = document.getElementById('wb-size');
        const hint = document.getElementById('wb-size-hint');
        const key = this.sizeKey();
        if (sel) {
            if (key !== 'custom') sel.value = key;
            else if (sel.value !== 'custom') sel.value = '';
        }
        if (hint) hint.textContent = `${this.refW}×${this.refH}`;
    }

    /**
     * The picker itself: one change → one room-wide action.  Only a member who
     * owns the board gets the control (it is not even rendered otherwise), and
     * the server checks the same gate again.
     */
    _bindSize() {
        const sel = document.getElementById('wb-size');
        if (!sel || !this.canControlBoard) return;
        sel.addEventListener('change', () => {
            const preset = sel.value;
            const size = BOARD_PRESETS[preset];
            if (!size) return;
            this.onSizeRequest?.(preset);
        });
        this._syncSizeUI();
    }

    /**
     * The surface an op was written on.  New ops carry it (`ow`/`oh`); ops
     * stored before board formats existed were all drawn on the 12:7 default.
     */
    _opRef(op) {
        const w = Number(op && op.ow);
        const h = Number(op && op.oh);
        return {
            w: Number.isFinite(w) && w >= MIN_REF ? w : REF_W,
            h: Number.isFinite(h) && h >= MIN_REF ? h : REF_H,
        };
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
        let previous = null;
        if (replaceId) {
            previous = this._opById(replaceId);
            const remove = { type: 'remove', id: replaceId, page: this.page };
            this._applyOp(remove);
            this._sendOp(remove);
        }
        const op = {
            type: 'text', id: this._id(), page: this.page, norm: 1,
            ow: this.refW, oh: this.refH,
            x: +(point.x / this.refW).toFixed(4), y: +(point.y / this.refH).toFixed(4),
            text, color: this.color, size: +fontSizeWorld.toFixed(1),
        };
        this._applyOp(op);
        this._sendOp(op);
        this._pushUndo(op);
        // Undoing a rewrite should bring the old wording back, not leave a
        // hole where the label was.
        if (previous) {
            this._undoRestore.set(op.id, previous);
            while (this._undoRestore.size > 50) {
                this._undoRestore.delete(this._undoRestore.keys().next().value);
            }
        }
    }

    /** Double-click an existing label to rewrite it. */
    _dblclick(opt) {
        if (!this.canDraw || !opt?.target) return;
        this._cancelStroke();   // the first click of the pair started one
        const id = opt.target.data?.opId;
        if (!id) return;
        const op = this._opById(id);
        if (!op || op.type !== 'text') return;
        this.setTool('text');
        this._openEditor(this._opPoint(op), { text: op.text, replaceId: id });
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

    /**
     * Reduce a path to at most `max` points (Ramer–Douglas–Peucker).
     *
     * A stroke is one op; the server refuses ops with >4096 points or >64 KB,
     * and a rejected op means "the author sees ink, the class does not".
     * Keeping the corner points and dropping redundant ones is visually
     * almost free at these densities (points are ~1.6 px apart to begin with).
     */
    _simplify(points, max = MAX_OP_POINTS) {
        if (points.length <= max) return points;
        const sq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
        const rdp = (pts, tol) => {
            if (pts.length < 3) return pts.slice();
            const first = pts[0];
            const last = pts[pts.length - 1];
            const tol2 = tol * tol;
            let index = -1;
            let maxDist = 0;
            const dx = last[0] - first[0];
            const dy = last[1] - first[1];
            const len2 = dx * dx + dy * dy;
            for (let i = 1; i < pts.length - 1; i++) {
                const pt = pts[i];
                let dist;
                if (len2 === 0) {
                    dist = sq(pt, first);
                } else {
                    let t = ((pt[0] - first[0]) * dx + (pt[1] - first[1]) * dy) / len2;
                    t = Math.max(0, Math.min(1, t));
                    dist = (pt[0] - (first[0] + t * dx)) ** 2 + (pt[1] - (first[1] + t * dy)) ** 2;
                }
                if (dist > maxDist) { maxDist = dist; index = i; }
            }
            if (maxDist > tol2 && index > 0) {
                const left = rdp(pts.slice(0, index + 1), tol);
                const right = rdp(pts.slice(index), tol);
                return left.slice(0, -1).concat(right);
            }
            return [first, last];
        };
        let tol = 0.0008;
        let out = rdp(points, tol);
        // Grow the tolerance until the path fits the budget (bounded loop).
        while (out.length > max && tol < 0.2) {
            tol *= 1.6;
            out = rdp(points, tol);
        }
        if (out.length <= max) return out;
        // Pathological fallback: even stride, endpoints kept.
        const stride = Math.ceil(out.length / max);
        const thin = out.filter((_, i) => i % stride === 0);
        if (thin[thin.length - 1] !== out[out.length - 1]) thin.push(out[out.length - 1]);
        return thin;
    }

    _serialize(obj) {
        // Coordinates travel NORMALISED (0..1 of the reference surface) so the
        // same op renders in the same relative place on any screen size.
        // `norm:1` marks new ops; legacy pixel ops render 1:1.
        const nx = (v) => +(v / this.refW).toFixed(4);
        const ny = (v) => +(v / this.refH).toFixed(4);
        const tool = obj._wbTool || 'pen';
        const common = {
            id: obj.data?.opId || this._id(), tool, norm: 1,
            // The surface this op was drawn on.  Without it a later format
            // change would silently stretch or crop everybody's old ink.
            ow: this.refW, oh: this.refH,
            // Width is already in reference px (see _makeStroke), so it means
            // the same thing on every screen. Server cap is 512.
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
            if (pts.length === 1) pts.push([...pts[0]]);   // a tap: keep the pair, it becomes a dot
            if (pts.length < 2) return null;
            // A long unbroken scribble can exceed the server's per-op limits
            // (4096 points / 64 KB) — it was then dropped with a generic error
            // while the author kept seeing ink nobody else had.  Thin it here.
            const slim = this._simplify(pts, MAX_OP_POINTS);
            return {
                type: 'draw', ...common,
                points: slim,
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
                const ref = this._opRef(op);
                if (op.norm) {
                    // Normalised → the writer's reference units → this view's
                    // CSS pixels.
                    x *= ref.w; y *= ref.h;
                } else {
                    // (Legacy pixel ops are CSS pixels of the sender.)
                    x *= this.refW / this._w(); y *= this.refH / this._h();
                }
                const at = this._worldToCss({ x, y });
                this._showLaser(at.x, at.y);
            }
            return;
        }
        if (op.type === 'page_go') {
            if (this._replaying) {
                this.page = pg;                 // silent — repaint happens once
            } else {
                this.setPage(pg, { broadcast: false });
                if (actorName) {
                    toast(`${actorName} به صفحهٔ ${pg} رفت.`, 'info', 2000);
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
                // A stroke in flight belongs to the page that was just wiped;
                // finishing it later would paint it back on a blank board.
                this._cancelStroke();
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
            const ref = this._opRef(op);
            const x = n ? op.x * ref.w : op.x * (this.refW / this._w());
            const y = n ? op.y * ref.h : op.y * (this.refH / this._h());
            const size = n ? (op.size || 20) : (op.size || 20) * (this.refH / this._h());
            const text = new fabric.Text(op.text, {
                left: x,
                top: y,
                fill: op.color || '#111827',
                fontSize: size,
                // `evented` (without `selectable`) is what makes the label a
                // double-click target for editing; it cannot be dragged.
                selectable: false,
                evented: true,
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
        const ref = this._opRef(op);
        const px = (v, dim) => (n ? v * dim : v * (dim / (dim === ref.w ? this._w() : this._h())));
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
                if (op.dot) {
                    // A tap: a round dab the diameter of the pen, so Persian
                    // dots are round on every screen and at every zoom.
                    const [dx, dy] = op.points[0];
                    // A nib dab is about the pen's width; the floor keeps a thin
                    // pen's dots legible (a Persian «ن» is unreadable without them).
                    const r = Math.max(3.5, (op.width || 3) / 2);
                    return new fabric.Circle({
                        left: px(dx, ref.w) - r, top: px(dy, ref.h) - r,
                        radius: r, fill: op.color || '#000', stroke: '',
                        selectable: false, evented: false,
                        opacity: op.tool === 'highlighter' ? 0.32 : 1,
                    });
                }
                const pts = (op.points || []).map(([x, y]) => ({ x: px(x, ref.w), y: px(y, ref.h) }));
                // A stored single-point op (a tap) becomes a dot.
                if (pts.length === 1) pts.push({ x: pts[0].x, y: pts[0].y });
                if (pts.length < 2) return null;
                return new (SmoothPolylineClass())(pts, {
                    ...common,
                    opacity: op.tool === 'highlighter' ? 0.32 : 1,
                });
            }
            case 'line':
            case 'arrow': {
                const [a, b] = op.points || [[0, 0], [0, 0]];
                const A = { x: px(a[0], ref.w), y: px(a[1], ref.h) };
                const B = { x: px(b[0], ref.w), y: px(b[1], ref.h) };
                return new fabric.Line([A.x, A.y, B.x, B.y], common);
            }
            case 'rectangle': {
                const w = op.w !== undefined ? px(op.w, ref.w) : (op.width || 0);
                const h = op.h !== undefined ? px(op.h, ref.h) : (op.height || 0);
                return new fabric.Rect({ left: px(op.left, ref.w), top: px(op.top, ref.h), width: w, height: h, ...common });
            }
            case 'circle':
                return new fabric.Ellipse({ left: px(op.left, ref.w), top: px(op.top, ref.h), rx: px(op.rx, ref.w), ry: px(op.ry, ref.h), ...common });
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
                const restore = this._undoRestore.get(op.id);
                if (restore) {
                    this._undoRestore.delete(op.id);
                    this._applyOp(restore);
                    this._sendOp(restore);
                }
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
            if (!this.canControlBoard) {
                return this._deny('پاک‌کردن صفحهٔ مشترک فقط توسط مالک، مدیر جلسه یا ارائه‌دهنده انجام می‌شود.');
            }
            if (!confirm('فقط صفحهٔ جاری برای همه پاک شود؟')) return;
            this._cancelStroke();
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

    /** Undo one locally-applied op whose server copy was refused. */
    _rollback(opId) {
        if (!opId) return;
        for (const pg of [...this._pageOps.keys()]) {
            if (!this._hasOp(pg, opId)) continue;
            this._dropOp(pg, opId);                 // not part of the page history
            if (pg === this.page) this._removeById(opId);   // unpaint it
        }
        this.myUndo = this.myUndo.filter((o) => o.id !== opId);
        this.myRedo = this.myRedo.filter((o) => o.id !== opId);
        this._syncEditState();
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
        // onto the new size, so every stroke keeps its relative place. The
        // user's zoom/pan is preserved (and re-clamped to the new size).
        this._clampPan();
        this._applyTransform();
    }

    setPermission(canDraw) {
        // Live grant/revoke: the dock and the «فقط نمایش» chip must flip
        // immediately, otherwise a newly-authorized user still faces a
        // locked board (and a revoked one keeps drawing tools).
        this.canDraw = canDraw;
        this._syncDrawGate();
        // Never switch object selection on: the board has no movable objects,
        // and fabric draws its group-selection marquee — a translucent blue
        // rectangle — on every drag that starts on empty paper, i.e. right on
        // top of the stroke the user is writing (bug report: «a purple
        // rectangle appears and grows while I write»).
        if (this.canvas) {
            this.canvas.selection = false;
            this.canvas._groupSelector = null;
            this.canvas.discardActiveObject();
        }
        this._syncEditState();
    }
}

/** Reference surface used to normalise coordinates and stroke sizes. */
WhiteboardImpl.REF_W = REF_W;
WhiteboardImpl.REF_H = REF_H;

export const Whiteboard = new WhiteboardImpl();
