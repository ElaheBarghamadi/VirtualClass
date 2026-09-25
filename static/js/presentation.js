/**
 * presentation.js — shared document viewer with live annotation.
 *
 * Rendering: PDF via PDF.js (per-page canvas), PNG/JPG drawn to canvas,
 * anything else offers a download panel.  The presenter's page choice is
 * authoritative and syncs through `presentation_changed`; everybody can
 * still flip pages locally on their own screen.
 *
 * Annotation: pen/highlighter/eraser strokes on a transparent fabric
 * canvas exactly over the rendered page.  Strokes are whiteboard ops
 * tagged with `file_id` — relayed and persisted by the same whiteboard
 * WebSocket + permissions (can_use_whiteboard, enforced server-side).
 * Coordinates are stored normalised to page units so every viewer's
 * annotations land in the same place regardless of their screen size.
 */
class PresentationImpl {
    constructor() {
        this.ws = null;
        this.roomCode = null;
        this.identity = null;
        this.canAnnotate = false;
        this.canPresent = false;
        this.api = null;             // JSON POST helper from room.js
        this.fileId = null;
        this.fileName = '';
        this.page = 1;
        this.pageCount = 1;
        this.tool = 'pen';
        this.color = '#e11d48';
        this.width = 4;
        this._pdfCache = null;       // {fileId, doc}
        this._pdfLoading = null;     // {fileId, promise} — single-flight loader
        this._renderGen = 0;         // generation guard against render races
        this._scale = 1;             // css px per page unit (for normalisation)
        this._fileOps = new Map();   // "fid:page" → ops
        this._myUndo = [];
        this._annot = null;          // fabric.Canvas overlay
        this._drawing = false;
        this._live = null;
        this._start = null;
        this._idCounter = 0;
        this._retryDelay = 1000;
        this._ready = false;
    }

    init({ roomCode, identity, canAnnotate, canPresent, api }) {
        this.roomCode = roomCode;
        this.identity = identity;
        this.canAnnotate = canAnnotate;
        this.canPresent = canPresent;
        this.api = api;
        this._bindToolbar();
        this._bindNav();
        this._connect();
        // re-render on container size changes (fullscreen, panels, rotate)
        const holder = document.getElementById('presentation-holder');
        if (holder && window.ResizeObserver) {
            let t = null;
            this._resizeObs = new ResizeObserver(() => {
                clearTimeout(t);
                t = setTimeout(() => this.renderCurrent(), 120);
            });
            this._resizeObs.observe(holder);
        }
    }

    setPermission(canAnnotate) {
        this.canAnnotate = canAnnotate;
        this._syncAnnotGate();
    }

    _syncAnnotGate() {
        const wrap = document.getElementById('pres-annot');
        if (wrap) wrap.style.pointerEvents = this.canAnnotate ? 'auto' : 'none';
        document.querySelectorAll('.pres-tools .wb-tool, .pres-tools .wb-action').forEach((b) => {
            b.classList.toggle('denied', !this.canAnnotate);
        });
    }

    // ------------------------------------------------------------ transport
    _connect() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        this.ws = new WebSocket(`${proto}://${location.host}/ws/classroom/${this.roomCode}/whiteboard/`);
        this.ws.onopen = () => { this._retryDelay = 1000; };
        this.ws.onclose = () => setTimeout(() => this._connect(), this._retryDelay = Math.min(this._retryDelay * 2, 15000));
        this.ws.onmessage = (evt) => {
            const data = JSON.parse(evt.data);
            if (data.type === 'whiteboard_history') {
                this._fileOps.clear();
                data.events.forEach((e) => this._receiveOp(e.op));
                this.renderCurrent();
            } else if (data.type === 'whiteboard_operation') {
                if (data.actor_identity === this.identity) return; // already applied locally
                this._receiveOp(data.op);
            }
        };
    }

    _key(fid, page) { return `${fid}:${page}`; }

    /** Store every file-tagged op; paint when it targets the visible page. */
    _receiveOp(op) {
        if (!op || !op.file_id) return; // board ops belong to whiteboard.js
        const k = this._key(op.file_id, op.page || 1);
        const list = this._fileOps.get(k) || [];
        if (op.type === 'clear') {
            this._fileOps.set(k, []);
        } else if (op.type === 'remove') {
            this._fileOps.set(k, list.filter((o) => o.id !== op.id));
        } else if (!list.some((o) => o.id === op.id)) {
            list.push(op);
            this._fileOps.set(k, list);
        }
        if (op.file_id === this.fileId && (op.page || 1) === this.page) {
            if (op.type === 'clear') this._repaintAnnot();
            else if (op.type === 'remove') this._removeAnnotById(op.id);
            else this._paintOp(op);
        }
    }

    _sendOp(op) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ action: 'op', op }));
        }
    }

    // ------------------------------------------------------------ show / navigate
    show({ file_id, file_name, page }) {
        if (!file_id) { this.hide(); return; }
        const sameFile = file_id === this.fileId;
        this.fileId = file_id;
        this.fileName = file_name || '';
        this.page = Math.max(1, page || 1);
        document.getElementById('presentation-title').textContent =
            `ارائه: ${this.fileName}`;
        const dl = document.getElementById('pres-download');
        if (dl) dl.href = `/class/${this.roomCode}/files/${this.fileId}/download/`;
        if (!sameFile) this._myUndo = [];
        this.renderCurrent();
    }

    hide() {
        this.fileId = null;
    }

    /** Local-only page flip (no broadcast) — for non-presenters. */
    showLocalPage(page) {
        this.page = page;
        this.renderCurrent();
    }

    go(page, { local = false } = {}) {
        page = Math.max(1, Math.min(this.pageCount || 999, page));
        if (!local && this.canPresent && this.api) {
            this.api('/presentation/', { file_id: this.fileId, page });
            // the presentation_changed echo drives show() for everyone
        } else {
            this.showLocalPage(page);
        }
    }

    _fileExt() {
        const m = (this.fileName || '').toLowerCase().match(/\.(\w+)$/);
        return m ? m[1] : '';
    }

    _fileKind() {
        const ext = this._fileExt();
        if (ext === 'pdf') return 'pdf';
        if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
        return 'other';
    }

    // ------------------------------------------------------------ rendering
    /**
     * Renders are guarded by a generation counter: show(), ResizeObserver
     * and history events can all trigger a render at once, and without
     * this guard a stale render could (a) refetch the document, (b) have
     * its doc destroyed mid-render and (c) flash the error fallback over
     * a perfectly good newer render.  Stale renders abort silently.
     */
    async renderCurrent() {
        const gen = ++this._renderGen;
        const stage = document.getElementById('pres-stage');
        const fallback = document.getElementById('pres-fallback');
        if (!stage || !this.fileId) return;
        const kind = this._fileKind();
        this._updateNavUI();

        if (kind === 'other') {
            stage.classList.add('hidden');
            fallback.classList.remove('hidden');
            fallback.innerHTML =
                '<p>پیش‌نمایش این فرمت در مرورگر ممکن نیست.</p>' +
                `<a class="btn" href="/class/${this.roomCode}/files/${this.fileId}/download/" download>⬇ دانلود فایل</a>`;
            return;
        }
        // While the view is hidden the holder measures 0×0 — rendering now
        // would produce a stamp-sized page; the ResizeObserver re-renders
        // as soon as the view becomes visible.
        const holder = document.getElementById('presentation-holder');
        const rect = holder.getBoundingClientRect();
        if (rect.width < 32 || rect.height < 32) return;

        fallback.classList.add('hidden');
        stage.classList.remove('hidden');

        try {
            if (kind === 'pdf') await this._renderPdfPage(gen);
            else await this._renderImage(gen);
        } catch (err) {
            if (gen !== this._renderGen) return; // a newer render owns the UI
            console.warn('[presentation] render failed:', err);
            fallback.classList.remove('hidden');
            stage.classList.add('hidden');
            fallback.innerHTML = `<p>نمایش فایل ناموفق بود.</p><a class="btn" href="/class/${this.roomCode}/files/${this.fileId}/download/" download>⬇ دانلود فایل</a>`;
            return;
        }
        if (gen !== this._renderGen) return;
        this._ensureAnnotCanvas();
        this._repaintAnnot();
        this._syncAnnotGate();
    }

    /** Single-flight document load: concurrent callers share ONE fetch. */
    _loadPdfDoc() {
        if (this._pdfCache && this._pdfCache.fileId === this.fileId) {
            return Promise.resolve(this._pdfCache.doc);
        }
        if (this._pdfLoading && this._pdfLoading.fileId === this.fileId) {
            return this._pdfLoading.promise;
        }
        const fileId = this.fileId;
        const promise = pdfjsLib
            .getDocument({ url: `/class/${this.roomCode}/files/${fileId}/download/` }).promise
            .then((doc) => {
                const old = this._pdfCache;
                this._pdfCache = { fileId, doc };
                if (this._pdfLoading && this._pdfLoading.fileId === fileId) this._pdfLoading = null;
                // Destroy the PREVIOUS file's doc only now — any render still
                // using it is stale and aborts at its next generation check.
                if (old && old.fileId !== fileId) {
                    try { old.doc.destroy(); } catch (e) { /* noop */ }
                }
                return doc;
            })
            .catch((err) => {
                if (this._pdfLoading && this._pdfLoading.fileId === fileId) this._pdfLoading = null;
                throw err;
            });
        this._pdfLoading = { fileId, promise };
        return promise;
    }

    async _renderPdfPage(gen) {
        if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js not loaded');
        if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
            pdfjsLib.GlobalWorkerOptions.workerSrc = window.PDF_WORKER_URL || '/static/vendor/pdf.worker.min.js';
        }
        const doc = await this._loadPdfDoc();
        if (gen !== this._renderGen) return;
        this.pageCount = doc.numPages || 1;
        this.page = Math.max(1, Math.min(this.pageCount, this.page));

        const page = await doc.getPage(this.page);
        if (gen !== this._renderGen) return;
        const holder = document.getElementById('presentation-holder');
        const holderRect = holder.getBoundingClientRect();
        const base = page.getViewport({ scale: 1 });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const scale = Math.max(0.1, Math.min(
            (holderRect.width - 16) / base.width,
            (holderRect.height - 16) / base.height,
        ));
        this._scale = scale;
        const viewport = page.getViewport({ scale });

        const canvas = document.getElementById('pres-canvas');
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const ctx = canvas.getContext('2d', { alpha: false });
        await page.render({
            canvasContext: ctx,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        }).promise;
        if (gen !== this._renderGen) return;
        this._updateNavUI();
    }

    async _renderImage(gen) {
        this.pageCount = 1;
        this.page = 1;
        const img = new Image();
        img.src = `/class/${this.roomCode}/files/${this.fileId}/download/`;
        await img.decode();
        if (gen !== this._renderGen) return;
        const holder = document.getElementById('presentation-holder');
        const holderRect = holder.getBoundingClientRect();
        const scale = Math.max(0.05, Math.min(
            (holderRect.width - 16) / img.naturalWidth,
            (holderRect.height - 16) / img.naturalHeight,
        ));
        this._scale = scale;
        const w = Math.floor(img.naturalWidth * scale);
        const h = Math.floor(img.naturalHeight * scale);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = document.getElementById('pres-canvas');
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.drawImage(img, 0, 0, w, h);
        this._updateNavUI();
    }

    // ------------------------------------------------------------ annotation layer
    _ensureAnnotCanvas() {
        const canvas = document.getElementById('pres-canvas');
        const el = document.getElementById('pres-annot-canvas');
        if (!canvas || !el || typeof fabric === 'undefined') return;
        const w = parseInt(canvas.style.width, 10) || canvas.width;
        const h = parseInt(canvas.style.height, 10) || canvas.height;
        if (!this._annot) {
            this._annot = new fabric.Canvas(el, {
                backgroundColor: '',
                selection: false,
                preserveObjectStacking: true,
            });
            this._annot.on('mouse:down', (opt) => this._down(opt));
            this._annot.on('mouse:move', (opt) => this._move(opt));
            this._annot.on('mouse:up', () => this._up());
        }
        this._annot.setDimensions({ width: w, height: h });
        const wrap = document.getElementById('pres-annot');
        if (wrap) { wrap.style.width = `${w}px`; wrap.style.height = `${h}px`; }
    }

    _repaintAnnot() {
        if (!this._annot) return;
        this._annot.clear();
        this._annot.backgroundColor = '';
        for (const op of this._fileOps.get(this._key(this.fileId, this.page)) || []) {
            this._paintOp(op);
        }
        this._annot.requestRenderAll();
    }

    _removeAnnotById(id) {
        if (!this._annot) return;
        const targets = this._annot.getObjects().filter((o) => o.data?.opId === id);
        if (targets.length) this._annot.remove(...targets);
    }

    _deny() {
        if (this._warned) return false;
        import('./toast.js').then(({ toast }) => toast('شما اجازهٔ نوشتن روی ارائه را ندارید.', 'warning'));
        this._warned = true;
        setTimeout(() => { this._warned = false; }, 4000);
        return false;
    }

    _down(opt) {
        if (!this.canAnnotate) return this._deny();
        const p = { x: opt.pointer.x / this._scale, y: opt.pointer.y / this._scale };
        this._drawing = true;
        this._start = p;
        if (this.tool === 'pen' || this.tool === 'highlighter' || this.tool === 'eraser') {
            const px = { x: opt.pointer.x, y: opt.pointer.y };
            this._live = new fabric.Polyline([px, px], {
                stroke: this.tool === 'eraser' ? '#ffffff' : this.color,
                strokeWidth: this.tool === 'eraser' ? this.width * 6 : this.width,
                strokeLineCap: 'round', strokeLineJoin: 'round',
                fill: '',
                opacity: this.tool === 'highlighter' ? 0.4 : 1,
                selectable: false, objectCaching: false,
            });
            this._annot.add(this._live);
        }
    }

    _move(opt) {
        if (!this._drawing || !this._live) return;
        const px = { x: opt.pointer.x, y: opt.pointer.y };
        const pts = this._live.points;
        pts.push(px);
        this._live.set({ points: pts });
        this._annot.requestRenderAll();
    }

    _up() {
        if (!this._drawing || !this._live) { this._drawing = false; return; }
        const obj = this._live;
        this._live = null;
        this._drawing = false;
        const op = {
            type: 'draw', tool: this.tool,
            id: this._id(),
            file_id: this.fileId, page: this.page,
            points: obj.points.map((p) => [
                Math.round(p.x / this._scale * 10) / 10,
                Math.round(p.y / this._scale * 10) / 10,
            ]),
            color: this.tool === 'eraser' ? null : this.color,
            width: this.tool === 'eraser' ? Math.round(this.width * 6 / this._scale * 10) / 10
                                         : Math.round(this.width / this._scale * 10) / 10,
        };
        obj.set('data', { opId: op.id });
        this._receiveOp(op); // record + (idempotent) paint
        this._sendOp(op);
        this._myUndo.push(op);
        if (this._myUndo.length > 50) this._myUndo.shift();
    }

    _id() {
        return `${this.identity}-${Date.now()}-${++this._idCounter}`;
    }

    /** Paint one op, scaling from page units to current css pixels. */
    _paintOp(op) {
        if (!this._annot) return;
        if (op.type !== 'draw' && op.type !== 'text') return;
        if (op.id && this._annot.getObjects().some((o) => o.data?.opId === op.id)) return;
        const s = this._scale;
        const common = {
            stroke: op.tool === 'eraser' ? '#ffffff' : (op.color || '#000'),
            strokeWidth: (op.width || 3) * s,
            fill: '',
            selectable: false,
            objectCaching: false,
        };
        const pts = (op.points || []).map(([x, y]) => ({ x: x * s, y: y * s }));
        if (pts.length >= 2) {
            const obj = new fabric.Polyline(pts, {
                ...common,
                opacity: op.tool === 'highlighter' ? 0.4 : 1,
            });
            obj.set('data', { opId: op.id });
            this._annot.add(obj);
        }
    }

    // ------------------------------------------------------------ toolbar / nav
    _bindToolbar() {
        document.querySelectorAll('.pres-tools .wb-tool').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (!this.canAnnotate) return this._deny();
                document.querySelectorAll('.pres-tools .wb-tool').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                this.tool = btn.dataset.ptool;
            });
        });
        document.querySelectorAll('.pres-tools .wb-action').forEach((btn) => {
            btn.addEventListener('click', () => this._action(btn.dataset.paction));
        });
        document.getElementById('pres-color')?.addEventListener('input', (e) => { this.color = e.target.value; });
        document.getElementById('pres-width')?.addEventListener('input', (e) => { this.width = Number(e.target.value); });
    }

    _action(action) {
        if (action === 'undo') {
            if (!this.canAnnotate) return this._deny();
            const op = this._myUndo.pop();
            if (!op) return;
            this._receiveOp({ type: 'remove', id: op.id, file_id: this.fileId, page: this.page });
            this._sendOp({ type: 'remove', id: op.id, file_id: this.fileId, page: this.page });
        } else if (action === 'clear') {
            if (!this.canAnnotate) return this._deny();
            if (!confirm('حاشیه‌نویسی این صفحه برای همه پاک شود؟')) return;
            const op = { type: 'clear', id: this._id(), file_id: this.fileId, page: this.page };
            this._receiveOp(op);
            this._sendOp(op);
        }
    }

    _bindNav() {
        document.getElementById('pres-prev')?.addEventListener('click', () => {
            if (this.canPresent) this.go(this.page - 1);
            else this.showLocalPage(Math.max(1, this.page - 1));
        });
        document.getElementById('pres-next')?.addEventListener('click', () => {
            if (this.canPresent) this.go(this.page + 1);
            else this.showLocalPage(Math.min(this.pageCount, this.page + 1));
        });
    }

    _updateNavUI() {
        const label = document.getElementById('pres-page-label');
        if (label) label.textContent = `صفحهٔ ${Number(this.page).toLocaleString('fa-IR')} از ${this.pageCount ? Number(this.pageCount).toLocaleString('fa-IR') : '?'}`;
        const prev = document.getElementById('pres-prev');
        const next = document.getElementById('pres-next');
        if (prev) prev.disabled = this.page <= 1;
        if (next) next.disabled = this.pageCount ? this.page >= this.pageCount : false;
    }
}

export const Presentation = new PresentationImpl();
