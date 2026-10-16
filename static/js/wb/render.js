/**
 * wb/render.js — the whiteboard painter.
 *
 * A single ``<canvas>`` shows everything (background, drawings, selection,
 * remote cursors, laser) which keeps the DOM tiny and makes the board trivial
 * to screenshot or export.
 *
 * The board is drawn in *board units* (see geometry.js) and the viewport maps
 * that space onto the canvas with **one uniform scale**: a circle stays a
 * circle, an arrow keeps its direction, and the same op looks identical on a
 * phone, a tablet and a projector.
 *
 * Performance: committed objects are rendered once into an offscreen "scene"
 * canvas that is reused until the page actually changes, so panning, zooming
 * and remote pointers cost only a ``drawImage`` per frame.
 */
import {
    PAGE_H,
    PAGE_W,
    clamp,
    inflate,
    opBounds,
    opOpacity,
    opPoints,
    opRect,
    opSize,
    opWidth,
    opX,
    opY,
    resizeHandles,
    shapeOutline,
    tracePath,
} from './geometry.js';

const BACKGROUNDS = {
    '#ffffff': '#dfe6ef',
};

function defaultCreateCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
}

function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash);
}

/** Stable per-participant colour used for cursors and name tags. */
export function colorForIdentity(identity) {
    const hue = hashString(String(identity || 'x')) % 360;
    return `hsl(${hue} 72% 46%)`;
}

export function shade(hex, amount) {
    const value = String(hex || '#ffffff').replace('#', '');
    const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    const number = parseInt(full, 16);
    const r = clamp(((number >> 16) & 0xff) + amount, 0, 255);
    const g = clamp(((number >> 8) & 0xff) + amount, 0, 255);
    const b = clamp((number & 0xff) + amount, 0, 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function wrapLines(ctx, text, maxWidth) {
    const lines = [];
    for (const rawLine of String(text ?? '').split('\n')) {
        if (!rawLine) {
            lines.push('');
            continue;
        }
        let current = '';
        for (const word of rawLine.split(/(\s+)/)) {
            const candidate = current + word;
            if (ctx.measureText(candidate).width > maxWidth && current.trim()) {
                lines.push(current.trimEnd());
                current = word.trimStart();
            } else {
                current = candidate;
            }
        }
        lines.push(current.trimEnd());
    }
    return lines;
}

export class BoardRenderer {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{createCanvas?:Function, dpr?:number}} [options]
     */
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.createCanvas = options.createCanvas || defaultCreateCanvas;
        this.dpr = options.dpr || (typeof window !== 'undefined'
            ? Math.min(window.devicePixelRatio || 1, 2.5)
            : 1);
        this.width = 0;
        this.height = 0;
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.rect = { x: 0, y: 0, w: PAGE_W, h: PAGE_H };
        this.scale = 1;
        this._scene = null;
        this._sceneKey = '';
        this._sceneCtx = null;
        this._appliedDpr = 0;
        this.unavailable = typeof this.ctx?.scale !== 'function';
    }

    /* ------------------------------------------------------------------ */
    /* viewport                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * Resize the viewport.  Also returns ``true`` when only the device pixel
     * ratio changed: browser zoom and dragging the window onto a second
     * monitor change ``devicePixelRatio`` without changing the CSS size, and
     * the backing store has to be rebuilt (or the board goes blurry/streaky
     * until the next real resize).
     */
    setSize(cssWidth, cssHeight) {
        const width = Math.max(1, Math.floor(cssWidth));
        const height = Math.max(1, Math.floor(cssHeight));
        if (width === this.width && height === this.height && this._appliedDpr === this.dpr) return false;
        this.width = width;
        this.height = height;
        this._appliedDpr = this.dpr;
        this.canvas.width = Math.max(1, Math.round(width * this.dpr));
        this.canvas.height = Math.max(1, Math.round(height * this.dpr));
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
        this.layout();
        return true;
    }

    /** Fit the page into the viewport (zoom 1 = as large as it fits). */
    fitScale() {
        return Math.min(this.width / PAGE_W, this.height / PAGE_H) * 0.98;
    }

    layout() {
        const base = this.fitScale();
        this.scale = base * this.zoom;
        const w = PAGE_W * this.scale;
        const h = PAGE_H * this.scale;
        this.rect = {
            x: (this.width - w) / 2 + this.panX,
            y: (this.height - h) / 2 + this.panY,
            w,
            h,
        };
    }

    setViewport({ zoom, panX, panY } = {}) {
        if (Number.isFinite(zoom)) this.zoom = clamp(zoom, 0.25, 8);
        if (Number.isFinite(panX)) this.panX = panX;
        if (Number.isFinite(panY)) this.panY = panY;
        this.layout();
    }

    resetView() {
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;
        this.layout();
    }

    /** Zoom keeping the board point under the pointer pinned. */
    zoomAt(clientX, clientY, factor) {
        const before = this.toPage(clientX, clientY);
        const next = clamp(this.zoom * factor, 0.25, 8);
        if (next === this.zoom) return;
        this.zoom = next;
        this.layout();
        const after = this.toPage(clientX, clientY);
        this.panX += (after[0] - before[0]) * this.scale;
        this.panY += (after[1] - before[1]) * this.scale;
        this.layout();
    }

    toPage(clientX, clientY) {
        return [(clientX - this.rect.x) / this.scale, (clientY - this.rect.y) / this.scale];
    }

    toClient(x, y) {
        return [this.rect.x + x * this.scale, this.rect.y + y * this.scale];
    }

    /* ------------------------------------------------------------------ */
    /* background                                                         */
    /* ------------------------------------------------------------------ */

    _paintBackground(ctx, style, page) {
        const color = style?.color || '#ffffff';
        const grid = style?.grid || 'none';
        ctx.save();
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, PAGE_W, PAGE_H);
        if (grid !== 'none') {
            const line = shade(color, -26);
            ctx.strokeStyle = line;
            ctx.fillStyle = line;
            ctx.lineWidth = 1;
            const cell = 35;
            if (grid === 'dots') {
                for (let x = cell; x < PAGE_W; x += cell) {
                    for (let y = cell; y < PAGE_H; y += cell) {
                        ctx.beginPath();
                        ctx.arc(x, y, 1.6, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            } else if (grid === 'lines') {
                ctx.beginPath();
                for (let y = cell; y < PAGE_H; y += cell) {
                    ctx.moveTo(0, y + 0.5);
                    ctx.lineTo(PAGE_W, y + 0.5);
                }
                ctx.stroke();
            } else if (grid === 'graph') {
                ctx.beginPath();
                for (let x = cell; x < PAGE_W; x += cell) {
                    ctx.moveTo(x + 0.5, 0);
                    ctx.lineTo(x + 0.5, PAGE_H);
                }
                for (let y = cell; y < PAGE_H; y += cell) {
                    ctx.moveTo(0, y + 0.5);
                    ctx.lineTo(PAGE_W, y + 0.5);
                }
                ctx.stroke();
            } else { // grid
                ctx.beginPath();
                for (let x = cell; x < PAGE_W; x += cell) {
                    ctx.moveTo(x + 0.5, 0);
                    ctx.lineTo(x + 0.5, PAGE_H);
                }
                for (let y = cell; y < PAGE_H; y += cell) {
                    ctx.moveTo(0, y + 0.5);
                    ctx.lineTo(PAGE_W, y + 0.5);
                }
                ctx.stroke();
            }
        }
        ctx.restore();
        return page;
    }

    /* ------------------------------------------------------------------ */
    /* objects                                                            */
    /* ------------------------------------------------------------------ */

    drawOp(ctx, op) {
        switch (op.type) {
            case 'draw':
                this._drawStroke(ctx, op);
                return;
            case 'text':
                this._drawText(ctx, op);
                return;
            case 'sticky':
                this._drawSticky(ctx, op);
                return;
            default:
        }
    }

    _drawStroke(ctx, op) {
        const tool = op.tool || 'pen';
        const width = opWidth(op);
        const color = tool === 'eraser' ? shade(op.color || '#ffffff', -40) : (op.color || '#111827');
        const points = opPoints(op);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = width;
        if (tool === 'highlighter') ctx.globalAlpha = opOpacity(op) === 1 ? 0.35 : opOpacity(op);

        if (tool === 'line' || tool === 'arrow') {
            const [a, b] = points;
            if (!a || !b) {
                ctx.restore();
                return;
            }
            ctx.beginPath();
            ctx.moveTo(a[0], a[1]);
            ctx.lineTo(b[0], b[1]);
            ctx.stroke();
            if (tool === 'arrow') {
                const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
                const size = Math.max(10, width * 3.4);
                const left = [b[0] - size * Math.cos(angle - Math.PI / 7), b[1] - size * Math.sin(angle - Math.PI / 7)];
                const right = [b[0] - size * Math.cos(angle + Math.PI / 7), b[1] - size * Math.sin(angle + Math.PI / 7)];
                ctx.beginPath();
                ctx.moveTo(b[0], b[1]);
                ctx.lineTo(left[0], left[1]);
                ctx.lineTo(right[0], right[1]);
                ctx.closePath();
                ctx.fill();
            }
        } else if (tool === 'rectangle' || tool === 'ellipse') {
            const rect = opRect(op);
            ctx.beginPath();
            if (tool === 'rectangle') {
                ctx.rect(rect.x, rect.y, Math.max(1, rect.w), Math.max(1, rect.h));
            } else {
                ctx.ellipse(
                    rect.x + rect.w / 2,
                    rect.y + rect.h / 2,
                    Math.max(1, rect.w / 2),
                    Math.max(1, rect.h / 2),
                    0, 0, Math.PI * 2,
                );
            }
            ctx.stroke();
        } else if (tool === 'triangle' || tool === 'diamond' || tool === 'star') {
            const outline = shapeOutline(tool, points[0], points[1]);
            if (outline.length) {
                ctx.beginPath();
                ctx.moveTo(outline[0][0], outline[0][1]);
                for (let i = 1; i < outline.length; i += 1) ctx.lineTo(outline[i][0], outline[i][1]);
                ctx.closePath();
                ctx.stroke();
            }
        } else {
            if (points.length < 2) {
                ctx.restore();
                return;
            }
            ctx.beginPath();
            tracePath(ctx, points);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawText(ctx, op) {
        const size = opSize(op);
        const lines = String(op.text ?? '').split('\n');
        const weight = op.bold ? '700' : '400';
        const style = op.italic ? 'italic ' : '';
        const family = '"Vazirmatn", "Segoe UI", Tahoma, sans-serif';
        ctx.save();
        ctx.font = `${style}${weight} ${size}px ${family}`;
        ctx.fillStyle = op.color || '#111827';
        ctx.textBaseline = 'top';
        const align = op.align || 'start';
        ctx.textAlign = align === 'center' ? 'center' : align === 'end' ? 'right' : 'left';
        const x = opX(op);
        let y = opY(op);
        for (const line of lines) {
            ctx.fillText(line, x, y);
            y += size * 1.25;
        }
        ctx.restore();
    }

    _drawSticky(ctx, op) {
        const rect = opRect(op);
        const w = Math.max(80, rect.w || 260);
        const h = Math.max(60, rect.h || 200);
        const size = opSize(op) || 26;
        const fill = op.color || '#fde68a';
        ctx.save();
        ctx.shadowColor = 'rgba(15, 23, 42, .18)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 4;
        ctx.fillStyle = fill;
        this.roundRect(ctx, rect.x, rect.y, w, h, 10);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = shade(fill, -30);
        ctx.lineWidth = 1.5;
        this.roundRect(ctx, rect.x, rect.y, w, h, 10);
        ctx.stroke();
        ctx.font = `400 ${size}px "Vazirmatn", "Segoe UI", Tahoma, sans-serif`;
        ctx.fillStyle = shade(fill, -140);
        ctx.textBaseline = 'top';
        const padding = 14;
        const lines = wrapLines(ctx, op.text || '', w - padding * 2);
        let y = rect.y + padding;
        const maxLines = Math.floor((h - padding * 2) / (size * 1.3));
        for (const line of lines.slice(0, Math.max(0, maxLines))) {
            ctx.fillText(line, rect.x + padding, y);
            y += size * 1.3;
        }
        ctx.restore();
    }

    roundRect(ctx, x, y, w, h, radius) {
        const r = Math.min(radius, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    /* ------------------------------------------------------------------ */
    /* scene cache                                                        */
    /* ------------------------------------------------------------------ */

    _sceneCanvas(key, style) {
        if (this._scene && this._sceneKey === key) return this._scene;
        const pixelRatio = Math.min(2, this.dpr);
        if (!this._scene
            || this._scene.width !== Math.round(PAGE_W * pixelRatio)
            || this._scene.height !== Math.round(PAGE_H * pixelRatio)) {
            this._scene = this.createCanvas(PAGE_W * pixelRatio, PAGE_H * pixelRatio);
            this._sceneCtx = this._scene.getContext('2d');
        }
        const ctx = this._sceneCtx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this._scene.width, this._scene.height);
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        this._paintBackground(ctx, style, key);
        this._sceneKey = key;
        return this._scene;
    }

    /* ------------------------------------------------------------------ */
    /* frame                                                              */
    /* ------------------------------------------------------------------ */

    /**
     * Paint one frame.
     *
     * @param {object} state
     * @param {import('./model.js').BoardModel} state.model
     * @param {number} state.page
     * @param {string[]} [state.selection]
     * @param {object|null} [state.ghost]     in-progress op (freehand/shape)
     * @param {Array} [state.cursors]         remote pointers
     * @param {{x:number,y:number,at:number}|null} [state.laser]
     * @param {{x:number,y:number,w:number,h:number}|null} [state.marquee]
     * @param {string} [state.tool]
     * @param {object|null} [state.eraserHint]
     */
    render(state) {
        const ctx = this.ctx;
        if (!ctx || this.unavailable) return;
        const {
            model, page, selection = [], ghost = null, cursors = [], laser = null,
            marquee = null, tool = 'pen', eraserHint = null, editing = null,
            ghosts = [],
        } = state;

        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        const outside = BACKGROUNDS['#ffffff'];
        ctx.fillStyle = outside;
        ctx.fillRect(0, 0, this.width, this.height);

        const style = model?.style(page) || { color: '#ffffff', grid: 'none' };
        const pageState = model?.pages?.get(page);
        const key = `${page}:${pageState ? pageState.version : 0}:${style.color}:${style.grid}`;
        const scene = this._sceneCanvas(key, style);
        if (pageState) {
            const sceneCtx = this._sceneCtx;
            for (const op of model.objects(page)) {
                if (editing && op.id === editing) continue; // being edited inline
                this.drawOp(sceneCtx, op);
            }
        }

        // page sheet + soft shadow
        ctx.save();
        ctx.shadowColor = 'rgba(15, 23, 42, .28)';
        ctx.shadowBlur = 22;
        ctx.shadowOffsetY = 6;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
        ctx.restore();
        ctx.drawImage(scene, this.rect.x, this.rect.y, this.rect.w, this.rect.h);
        ctx.strokeStyle = 'rgba(15, 23, 42, .12)';
        ctx.lineWidth = 1;
        ctx.strokeRect(this.rect.x + 0.5, this.rect.y + 0.5, this.rect.w - 1, this.rect.h - 1);

        // live drawing: ours (while the pointer is down) and our peers' ghosts
        const live = [];
        if (ghost) live.push(ghost);
        for (const remote of ghosts) if (remote) live.push(remote);
        if (live.length) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
            ctx.clip();
            ctx.translate(this.rect.x, this.rect.y);
            ctx.scale(this.scale, this.scale);
            for (const op of live) this.drawOp(ctx, op);
            ctx.restore();
        }

        if (eraserHint && eraserHint.length) {
            ctx.save();
            ctx.strokeStyle = 'rgba(225, 29, 72, .8)';
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            for (const op of eraserHint) {
                const bounds = inflate(opBounds(op), 6);
                const [cx, cy] = this.toClient(bounds.x, bounds.y);
                ctx.strokeRect(cx, cy, bounds.w * this.scale, bounds.h * this.scale);
            }
            ctx.restore();
        }

        if (selection.length && model) {
            this._drawSelection(ctx, model, page, selection);
        }

        if (marquee) {
            const [x, y] = this.toClient(marquee.x, marquee.y);
            ctx.save();
            ctx.fillStyle = 'rgba(37, 99, 235, .12)';
            ctx.strokeStyle = 'rgba(37, 99, 235, .8)';
            ctx.setLineDash([5, 4]);
            ctx.fillRect(x, y, marquee.w * this.scale, marquee.h * this.scale);
            ctx.strokeRect(x, y, marquee.w * this.scale, marquee.h * this.scale);
            ctx.restore();
        }

        for (const cursor of cursors) {
            this._drawCursor(ctx, cursor);
        }
        if (laser) this._drawLaser(ctx, laser);
        if (tool === 'pan') {
            ctx.fillStyle = 'rgba(15, 23, 42, .02)';
            ctx.fillRect(0, 0, this.width, this.height);
        }
    }

    _drawSelection(ctx, model, page, selection) {
        const ops = selection
            .map((id) => model.getOp(page, id))
            .filter(Boolean);
        if (!ops.length) return;
        ctx.save();
        for (const op of ops) {
            const bounds = inflate(opBounds(op), 6);
            const [x, y] = this.toClient(bounds.x, bounds.y);
            ctx.strokeStyle = 'rgba(37, 99, 235, .9)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 3]);
            ctx.strokeRect(x, y, bounds.w * this.scale, bounds.h * this.scale);
        }
        // handles only make sense for a single, resizable object
        if (ops.length === 1 && ['sticky', 'text', 'draw'].includes(ops[0].type)) {
            const bounds = inflate(opBounds(ops[0]), 6);
            const handles = resizeHandles(bounds);
            ctx.setLineDash([]);
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = 'rgba(37, 99, 235, 1)';
            ctx.lineWidth = 1.5;
            for (const [hx, hy] of Object.values(handles)) {
                const [cx, cy] = this.toClient(hx, hy);
                ctx.beginPath();
                ctx.rect(cx - 5, cy - 5, 10, 10);
                ctx.fill();
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    _drawCursor(ctx, cursor) {
        const [x, y] = this.toClient(cursor.x, cursor.y);
        const color = cursor.color || colorForIdentity(cursor.identity);
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(0, 17);
        ctx.lineTo(5, 12.5);
        ctx.lineTo(11, 11);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.9)';
        ctx.lineWidth = 1;
        ctx.stroke();
        if (cursor.name) {
            ctx.font = '600 12px "Vazirmatn", "Segoe UI", Tahoma, sans-serif';
            const width = ctx.measureText(cursor.name).width + 12;
            ctx.fillStyle = color;
            this.roundRect(ctx, 12, 12, width, 20, 6);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.textBaseline = 'middle';
            ctx.fillText(cursor.name, 18, 23);
        }
        ctx.restore();
    }

    _drawLaser(ctx, laser) {
        const age = Math.max(0, (performance.now ? performance.now() : Date.now()) - laser.at);
        const alpha = clamp(1 - age / 900, 0, 1);
        if (alpha <= 0) return;
        const [x, y] = this.toClient(laser.x, laser.y);
        ctx.save();
        ctx.globalAlpha = alpha;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, 26);
        gradient.addColorStop(0, 'rgba(239, 68, 68, 1)');
        gradient.addColorStop(0.35, 'rgba(239, 68, 68, .85)');
        gradient.addColorStop(1, 'rgba(239, 68, 68, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, 26, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    /* ------------------------------------------------------------------ */
    /* export                                                             */
    /* ------------------------------------------------------------------ */

    /**
     * Render one page to a standalone canvas.
     * @param {import('./model.js').BoardModel} model
     * @param {number} page
     * @param {number} multiplier pixels per board unit
     */
    exportCanvas(model, page, multiplier = 1) {
        const canvas = this.createCanvas(PAGE_W * multiplier, PAGE_H * multiplier);
        const ctx = canvas.getContext('2d');
        ctx.setTransform(multiplier, 0, 0, multiplier, 0, 0);
        this._paintBackground(ctx, model.style(page), page);
        for (const op of model.objects(page)) this.drawOp(ctx, op);
        return canvas;
    }

    exportDataURL(model, page, multiplier = 1.6) {
        return this.exportCanvas(model, page, multiplier).toDataURL('image/png');
    }

    /** Small preview used by the pages panel. */
    thumbnail(model, page, width, height) {
        const canvas = this.createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        const scale = Math.min(width / PAGE_W, height / PAGE_H);
        const offsetX = (width - PAGE_W * scale) / 2;
        const offsetY = (height - PAGE_H * scale) / 2;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        ctx.beginPath();
        ctx.rect(0, 0, PAGE_W, PAGE_H);
        ctx.clip();
        this._paintBackground(ctx, model.style(page), page);
        for (const op of model.objects(page)) this.drawOp(ctx, op);
        ctx.restore();
        ctx.strokeStyle = 'rgba(15, 23, 42, .15)';
        ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
        return canvas;
    }
}
