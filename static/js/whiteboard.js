/**
 * whiteboard.js — collaborative whiteboard facade.
 *
 * This module is the one the room talks to (``Whiteboard.init(...)``,
 * ``setPermission``, ``resize``).  It owns the pieces and keeps them in sync:
 *
 * ``wb/model.js``      the replayable document (operations → objects)
 * ``wb/render.js``     the painter (board units → canvas pixels)
 * ``wb/tools.js``      pointer/keyboard interaction
 * ``wb/transport.js``  the websocket (reconnect, resync, presence, snapshot)
 * ``wb/ui.js``         toolbar, palette, pages panel, zoom bar, status
 *
 * Design notes
 * ------------
 * * Drawing is **optimistic**: an operation is applied locally and shown
 *   immediately, then sent.  When the server echoes it back (with its
 *   sequence number) the local copy is confirmed; if the server *refuses* it
 *   (permission revoked, stale page, rate limit) the change is rolled back so
 *   the board never shows something the rest of the class cannot see.
 * * Reconnecting asks for the operations it missed (``since``); when the
 *   server cannot serve a tail any more it sends a full replay instead.
 * * A client that is completely caught up publishes a flattened snapshot when
 *   the server asks for one, which lets the log be compacted without ever
 *   losing what is drawn on the board.
 */
import { BoardModel } from './wb/model.js';
import { BoardRenderer, colorForIdentity } from './wb/render.js';
import { BoardTools, textSizeFor } from './wb/tools.js';
import { BoardSocket } from './wb/transport.js';
import { BoardChrome } from './wb/ui.js';
import { PAGE_H, PAGE_W, clamp, opPoints, opX, opY } from './wb/geometry.js';

/**
 * Build stamp of this bundle.  The room template renders the stamp of the
 * *server's* copy and the page compares the two: when a stale script is still
 * cached the board would otherwise just sit there doing nothing.
 */
export const BUILD = 'wb-2026-10-16.1';

const GRID_ORDER = ['none', 'grid', 'dots', 'lines', 'graph'];
const CURSOR_TTL = 6000;
const GHOST_TTL = 4000;
const SNAPSHOT_DELAY = 2500;

class WhiteboardImpl {
    constructor() {
        this.roomCode = null;
        this.identity = null;
        this.participantName = '';
        this.canDraw = false;
        this.canPresent = false;
        this.unavailable = false;
        this.page = 1;
        this.follow = true;
        this.ready = false;
        this.model = new BoardModel();
        this.renderer = null;
        this.tools = null;
        this.socket = null;
        this.chrome = null;
        this._idCounter = 0;
        this._laser = null;
        this._laserTimer = null;
        this._remoteCursors = new Map();
        this._ghosts = new Map();
        this._cursorTimer = null;
        this._renderQueued = false;
        this._snapshotTimer = null;
        this._snapshotBlockedUntil = 0;
        this._ghostRenderer = null;
    }

    /* ------------------------------------------------------------------ */
    /* lifecycle                                                          */
    /* ------------------------------------------------------------------ */

    init({ roomCode, identity, canDraw = false, canPresent = false, participantName = '' } = {}) {
        if (this.ready) return;
        const root = document.getElementById('classroom-root');
        this.roomCode = roomCode;
        this.identity = identity;
        // presence chips show the display name the room already knows about
        this.participantName = participantName || root?.dataset.participantName || '';
        this.canDraw = Boolean(canDraw);
        this.canPresent = Boolean(canPresent);

        const canvas = document.getElementById('whiteboard-canvas');
        const wrap = document.getElementById('wb-canvas-wrap');
        if (!canvas || !wrap) {
            this._unavailable('بوم تخته پیدا نشد. صفحه را تازه‌سازی کنید.');
            return;
        }
        this.renderer = new BoardRenderer(canvas);
        if (this.renderer.unavailable) {
            this._unavailable('مرورگر شما از بوم گرافیکی پشتیبانی نمی‌کند؛ تخته در این مرورگر کار نمی‌کند.');
            return;
        }

        this.tools = new BoardTools({
            canvas,
            renderer: this.renderer,
            getModel: () => this.model,
            getPage: () => this.page,
            getHost: () => wrap,
            newId: () => this.newId(),
            commit: (ops, meta) => this._commit(ops, meta),
            ephemeral: (op) => this._sendEphemeral(op),
            requestRender: () => this.render(),
        });
        this.tools.onUndo = (kind) => (kind === 'redo' ? this.redo() : this.undo());
        this.tools.onPageChange = (delta) => this.setPage(this.page + delta);
        // single-key tool shortcuts (P, E, R, …) go through the facade so the
        // toolbar, the permission lock and the cursor all stay in sync
        this.tools.onTool = (tool) => this.setTool(tool);

        this.chrome = new BoardChrome(this);
        this.chrome.init();
        this.setPermission(this.canDraw);

        this.resize();
        if (window.ResizeObserver && wrap) {
            this._resizeObserver = new ResizeObserver(() => this.resize());
            this._resizeObserver.observe(wrap);
        }
        window.addEventListener('resize', () => this.resize());

        this._bindCanvas(canvas);
        this._bindKeyboard(wrap);

        this.socket = new BoardSocket({
            roomCode,
            identity,
            hooks: {
                onSync: (payload) => this._onSync(payload),
                onOperation: (message) => this._onOperation(message),
                onError: (message) => this._onError(message),
                onPresence: (roster) => this._refreshPresence(roster),
                onStatus: (status, extra) => this._onStatus(status, extra),
                onSnapshotResult: (message) => this._onSnapshotResult(message),
                onNotification: (message) => this._onNotification(message),
            },
        });
        this.ready = true;
        this.render();
        this.socket.connect();
        if (typeof console !== 'undefined' && console.info) {
            console.info(
                `[whiteboard] build ${BUILD} · ${this.canDraw ? 'اجازهٔ نوشتن' : 'فقط مشاهده'}`
                + ` · بوم ${canvas.width}×${canvas.height}@${this.renderer.dpr}x`,
            );
        }
    }

    _unavailable(message) {
        this.unavailable = true;
        this._unavailableReason = message;
        if (typeof console !== 'undefined' && console.error) {
            console.error(`[whiteboard] unavailable: ${message}`);
        }
        if (this.chrome) {
            this.chrome.setUnavailable(message);
        } else {
            const hint = document.getElementById('wb-error-hint');
            if (hint) {
                hint.textContent = message;
                hint.classList.remove('hidden');
            }
        }
        document.querySelector('#view-whiteboard .wb-toolbar')?.classList.add('is-unavailable');
    }

    /** Live permission updates (grant/revoke while the board is open). */
    setPermission(canDraw) {
        this.canDraw = Boolean(canDraw);
        this.tools?.setLocked(!this.canDraw);
        this.chrome?.setPermission(this.canDraw);
        this.chrome?.setHistoryState({
            canUndo: this.model.canUndo(this.page),
            canRedo: this.model.canRedo(this.page),
        });
        // tell the roster about the new capability right away
        this.socket?.send({ action: 'presence' });
    }

    deny() {
        if (this._deniedAt && Date.now() - this._deniedAt < 4000) return false;
        this._deniedAt = Date.now();
        this.toast(
            'برای حساب شما نوشتن روی تخته فعال نیست. از مالک کلاس بخواهید مجوز «تختهٔ اشتراکی» را روشن کند.',
            'warning',
        );
        return false;
    }

    newId() {
        this._idCounter += 1;
        return `${this.identity || 'anon'}-${Date.now().toString(36)}-${this._idCounter}`;
    }

    /* ------------------------------------------------------------------ */
    /* wiring                                                             */
    /* ------------------------------------------------------------------ */

    _bindCanvas(canvas) {
        canvas.addEventListener('pointerdown', (event) => this.tools.onPointerDown(event));
        canvas.addEventListener('pointermove', (event) => this.tools.onPointerMove(event));
        canvas.addEventListener('pointerup', (event) => this.tools.onPointerUp(event));
        canvas.addEventListener('pointercancel', (event) => this.tools.onPointerUp(event));
        canvas.addEventListener('pointerleave', () => this.tools.onPointerLeave());
        canvas.addEventListener('dblclick', (event) => this.tools.onDoubleClick(event));
        canvas.addEventListener('wheel', (event) => this.tools.onWheel(event), { passive: false });
        canvas.addEventListener('contextmenu', (event) => {
            // right click = quick erase of whatever sits under the pointer
            event.preventDefault();
            this.tools.eraseAtPointer(event);
        });
    }

    _bindKeyboard(scope) {
        document.addEventListener('keydown', (event) => {
            if (document.getElementById('view-whiteboard')?.classList.contains('hidden')) return;
            if (document.getElementById('settings-dialog')?.open) return;
            // a modal (shortcuts, confirm…) owns the keyboard while it is up
            if (document.querySelector('dialog[open]')) return;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
            // Escape closes a floating popover first — the same reflex as the
            // help sheet, and the only way out of the palette on a phone
            if (event.key === 'Escape' && this.chrome?.closePopoversIfOpen?.()) {
                event.preventDefault();
                return;
            }
            const handled = this.tools.handleKeyDown(event);
            if (handled) this.chrome.setHistoryState({
                canUndo: this.model.canUndo(this.page),
                canRedo: this.model.canRedo(this.page),
            });
        });
        document.addEventListener('keyup', (event) => this.tools.handleKeyUp(event));
        scope?.addEventListener('contextmenu', (event) => {
            if (event.target === scope) event.preventDefault();
        });
    }

    /* ------------------------------------------------------------------ */
    /* socket hooks                                                       */
    /* ------------------------------------------------------------------ */

    _onSync(payload) {
        const wasFull = Boolean(payload.full);
        this.model.sync(payload);
        if (wasFull) {
            this.tools.clearSelection();
            this.tools.cancelEditing();
            this.model.pending.clear();
            if (payload.trimmed) {
                this.toast('تاریخچهٔ تخته کوتاه شده است؛ بخش قدیمی برای صرفه‌جویی در حافظه حذف شده و باید بازخوانی شود.', 'warning', 6000);
            }
        }
        this.page = clamp(this.page, 1, this.model.pageCount);
        this.chrome.setPage(this.page, this.model.pageCount);
        this.chrome.setHistoryState({
            canUndo: this.model.canUndo(this.page),
            canRedo: this.model.canRedo(this.page),
        });
        this.chrome.scheduleThumbnails();
        this._refreshPresence(this.socket?.roster() || []);
        this.render();
        if (payload.needs_snapshot) this._scheduleSnapshot();
    }

    _onOperation(message) {
        const op = message.op;
        if (!op) return;
        if (message.ephemeral) {
            this._onEphemeral(message);
            return;
        }
        const seq = Number(message.seq) || 0;
        if (seq && seq <= this.model.revision) return;
        const mine = message.actor_identity === this.identity;

        if (mine && op.id) {
            const pending = this.model.pending.get(op.id);
            if (pending) {
                const current = this.model.getOp(Math.max(1, op.page || 1), op.id);
                // the server is authoritative: adopt its version of the op
                if (current && JSON.stringify(current) !== JSON.stringify(op)) this.model.apply(op);
                else if (!current) this.model.apply(op);
                this.model.confirmPending(op.id);
            } else {
                this.model.apply(op);
            }
        } else {
            this.model.apply(op);
        }
        if (seq) this.model.revision = seq;
        if (message.board) this.model.applyBoardMeta(message.board);

        if (op.type === 'page_go') {
            if (!mine && this.follow) this.setPage(op.page, { broadcast: false });
        } else if (['page_add', 'page_dup', 'page_remove', 'page_setup'].includes(op.type)) {
            if (!mine) this.toast(`${message.actor_name || 'کاربر'} ساختار صفحه‌ها را تغییر داد.`, 'info', 2600);
            this.page = clamp(this.page, 1, this.model.pageCount);
            this.chrome.setPage(this.page, this.model.pageCount);
            this.chrome.scheduleThumbnails();
        } else if (!mine && op.type === 'clear') {
            this.toast(`${message.actor_name || 'کاربر'} صفحهٔ ${op.page} را پاک کرد.`, 'info', 2600);
        } else if (!mine) {
            this._noteRemoteActivity(message);
        }
        this.chrome.setHistoryState({
            canUndo: this.model.canUndo(this.page),
            canRedo: this.model.canRedo(this.page),
        });
        this.render();
    }

    _onEphemeral(message) {
        const op = message.op;
        const from = message.actor_identity;
        if (!op || from === this.identity) return;
        this.socket?.touchPresence(from);
        if (op.type === 'laser') {
            this._laser = { x: opX(op), y: opY(op), at: performance.now() };
            clearTimeout(this._laserTimer);
            this._laserTimer = setTimeout(() => {
                this._laser = null;
                this.render();
            }, 900);
            this.render();
            return;
        }
        if (op.type === 'cursor') {
            if (op.gone) this._remoteCursors.delete(from);
            else {
                this._remoteCursors.set(from, {
                    identity: from,
                    name: message.actor_name || '',
                    color: colorForIdentity(from),
                    x: opX(op),
                    y: opY(op),
                    at: Date.now(),
                });
            }
            this._scheduleCursorSweep();
            this.render();
            return;
        }
        if (op.type === 'draw' && op.live) {
            this._ghosts.set(op.id || `${from}-ghost`, { op, at: Date.now(), actor: message.actor_name });
            this._scheduleCursorSweep();
            this.render();
        }
    }

    _onError(message) {
        const code = message.code || '';
        const ids = Array.isArray(message.ops) ? message.ops : [];
        let structural = false;
        for (const id of ids) {
            const pending = this.model.pending.get(id);
            if (pending) {
                const page = this.model.pages.get(pending.page);
                structural = structural || Boolean(page && !page.ops.has(id) && pending.previous === null);
                this.model.revertPending(id);
            }
        }
        if (code === 'forbidden') {
            this.setPermission(false);
            this.toast(message.message || 'اجازهٔ نوشتن روی تخته را ندارید.', 'warning');
            this.chrome.setPermission(false);
        } else if (code === 'rate-limited') {
            this.toast('سرعت تغییرات بیش از حد مجاز است؛ چند لحظه صبر کنید.', 'warning');
        } else {
            this.toast(message.message || 'این تغییر روی تخته پذیرفته نشد.', 'error');
            if (structural || code.startsWith('page-') || code === 'board-full') this.requestFullSync();
        }
        this.chrome.setHistoryState({
            canUndo: this.model.canUndo(this.page),
            canRedo: this.model.canRedo(this.page),
        });
        this.render();
    }

    _onStatus(status, extra) {
        this.chrome?.setStatus(status, extra);
        if (status === 'online') {
            this.toast('تخته وصل شد.', 'success', 1800);
        } else if (status === 'offline') {
            this.toast('اتصال تخته قطع شد؛ تلاش برای وصل مجدد…', 'warning', 3000);
        } else if (status === 'closed' && extra?.code === 4403) {
            this.setPermission(false);
        }
    }

    _onSnapshotResult(message) {
        if (message.type === 'snapshot_rejected') {
            const reason = message.reason || '';
            if (reason === 'stale-snapshot') this._scheduleSnapshot(4000, true);
            else this._snapshotBlockedUntil = Date.now() + 120000;
        } else if (message.type === 'snapshot_stored') {
            this.model.pending.clear();
        }
    }

    _onNotification(message) {
        if (!message || typeof message !== 'object') return;
        const permissions = message.permissions;
        if (permissions && typeof permissions.can_use_whiteboard === 'boolean') {
            this.setPermission(permissions.can_use_whiteboard);
        }
        if (message.type === 'permission_changed' && message.identity === this.identity) {
            const value = message.permission === 'can_use_whiteboard' ? message.value : undefined;
            if (typeof value === 'boolean') this.setPermission(value);
        }
        if (message.event === 'removed' || message.event === 'membership_revoked') {
            this.toast('دسترسی شما به این کلاس بسته شد.', 'error', 5000);
        }
    }

    _refreshPresence(roster) {
        this.chrome?.setPresence(roster, this._selfParticipant());
    }

    _selfParticipant() {
        return {
            identity: this.identity,
            name: this.participantName || 'شما',
            can_draw: this.canDraw,
        };
    }

    /* ------------------------------------------------------------------ */
    /* outgoing operations                                                */
    /* ------------------------------------------------------------------ */

    _sendEphemeral(op) {
        if (this.socket?.status === 'online') this.socket.sendEphemeral(op);
    }

    /**
     * Apply → send → (optionally) remember how to undo a local change.
     */
    _commit(ops, { record = true, undoHint = 'add', snapshots = null } = {}) {
        if (!Array.isArray(ops) || !ops.length) return false;
        if (!this.canDraw) {
            this.deny();
            return false;
        }
        const undoOps = [];
        const redoOps = [];
        for (const raw of ops) {
            const page = Math.max(1, Number(raw.page) || this.page);
            const op = { ...raw, page, norm: raw.norm ?? 1 };
            const previous = snapshots?.[op.id]
                ? { ...snapshots[op.id] }
                : (op.id ? this.model.getOp(page, op.id) : null);

            if (record) {
                if (op.type === 'remove' && previous) {
                    undoOps.push({ ...previous, page });
                } else if (op.type === 'update' && op.patch) {
                    const inverse = {};
                    for (const key of Object.keys(op.patch)) {
                        const value = previous ? previous[key] : undefined;
                        if (value !== undefined) inverse[key] = value;
                    }
                    if (Object.keys(inverse).length) {
                        undoOps.push({ type: 'update', id: op.id, page, norm: 1, patch: inverse });
                    }
                } else if (op.id && !['clear', 'page_add', 'page_dup', 'page_remove', 'page_setup', 'page_go', 'reorder'].includes(op.type)) {
                    undoOps.push({ type: 'remove', id: op.id, page, norm: 1 });
                }
                redoOps.push(op);
            }
            this.model.notePending(op);
            this.model.apply(op);
            this.socket?.sendOp(op);
        }
        if (record && undoOps.length) {
            this.model.pushUndo({ page: this.page, ops: undoOps, redo: redoOps, hint: undoHint });
        }
        this.chrome?.setHistoryState({
            canUndo: this.model.canUndo(this.page),
            canRedo: this.model.canRedo(this.page),
        });
        this.chrome?.scheduleThumbnails();
        this.render();
        return true;
    }

    undo() {
        if (!this.canDraw) return this.deny();
        const entry = this.model.takeUndo(this.page);
        if (!entry) return false;
        for (const op of entry.ops) {
            const wire = { ...op, norm: op.norm ?? 1 };
            this.model.notePending(wire);
            this.model.apply(wire);
            this.socket?.sendOp(wire);
        }
        this.chrome?.scheduleThumbnails();
        this.chrome?.setHistoryState({ canUndo: this.model.canUndo(this.page), canRedo: this.model.canRedo(this.page) });
        this.render();
        return true;
    }

    redo() {
        if (!this.canDraw) return this.deny();
        const entry = this.model.takeRedo(this.page);
        if (!entry) return false;
        for (const op of entry.redo) {
            const wire = { ...op, norm: op.norm ?? 1 };
            this.model.notePending(wire);
            this.model.apply(wire);
            this.socket?.sendOp(wire);
        }
        this.chrome?.scheduleThumbnails();
        this.chrome?.setHistoryState({ canUndo: this.model.canUndo(this.page), canRedo: this.model.canRedo(this.page) });
        this.render();
        return true;
    }

    /** Force a full replay (used after a rejected structural change). */
    requestFullSync() {
        this.model.revision = 0;
        this.model.snapshotSeq = 0;
        if (!this.socket?.requestResync(0)) this.socket?.connect();
    }

    _scheduleSnapshot(delay = SNAPSHOT_DELAY, force = false) {
        if (this._snapshotTimer) return;
        if (!force && Date.now() < this._snapshotBlockedUntil) return;
        this._snapshotTimer = setTimeout(() => {
            this._snapshotTimer = null;
            this._publishSnapshot();
        }, delay);
    }

    _publishSnapshot() {
        if (!this.canDraw || this.socket?.status !== 'online') return;
        if (this.model.pending.size) return this._scheduleSnapshot(3000, true);
        const ops = this.model.mergedOps();
        if (!ops || !ops.length) return;
        this.socket.publishSnapshot(ops, this.model.revision);
    }

    /* ------------------------------------------------------------------ */
    /* view state                                                         */
    /* ------------------------------------------------------------------ */

    setPage(page, { broadcast = true } = {}) {
        const target = clamp(Number(page) || 1, 1, Math.max(1, this.model.pageCount));
        if (target === this.page) {
            this.chrome?.setPage(this.page, this.model.pageCount);
            return;
        }
        this.page = target;
        this.tools?.cancelEditing();
        this.tools?.clearSelection();
        this.chrome?.setPage(this.page, this.model.pageCount);
        this.chrome?.scheduleThumbnails();
        this.render();
        if (broadcast && this.canDraw) {
            this._commit([{ type: 'page_go', id: this.newId(), page: target }], { record: false });
        }
    }

    addPage(at = null) {
        if (!this.canDraw) return this.deny();
        const target = clamp(Number(at) || this.page + 1, 1, Math.min(999, this.model.pageCount + 1));
        const op = { type: 'page_add', id: this.newId(), page: target, at: target };
        this._commit([op], { record: false });
        this.setPage(target, { broadcast: false });
        this._commit([{ type: 'page_go', id: this.newId(), page: target }], { record: false });
        this.toast(`صفحهٔ ${target} ساخته شد.`, 'success', 1800);
    }

    duplicatePage(page = null) {
        if (!this.canDraw) return this.deny();
        const source = clamp(Number(page) || this.page, 1, this.model.pageCount);
        const target = Math.min(999, source + 1);
        const op = { type: 'page_dup', id: this.newId(), page: source, at: target };
        this._commit([op], { record: false });
        this.setPage(target, { broadcast: false });
        this._commit([{ type: 'page_go', id: this.newId(), page: target }], { record: false });
    }

    async removePage(page = null) {
        if (!this.canDraw) return this.deny();
        const target = clamp(Number(page) || this.page, 1, this.model.pageCount);
        if (this.model.pageCount <= 1) {
            this.toast('آخرین صفحهٔ تخته را نمی‌توان حذف کرد.', 'warning');
            return;
        }
        const confirmed = await this.chrome.confirm(
            'حذف صفحه',
            `صفحهٔ ${target} و نوشته‌های آن برای همه حذف می‌شود. این کار بازگشت‌پذیر نیست.`,
            { danger: true, okLabel: 'حذف صفحه' },
        );
        if (!confirmed) return;
        this._commit([{ type: 'page_remove', id: this.newId(), page: target }], { record: false });
        this.setPage(Math.max(1, target - 1), { broadcast: false });
        this._commit([{ type: 'page_go', id: this.newId(), page: this.page }], { record: false });
    }

    async clearPage() {
        if (!this.canDraw) return this.deny();
        const confirmed = await this.chrome.confirm(
            'پاک کردن صفحه',
            'همهٔ نوشته‌های این صفحه برای همهٔ اعضا پاک می‌شود (پس‌زمینه و صفحه‌ها دست‌نخورده می‌مانند).',
            { danger: true, okLabel: 'پاک کن' },
        );
        if (!confirmed) return;
        this._commit([{ type: 'clear', id: this.newId(), page: this.page }], { record: false });
        this.tools.clearSelection();
    }

    setPageStyle({ color, grid } = {}) {
        if (!this.canDraw) return this.deny();
        const op = { type: 'page_setup', id: this.newId(), page: this.page };
        if (color !== undefined) op.color = color;
        if (grid !== undefined) op.grid = grid;
        this._commit([op], { record: false });
        this.chrome.setPage(this.page, this.model.pageCount);
    }

    cycleGrid() {
        const current = this.model.style(this.page).grid || 'none';
        const next = GRID_ORDER[(GRID_ORDER.indexOf(current) + 1) % GRID_ORDER.length];
        this.setPageStyle({ grid: next });
    }

    setTool(tool) {
        if (!this.canDraw && tool !== 'select') return this.deny();
        this.tools.setTool(tool);
        this.chrome.setTool(tool);
    }

    setColor(color) {
        this.tools.setColor(color);
        this.chrome.setStyleState({ color });
    }

    setWidth(width) {
        this.tools.setWidth(width);
        this.chrome.setStyleState({ width: this.tools.width });
    }

    /** Toolbar actions land here (see the markup's ``data-action``). */
    run(action) {
        switch (action) {
            case 'undo': return this.undo();
            case 'redo': return this.redo();
            case 'clear': return this.clearPage();
            case 'delete-selection': return this.tools.deleteSelection();
            case 'duplicate-selection': return this.tools.duplicateSelection();
            case 'zoom-in': return this.zoomBy(1.15);
            case 'zoom-out': return this.zoomBy(1 / 1.15);
            case 'zoom-fit': return this.resetView();
            case 'next-page': return this.setPage(this.page + 1);
            case 'prev-page': return this.setPage(this.page - 1);
            case 'follow': return this.toggleFollow();
            case 'help': return this.showShortcuts();
            default: return undefined;
        }
    }

    toggleFollow() {
        this.follow = !this.follow;
        this.chrome.setFollowState(this.follow);
        this.toast(this.follow ? 'صفحهٔ شما با ارائه‌دهنده همراه می‌شود.' : 'همراهی با ارائه‌دهنده خاموش شد.', 'info', 2000);
    }

    zoomBy(factor) {
        const center = [this.renderer.width / 2, this.renderer.height / 2];
        this.renderer.zoomAt(center[0], center[1], factor);
        this.render();
    }

    resetView() {
        this.renderer.resetView();
        this.render();
    }

    async showShortcuts() {
        const { infoDialog } = await import('./modal.js');
        const rows = [
            ['P / H / E', 'قلم، هایلایت، پاک‌کن'],
            ['L / A / R / O', 'خط، فلش، مستطیل، بیضی'],
            ['T / N', 'متن، یادداشت چسبان'],
            ['V', 'ابزار انتخاب'],
            ['Ctrl + Z / Ctrl + Shift + Z', 'بازگشت / جلو'],
            ['Ctrl + D', 'تکثیر انتخاب'],
            ['Delete', 'حذف انتخاب'],
            ['Ctrl + A', 'انتخاب همه'],
            ['جهت‌ها', 'جابه‌جایی انتخاب (Shift: سریع‌تر)'],
            ['Alt + ← / →', 'صفحهٔ قبل / بعد'],
            ['Ctrl + چرخ ماوس', 'بزرگ‌نمایی'],
            ['فاصله + درگ', 'جابه‌جایی بوم'],
            ['دابل‌کلیک', 'ویرایش متن یا یادداشت'],
        ];
        const html = `<table class="wb-shortcuts">${rows
            .map(([keys, text]) => `<tr><th>${keys}</th><td>${text}</td></tr>`)
            .join('')}</table>`;
        return infoDialog('کلیدهای میان‌بر تخته', html);
    }

    /* ------------------------------------------------------------------ */
    /* export                                                             */
    /* ------------------------------------------------------------------ */

    exportPNG(page = null) {
        const target = clamp(Number(page) || this.page, 1, this.model.pageCount);
        const url = this.renderer.exportDataURL(this.model, target, 1.6);
        const link = document.createElement('a');
        link.href = url;
        link.download = `whiteboard-page-${target}.png`;
        link.click();
        return url;
    }

    async exportAllPNG() {
        for (let page = 1; page <= this.model.pageCount; page += 1) {
            this.exportPNG(page);
            // small gap so browsers do not drop concurrent downloads
            await new Promise((resolve) => setTimeout(resolve, 320));
        }
    }

    /**
     * Multi-page print view: every page becomes one sheet, so browsers can
     * "save as PDF" without shipping a PDF library to the browser.
     */
    printAll() {
        const limit = Math.min(this.model.pageCount, 40);
        const images = [];
        for (let page = 1; page <= limit; page += 1) {
            images.push(this.renderer.exportDataURL(this.model, page, 1.4));
        }
        const win = window.open('', '_blank');
        if (!win) {
            this.toast('مرورگر پنجرهٔ چاپ را باز نکرد؛ اجازهٔ پاپ‌آپ را فعال کنید.', 'warning');
            return;
        }
        const title = `تخته سفید — ${this.roomCode || ''}`;
        win.document.write(`<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8"><title>${title}</title>
            <style>
                @page { size: A4 landscape; margin: 8mm; }
                body { margin: 0; font-family: Tahoma, sans-serif; }
                figure { margin: 0 0 6mm; page-break-after: always; text-align: center; }
                figure:last-child { page-break-after: auto; }
                img { width: 100%; border: 1px solid #cbd5e1; }
                figcaption { font-size: 11px; color: #475569; margin-top: 2mm; }
            </style></head><body>
            ${images.map((src, index) => `<figure><img src="${src}" alt="صفحهٔ ${index + 1}"><figcaption>صفحهٔ ${index + 1}</figcaption></figure>`).join('')}
            <script>window.onload = () => setTimeout(() => window.print(), 200);<\/script>
            </body></html>`);
        win.document.close();
    }

    /* ------------------------------------------------------------------ */
    /* rendering                                                          */
    /* ------------------------------------------------------------------ */

    resize() {
        if (!this.renderer) return;
        const wrap = document.getElementById('wb-canvas-wrap');
        if (!wrap || wrap.offsetParent === null) return;
        const rect = wrap.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) return;
        // browser zoom / a second monitor can change the ratio without the
        // element changing size — keep the backing store in sync
        const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
        if (ratio !== this.renderer.dpr) this.renderer.dpr = ratio;
        this.renderer.setSize(rect.width, rect.height);
        this.render();
    }

    render() {
        if (!this.renderer || this._renderQueued) return;
        this._renderQueued = true;
        requestAnimationFrame(() => {
            this._renderQueued = false;
            if (!this.renderer) return;
            const cursors = [...this._remoteCursors.values()].map((cursor) => ({
                x: cursor.x,
                y: cursor.y,
                name: cursor.name,
                color: cursor.color,
                identity: cursor.identity,
            }));
            this.renderer.render({
                model: this.model,
                page: this.page,
                cursors,
                laser: this._laser,
                ghosts: [...this._ghosts.values()].map((entry) => entry.op),
                ...this.tools.state(),
            });
            this._updateZoomLabel();
            this.chrome?.setSelectionState({
                count: this.tools.selection.size,
                canReorder: this.tools.selection.size > 0,
            });
        });
    }

    _updateZoomLabel() {
        const label = document.getElementById('wb-zoom-value');
        if (label) label.textContent = `${Math.round(this.renderer.zoom * 100).toLocaleString('fa-IR')}٪`;
    }

    _scheduleCursorSweep() {
        if (this._cursorTimer) return;
        this._cursorTimer = setTimeout(() => {
            this._cursorTimer = null;
            const now = Date.now();
            let changed = false;
            for (const [identity, cursor] of this._remoteCursors) {
                if (now - cursor.at > CURSOR_TTL) {
                    this._remoteCursors.delete(identity);
                    changed = true;
                }
            }
            for (const [id, ghost] of this._ghosts) {
                if (now - ghost.at > GHOST_TTL) {
                    this._ghosts.delete(id);
                    changed = true;
                }
            }
            if (changed) this.render();
            else if (this._remoteCursors.size || this._ghosts.size) this._scheduleCursorSweep();
        }, 1000);
    }

    _noteRemoteActivity(message) {
        const op = message.op;
        if (op && op.page && op.page !== this.page) {
            this.chrome?.showRemoteActivity(
                `${message.actor_name || 'کاربر'} در صفحهٔ ${op.page} می‌نویسد.`,
            );
        }
    }

    toast(message, level = 'info', ms) {
        import('./toast.js').then(({ toast }) => toast(message, level, ms));
    }

    /* ------------------------------------------------------------------ */
    /* compatibility surface (room.js + automated smoke tests)             */
    /* ------------------------------------------------------------------ */

    /** Build stamp of the bundle that is actually running in this tab. */
    get build() {
        return BUILD;
    }

    /** Build stamp the server rendered into the page ("" when missing). */
    get expectedBuild() {
        return document.getElementById('classroom-root')?.dataset.wbBuild || '';
    }

    /**
     * One-shot status report for debugging from the browser console
     * (``__wb.diag()``).  Everything a support round needs in one object.
     */
    diag() {
        const canvas = document.getElementById('whiteboard-canvas');
        const wrap = document.getElementById('wb-canvas-wrap');
        const box = (el) => {
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return `${Math.round(rect.width)}×${Math.round(rect.height)}`;
        };
        return {
            build: BUILD,
            expectedBuild: this.expectedBuild,
            fresh: !this.expectedBuild || this.expectedBuild === BUILD,
            ready: Boolean(this.ready),
            unavailable: Boolean(this.unavailable),
            unavailableReason: this._unavailableReason || null,
            canDraw: Boolean(this.canDraw),
            page: this.page,
            pages: this.model ? this.model.pageCount : 0,
            objects: this.model ? this.model.objectCount(this.page) : 0,
            pending: this.model ? this.model.pending.size : 0,
            tool: this.tool,
            color: this.color,
            width: this.width,
            canvas: canvas ? {
                backing: `${canvas.width}×${canvas.height}`,
                dpr: this.renderer ? this.renderer.dpr : null,
                scale: this.renderer ? Number(this.renderer.scale.toFixed(4)) : null,
                view: this.renderer ? (this.renderer.unavailable ? 'no-2d-context' : 'ok') : 'missing',
            } : 'missing',
            wrap: box(wrap),
            socket: this.socket ? {
                state: this.socket.status,
                url: this.socket.url(),
                outbox: this.socket.outbox.length,
                peers: this.socket.presence.size,
            } : null,
        };
    }

    /** page → list of raw operations (mirrors the old private map). */
    get _pageOps() {
        return this.model.rawPageMap();
    }

    get pageCount() {
        return this.model.pageCount;
    }

    get tool() {
        return this.tools?.tool || 'pen';
    }

    get color() {
        return this.tools?.color || null;
    }

    get width() {
        return this.tools?.width ?? null;
    }

    /** Presentation annotation coordinates are document pixels. */
    static get PAGE() {
        return { width: PAGE_W, height: PAGE_H };
    }

    /** Board units of one page (document pixels for annotations). */
    get PAGE() {
        return { width: PAGE_W, height: PAGE_H };
    }

    /** Text size used for a given slider width (shared with the tools). */
    static textSizeFor(width) {
        return textSizeFor(width);
    }

    /** Instance form of :attr:`PAGE`, kept for the old call sites. */
    textSizeFor(width) {
        return textSizeFor(width);
    }

    /** Convenience for tests/debugging: board objects of one page. */
    objects(page = this.page) {
        return this.model.objects(page);
    }

    /** All points of a page in board units (debug helper). */
    pointsOf(page = this.page) {
        return this.model.objects(page).flatMap((op) => (op.points ? opPoints(op) : []));
    }
}

export const Whiteboard = new WhiteboardImpl();
export default Whiteboard;
