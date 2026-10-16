/**
 * wb/model.js — the board's document model.
 *
 * The board is a *replayable log*: every participant (and every reconnect)
 * applies the same operations in the same order and ends up with the same
 * picture.  The model therefore does one thing only — apply an operation —
 * and keeps three cheap structures per page:
 *
 * * ``ops``     id → current operation payload (frozen at the last update),
 * * ``order``   the z-order (painting order) of ids,
 * * ``removed`` ids that were erased, kept as tombstones so an object that
 *               comes back (undo, redo) lands at its original depth.
 *
 * Replaying is pure: no DOM, no canvas, no timers — unit-testable in Node.
 */
import { boundsOfOps, boundsIntersect, opBounds, opHit, opsTouchedByStroke } from './geometry.js';

const MAX_TOMBSTONES = 4000;
const MAX_SELECTION = 250;

export class PageState {
    constructor(page) {
        this.page = page;
        this.order = [];
        this.ops = new Map();
        this.removed = new Set();
        this.style = { color: '#ffffff', grid: 'none' };
        this.version = 0; // bumped on every visual change (render cache key)
    }

    get size() {
        return this.ops.size;
    }
}

export class BoardModel {
    constructor() {
        this.pages = new Map();
        this.pageCount = 1;
        /** Highest operation sequence this client has applied. */
        this.revision = 0;
        /** Sequence of the flattened snapshot this state is based on. */
        this.snapshotSeq = 0;
        /** Monotonic counter used by renderers/tests to detect changes. */
        this.version = 0;
        /** Optimistic operations not yet acknowledged by the server. */
        this.pending = new Map();
        this.undoStack = [];
        this.redoStack = [];
    }

    /* ------------------------------------------------------------------ */
    /* pages                                                              */
    /* ------------------------------------------------------------------ */

    page(pageNumber) {
        let page = this.pages.get(pageNumber);
        if (!page) {
            page = new PageState(pageNumber);
            this.pages.set(pageNumber, page);
            if (pageNumber > this.pageCount) this.pageCount = pageNumber;
        }
        return page;
    }

    hasPage(pageNumber) {
        return pageNumber >= 1 && pageNumber <= this.pageCount;
    }

    style(pageNumber) {
        const page = this.pages.get(pageNumber);
        return page ? page.style : { color: '#ffffff', grid: 'none' };
    }

    setStyle(pageNumber, style, { silent = false } = {}) {
        const page = this.page(pageNumber);
        const next = { ...page.style, ...style };
        if (next.color === page.style.color && next.grid === page.style.grid) return false;
        page.style = next;
        page.version += 1;
        if (!silent) this.version += 1;
        return true;
    }

    /** Live (non-removed) operations of a page, in painting order. */
    objects(pageNumber) {
        const page = this.pages.get(pageNumber);
        if (!page) return [];
        const out = [];
        for (const id of page.order) {
            if (page.removed.has(id)) continue;
            const op = page.ops.get(id);
            if (op) out.push(op);
        }
        return out;
    }

    objectCount(pageNumber) {
        return this.objects(pageNumber).length;
    }

    getOp(pageNumber, id) {
        const page = this.pages.get(pageNumber);
        return page ? page.ops.get(id) || null : null;
    }

    /* ------------------------------------------------------------------ */
    /* applying operations                                                */
    /* ------------------------------------------------------------------ */

    /**
     * Apply one wire operation.
     *
     * @returns {'content'|'page'|'none'} a coarse class of what changed, used
     *          by the UI to refresh thumbnails/page lists.
     */
    apply(op, { silent = false } = {}) {
        if (!op || typeof op !== 'object') return 'none';
        // Presentation annotations belong to the shared document viewer.
        if (op.file_id) return 'none';
        const pageNumber = Math.max(1, Math.min(999, Number(op.page) || 1));
        switch (op.type) {
            case 'draw':
            case 'text':
            case 'sticky':
                return this._put(pageNumber, { ...op, page: pageNumber }, silent);
            case 'update':
                return this._patch(pageNumber, op, silent);
            case 'remove':
                return this._remove(pageNumber, op.id, silent);
            case 'clear':
                return this._clear(pageNumber, silent);
            case 'reorder':
                return this._reorder(pageNumber, op, silent);
            case 'page_add':
                return this._pageAdd(pageNumber, op.at, silent);
            case 'page_dup':
                return this._pageDup(pageNumber, op, silent);
            case 'page_remove':
                return this._pageRemove(pageNumber, silent);
            case 'page_setup':
                return this.setStyle(pageNumber, {
                    color: op.color, grid: op.grid,
                }, { silent }) ? 'page' : 'none';
            case 'page_go':
            case 'laser':
            case 'cursor':
                return 'none';
            default:
                return 'none';
        }
    }

    _put(pageNumber, op, silent) {
        const page = this.page(pageNumber);
        // The id is always kept in ``order`` (tombstones preserve depth), so
        // re-adding an erased object (undo/redo, a replayed op) must NOT push
        // it again — that would paint it twice.
        page.ops.set(op.id, op);
        page.removed.delete(op.id);
        if (!page.order.includes(op.id)) page.order.push(op.id);
        page.version += 1;
        if (!silent) this.version += 1;
        return 'content';
    }

    _patch(pageNumber, op, silent) {
        const page = this.page(pageNumber);
        const existing = page.ops.get(op.id);
        if (!existing || page.removed.has(op.id)) return 'none';
        const patch = op.patch || {};
        const next = { ...existing, ...patch };
        if (patch.x !== undefined || patch.y !== undefined) {
            next.x = patch.x !== undefined ? patch.x : existing.x;
            next.y = patch.y !== undefined ? patch.y : existing.y;
        }
        // moving a shape means moving both anchor points
        if (patch.dx !== undefined || patch.dy !== undefined) {
            const points = (existing.points || []).map(([x, y]) => [
                x + (patch.dx || 0), y + (patch.dy || 0),
            ]);
            next.points = points;
        }
        delete next.dx;
        delete next.dy;
        page.ops.set(op.id, next);
        page.version += 1;
        if (!silent) this.version += 1;
        return 'content';
    }

    _remove(pageNumber, id, silent) {
        const page = this.page(pageNumber);
        if (!page.ops.has(id) || page.removed.has(id)) return 'none';
        page.removed.add(id);
        if (page.removed.size > MAX_TOMBSTONES) {
            const oldest = page.removed.values().next().value;
            page.removed.delete(oldest);
            page.ops.delete(oldest);
            page.order = page.order.filter((entry) => entry !== oldest);
        }
        page.version += 1;
        if (!silent) this.version += 1;
        return 'content';
    }

    _clear(pageNumber, silent) {
        const page = this.pages.get(pageNumber);
        if (!page) return 'none';
        page.order = [];
        page.ops.clear();
        page.removed.clear();
        page.version += 1;
        if (!silent) this.version += 1;
        return 'content';
    }

    _reorder(pageNumber, op, silent) {
        const page = this.page(pageNumber);
        const index = page.order.indexOf(op.id);
        if (index === -1) return 'none';
        const live = this._liveOrder(page);
        const position = live.indexOf(op.id);
        if (position === -1) return 'none';
        let target = position;
        if (op.move === 'front') target = live.length - 1;
        else if (op.move === 'back') target = 0;
        else if (op.move === 'forward') target = Math.min(live.length - 1, position + 1);
        else if (op.move === 'backward') target = Math.max(0, position - 1);
        if (target !== position) {
            live.splice(position, 1);
            live.splice(target, 0, op.id);
            // rebuild ``order`` keeping tombstones in place
            const rest = page.order.filter((id) => !live.includes(id));
            page.order = [...live, ...rest];
        }
        page.version += 1;
        if (!silent) this.version += 1;
        return 'content';
    }

    _liveOrder(page) {
        return page.order.filter((id) => !page.removed.has(id) && page.ops.has(id));
    }

    _pageAdd(pageNumber, at, silent) {
        if (at !== undefined && at !== null) {
            this._insertPage(Math.max(1, Math.min(999, Number(at) || pageNumber)));
        } else {
            this.page(pageNumber);
            if (pageNumber > this.pageCount) this.pageCount = Math.min(999, pageNumber);
        }
        if (!silent) this.version += 1;
        return 'page';
    }

    /** Insert a page at ``at``, renumbering the pages at/after it. */
    _insertPage(at) {
        const target = Math.max(1, Math.min(999, at));
        const next = new Map();
        for (const [number, state] of this.pages) {
            const shifted = number >= target ? number + 1 : number;
            state.page = shifted;
            for (const [id, op] of state.ops) state.ops.set(id, { ...op, page: shifted });
            next.set(shifted, state);
        }
        this.pages = next;
        // every page >= target moved up, so ``target`` is free again
        this.pages.set(target, new PageState(target));
        this.pageCount = Math.min(999, this.pageCount + 1);
        return target;
    }

    _pageDup(pageNumber, op, silent) {
        const source = this.pages.get(pageNumber);
        if (!source) return 'none';
        // capture the content BEFORE the pages shift, exactly like the server
        const captured = this._liveOrder(source).map((id) => ({ ...source.ops.get(id) }));
        const target = Math.max(1, Math.min(999, Number(op.at) || pageNumber + 1));
        const style = { ...source.style };
        if (target <= this.pageCount) this._insertPage(target);
        const copy = new PageState(target);
        copy.style = style;
        for (const original of captured) {
            copy.order.push(original.id);
            copy.ops.set(original.id, { ...original, page: target });
        }
        copy.version += 1;
        this.pages.set(target, copy);
        if (target > this.pageCount) this.pageCount = Math.min(999, target);
        if (!silent) this.version += 1;
        return 'page';
    }

    _pageRemove(pageNumber, silent) {
        if (this.pageCount <= 1 || pageNumber > this.pageCount) return 'none';
        const page = this.pages.get(pageNumber);
        if (page) {
            page.order = [];
            page.ops.clear();
            page.removed.clear();
        }
        // shift higher pages down (mirrors the server renumbering)
        const next = new Map();
        for (const [number, state] of this.pages) {
            if (number === pageNumber) continue;
            const shifted = number > pageNumber ? number - 1 : number;
            state.page = shifted;
            next.set(shifted, state);
        }
        this.pages = next;
        this.pageCount = Math.max(1, this.pageCount - 1);
        if (!silent) this.version += 1;
        return 'page';
    }

    /** Insert a page, renumbering the pages at/after ``at`` (public wrapper). */
    insertPage(at) {
        const target = this._insertPage(at);
        this.version += 1;
        return target;
    }

    /* ------------------------------------------------------------------ */
    /* server synchronisation                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Rebuild state from a ``whiteboard_history`` frame.
     *
     * ``full`` frames replace everything; tail frames (incremental resync)
     * only carry the operations this client is missing.
     */
    sync(payload) {
        const board = payload.board || {};
        const snapshot = payload.snapshot || null;
        if (payload.full) {
            this.pages.clear();
            this.pageCount = 1;
            this.revision = Number(payload.snapshot_seq || 0);
            this.snapshotSeq = Number(payload.snapshot_seq || 0);
            this.undoStack = [];
            this.redoStack = [];
            this.pending.clear();
            if (Array.isArray(snapshot)) {
                for (const op of snapshot) this.apply(op, { silent: true });
            }
        }
        const events = Array.isArray(payload.events) ? payload.events : [];
        for (const event of events) {
            const seq = Number(event.seq || 0);
            if (seq && seq <= this.revision) continue; // already applied
            this.apply(event.op, { silent: true });
            if (seq) this.revision = seq;
        }
        if (board.page_count) this.pageCount = Math.max(1, Number(board.page_count));
        if (board.pages) {
            for (const [key, style] of Object.entries(board.pages)) {
                this.setStyle(Number(key), style, { silent: true });
            }
        }
        if (board.snapshot_seq) this.snapshotSeq = Number(board.snapshot_seq);
        // make sure every declared page exists
        for (let page = 1; page <= this.pageCount; page += 1) this.page(page);
        this.version += 1;
        return payload;
    }

    /** Merge compact board metadata attached to an operation broadcast. */
    applyBoardMeta(board) {
        if (!board) return false;
        let changed = false;
        if (board.page_count && board.page_count !== this.pageCount) {
            this.pageCount = Math.max(1, Number(board.page_count));
            for (let page = 1; page <= this.pageCount; page += 1) this.page(page);
            changed = true;
        }
        if (board.pages) {
            for (const [key, style] of Object.entries(board.pages)) {
                changed = this.setStyle(Number(key), style, { silent: true }) || changed;
            }
        }
        if (changed) this.version += 1;
        return changed;
    }

    /** Record an operation we just sent (optimistic application). */
    notePending(op) {
        if (!op || !op.id) return;
        const page = Math.max(1, Number(op.page) || 1);
        const previous = this.getOp(page, op.id);
        this.pending.set(op.id, { page, previous: previous ? { ...previous } : null });
        if (this.pending.size > 200) {
            const oldest = this.pending.keys().next().value;
            this.pending.delete(oldest);
        }
    }

    /** The server accepted our optimistic operation. */
    confirmPending(id) {
        if (!id) return null;
        const entry = this.pending.get(id);
        this.pending.delete(id);
        return entry || null;
    }

    /**
     * The server refused our optimistic operation: put the page back the way
     * it was (the board must never show something the class cannot see).
     */
    revertPending(id) {
        const entry = this.pending.get(id);
        if (!entry) return false;
        this.pending.delete(id);
        const page = this.page(entry.page);
        page.removed.delete(id);
        if (entry.previous) page.ops.set(id, entry.previous);
        else {
            page.ops.delete(id);
            page.order = page.order.filter((entryId) => entryId !== id);
        }
        page.version += 1;
        this.version += 1;
        return true;
    }

    /* ------------------------------------------------------------------ */
    /* undo / redo (own operations only)                                  */
    /* ------------------------------------------------------------------ */

    /**
     * Register a reversible local action.
     * @param {{page:number, undo:Array, redo:Array}} entry
     */
    pushUndo(entry) {
        this.undoStack.push(entry);
        if (this.undoStack.length > 200) this.undoStack.shift();
        this.redoStack = [];
    }

    /** @returns {{undo:Array, redo:Array}|null} */
    takeUndo(pageNumber = null) {
        for (let i = this.undoStack.length - 1; i >= 0; i -= 1) {
            if (pageNumber === null || this.undoStack[i].page === pageNumber) {
                const [entry] = this.undoStack.splice(i, 1);
                this.redoStack.push(entry);
                return entry;
            }
        }
        return null;
    }

    takeRedo(pageNumber = null) {
        for (let i = this.redoStack.length - 1; i >= 0; i -= 1) {
            if (pageNumber === null || this.redoStack[i].page === pageNumber) {
                const [entry] = this.redoStack.splice(i, 1);
                this.undoStack.push(entry);
                return entry;
            }
        }
        return null;
    }

    canUndo(pageNumber = null) {
        return this.undoStack.some((entry) => pageNumber === null || entry.page === pageNumber);
    }

    canRedo(pageNumber = null) {
        return this.redoStack.some((entry) => pageNumber === null || entry.page === pageNumber);
    }

    /* ------------------------------------------------------------------ */
    /* queries used by the tools                                          */
    /* ------------------------------------------------------------------ */

    /** Topmost object under a point (board units). */
    hitTest(pageNumber, x, y, tolerance = 8) {
        const objects = this.objects(pageNumber);
        for (let i = objects.length - 1; i >= 0; i -= 1) {
            if (opHit(objects[i], x, y, tolerance)) return objects[i];
        }
        return null;
    }

    opsInBounds(pageNumber, bounds) {
        return this.objects(pageNumber).filter((op) => boundsIntersect(opBounds(op), bounds));
    }

    touchedByStroke(pageNumber, stroke, tolerance = 12) {
        return opsTouchedByStroke(this.objects(pageNumber), stroke, tolerance).slice(0, MAX_SELECTION);
    }

    pageBounds(pageNumber) {
        return boundsOfOps(this.objects(pageNumber));
    }

    /* ------------------------------------------------------------------ */
    /* snapshot publishing                                                */
    /* ------------------------------------------------------------------ */

    /** Flattened board state: one operation per surviving object. */
    mergedOps({ maxOps = 20000 } = {}) {
        const out = [];
        for (let page = 1; page <= this.pageCount; page += 1) {
            for (const op of this.objects(page)) {
                if (op.file_id) continue;
                out.push({ ...op, page });
                if (out.length > maxOps) return null;
            }
        }
        return out;
    }

    stats() {
        let objects = 0;
        let tombstones = 0;
        let bytes = 0;
        for (const page of this.pages.values()) {
            objects += page.size;
            tombstones += page.removed.size;
            for (const op of page.ops.values()) {
                bytes += (op.points ? op.points.length * 12 : 40) + 60;
            }
        }
        return { pages: this.pageCount, objects, tombstones, bytes };
    }

    /** Debug/compat view: page → array of operations (see static/js/whiteboard.js). */
    rawPageMap() {
        const out = new Map();
        for (const [pageNumber, page] of this.pages) {
            const list = [];
            for (const id of page.order) {
                const op = page.ops.get(id);
                if (op && !page.removed.has(id)) list.push(op);
            }
            out.set(pageNumber, list);
        }
        return out;
    }
}
