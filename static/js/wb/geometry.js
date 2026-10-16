/**
 * wb/geometry.js — pure geometry + coordinate helpers for the whiteboard.
 *
 * Coordinate spaces
 * -----------------
 * 1. **wire ops** — what travels over the socket (and is stored server side):
 *    board operations use page *fractions* (``norm: 1``); annotation ops of
 *    the presentation viewer use document pixels.
 * 2. **board units** — the engine's internal space: one page is
 *    ``PAGE_W × PAGE_H`` reference units, where ``PAGE_H === 700`` and stroke
 *    widths / font sizes are already expressed in these units. Working in a
 *    fixed unit space is what makes a circle stay a circle on every screen:
 *    the page is fitted into the viewport with a single uniform scale.
 * 3. **client pixels** — what the canvas actually paints, produced by the
 *    renderer's viewport transform.
 *
 * Nothing here touches the DOM, which keeps it unit-testable in Node.
 */

/** Reference units of one page height (stroke widths are relative to this). */
export const PAGE_H = 700;
/** Board pages are 16:9, like the projectors and projectors-in-browsers they mirror. */
export const PAGE_ASPECT = 16 / 9;
export const PAGE_W = PAGE_H * PAGE_ASPECT;

/** Stroke width slider range, in reference units. */
export const MIN_WIDTH = 1;
export const MAX_WIDTH = 60;

export function clamp(value, low, high) {
    return value < low ? low : value > high ? high : value;
}

export function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

export function nearlyEqual(a, b, epsilon = 0.5) {
    return Math.abs(a - b) <= epsilon;
}

/* -------------------------------------------------------------------------- */
/* wire op → board units                                                      */
/* -------------------------------------------------------------------------- */

export function isFileOp(op) {
    return Boolean(op && op.file_id);
}

export function opX(op) {
    const x = op.x || 0;
    return op.norm ? x * PAGE_W : x;
}

export function opY(op) {
    const y = op.y || 0;
    return op.norm ? y * PAGE_H : y;
}

/**
 * Points of a freehand/shape op in board units.
 *
 * Both shapes of the wire format are accepted — pairs (``[[x, y], …]``, what
 * this client sends) and the flat form (``[x, y, x, y, …]``) older clients
 * stored — and malformed entries are dropped instead of throwing: one bad
 * operation must never be able to break the render loop for everyone.
 */
export function opPoints(op) {
    const raw = op && op.points;
    if (!Array.isArray(raw) || !raw.length) return [];
    const scaleX = op.norm ? PAGE_W : 1;
    const scaleY = op.norm ? PAGE_H : 1;
    const out = [];
    if (typeof raw[0] === 'number') {
        for (let index = 0; index + 1 < raw.length; index += 2) {
            const x = Number(raw[index]);
            const y = Number(raw[index + 1]);
            if (Number.isFinite(x) && Number.isFinite(y)) out.push([x * scaleX, y * scaleY]);
        }
        return out;
    }
    for (const point of raw) {
        if (!point || typeof point.length !== 'number' || point.length < 2) continue;
        const x = Number(point[0]);
        const y = Number(point[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) out.push([x * scaleX, y * scaleY]);
    }
    return out;
}

export function opWidth(op) {
    const width = Number(op.width);
    return Number.isFinite(width) && width > 0 ? width : 3;
}

export function opSize(op) {
    const size = Number(op.size);
    return Number.isFinite(size) && size > 0 ? size : 26;
}

export function opOpacity(op) {
    const opacity = Number(op.opacity);
    return Number.isFinite(opacity) && opacity > 0 && opacity <= 1 ? opacity : 1;
}

/** Default size of a sticky note, in board units. */
export const STICKY_W = 330;
export const STICKY_H = 250;

/** Rectangle of a rect-ish op (sticky / rectangle / ellipse) in board units. */
export function opRect(op) {
    if (op.type === 'sticky') {
        const scaleX = op.norm ? PAGE_W : 1;
        const scaleY = op.norm ? PAGE_H : 1;
        return {
            x: opX(op),
            y: opY(op),
            w: op.w !== undefined ? op.w * scaleX : STICKY_W,
            h: op.h !== undefined ? op.h * scaleY : STICKY_H,
        };
    }
    if (op.tool === 'rectangle' || op.tool === 'ellipse') {
        const [a, b] = opPoints(op);
        if (a && b) {
            return {
                x: Math.min(a[0], b[0]),
                y: Math.min(a[1], b[1]),
                w: Math.abs(b[0] - a[0]),
                h: Math.abs(b[1] - a[1]),
            };
        }
    }
    // legacy geometry (older clients stored left/top + w/h or rx/ry)
    if (op.left !== undefined || op.top !== undefined) {
        const scaleX = op.norm ? PAGE_W : 1;
        const scaleY = op.norm ? PAGE_H : 1;
        const x = (op.left || 0) * scaleX;
        const y = (op.top || 0) * scaleY;
        const w = op.rx !== undefined ? 2 * op.rx * scaleX : (op.w ?? op.width ?? 0) * scaleX;
        const h = op.ry !== undefined ? 2 * op.ry * scaleY : (op.h ?? op.height ?? 0) * scaleY;
        return { x, y, w, h };
    }
    const x = opX(op);
    const y = opY(op);
    return { x, y, w: 0, h: 0 };
}

/** Axis aligned bounds of any op, in board units. */
export function opBounds(op) {
    switch (op.type) {
        case 'draw': {
            const tool = op.tool || 'pen';
            if (tool === 'rectangle' || tool === 'ellipse') return opRect(op);
            if (tool === 'triangle' || tool === 'diamond' || tool === 'star') {
                const points = opPoints(op);
                return polylineBounds(shapeOutline(tool, points[0], points[1]));
            }
            return polylineBounds(opPoints(op));
        }
        case 'text': {
            const size = opSize(op);
            const lines = String(op.text || '').split('\n');
            const width = Math.max(1, ...lines.map((line) => line.length)) * size * 0.55;
            return { x: opX(op), y: opY(op), w: width, h: size * 1.25 * lines.length };
        }
        case 'sticky': {
            const rect = opRect(op);
            const w = rect.w || 260;
            const h = rect.h || 200;
            return { x: rect.x, y: rect.y, w, h };
        }
        default: {
            const x = opX(op);
            const y = opY(op);
            return { x, y, w: 0, h: 0 };
        }
    }
}

export function polylineBounds(points) {
    if (!points || !points.length) return { x: 0, y: 0, w: 0, h: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionBounds(a, b) {
    if (!a) return b;
    if (!b) return a;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
        x,
        y,
        w: Math.max(a.x + a.w, b.x + b.w) - x,
        h: Math.max(a.y + a.h, b.y + b.h) - y,
    };
}

export function boundsOfOps(ops) {
    return ops.reduce((acc, op) => unionBounds(acc, opBounds(op)), null);
}

export function inflate(bounds, amount) {
    return { x: bounds.x - amount, y: bounds.y - amount, w: bounds.w + amount * 2, h: bounds.h + amount * 2 };
}

export function pointInBounds(bounds, x, y) {
    return x >= bounds.x && x <= bounds.x + bounds.w && y >= bounds.y && y <= bounds.y + bounds.h;
}

export function boundsIntersect(a, b) {
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

/* -------------------------------------------------------------------------- */
/* distance / hit testing                                                     */
/* -------------------------------------------------------------------------- */

export function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function polylineDistance(points, px, py) {
    if (!points || !points.length) return Infinity;
    if (points.length === 1) return Math.hypot(px - points[0][0], py - points[0][1]);
    let best = Infinity;
    for (let i = 0; i < points.length - 1; i += 1) {
        const distance = pointSegmentDistance(
            px, py, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1],
        );
        if (distance < best) best = distance;
    }
    return best;
}

export function polygonDistance(points, px, py, closed = true) {
    if (!points || points.length < 2) return Infinity;
    const chain = closed ? [...points, points[0]] : points;
    return polylineDistance(chain, px, py);
}

/** Outline vertices of a polygon shape built from two drag anchors. */
export function shapeOutline(tool, a, b) {
    if (!a || !b) return [];
    const x0 = Math.min(a[0], b[0]);
    const y0 = Math.min(a[1], b[1]);
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const w = x1 - x0;
    const h = y1 - y0;
    switch (tool) {
        case 'triangle':
            return [[cx, y0], [x1, y1], [x0, y1]];
        case 'diamond':
            return [[cx, y0], [x1, cy], [cx, y1], [x0, cy]];
        case 'star': {
            const points = [];
            const outer = Math.max(w, h) / 2;
            const inner = outer * 0.45;
            const rx = w / 2;
            const ry = h / 2;
            for (let i = 0; i < 10; i += 1) {
                const angle = (-Math.PI / 2) + (i * Math.PI) / 5;
                const factor = i % 2 === 0 ? 1 : inner / outer;
                points.push([cx + Math.cos(angle) * rx * factor, cy + Math.sin(angle) * ry * factor]);
            }
            return points;
        }
        default:
            return [[a[0], a[1]], [b[0], b[1]]];
    }
}

/**
 * Distance from a point to the *visible ink* of an op (board units).
 * Shapes are matched against their outline, text/sticky against their box.
 */
export function opDistance(op, px, py) {
    const tool = op.tool || '';
    if (op.type === 'text' || op.type === 'sticky' || tool === 'rectangle' || tool === 'ellipse') {
        const bounds = inflate(opBounds(op), 8);
        if (pointInBounds(bounds, px, py)) return 0;
        const dx = Math.max(bounds.x - px, 0, px - (bounds.x + bounds.w));
        const dy = Math.max(bounds.y - py, 0, py - (bounds.y + bounds.h));
        return Math.hypot(dx, dy);
    }
    if (tool === 'triangle' || tool === 'diamond' || tool === 'star') {
        const points = opPoints(op);
        return polygonDistance(shapeOutline(tool, points[0], points[1]), px, py);
    }
    return polylineDistance(opPoints(op), px, py);
}

/** True when a point is close enough to select / erase an op. */
export function opHit(op, px, py, tolerance = 8) {
    return opDistance(op, px, py) <= tolerance + opWidth(op) / 2;
}

/** Every op of ``ops`` touched by a polyline (used by the eraser). */
export function opsTouchedByStroke(ops, stroke, tolerance = 10) {
    const hits = [];
    for (const op of ops) {
        const extra = tolerance + opWidth(op) / 2;
        if (op.type === 'text' || op.type === 'sticky' || op.tool === 'rectangle'
            || op.tool === 'ellipse' || op.tool === 'triangle' || op.tool === 'diamond'
            || op.tool === 'star') {
            // closed shapes: touching the box counts, walking the outline is enough
            const bounds = inflate(opBounds(op), extra);
            if (stroke.some(([x, y]) => pointInBounds(bounds, x, y))) {
                hits.push(op);
                continue;
            }
        }
        for (let i = 0; i < stroke.length - 1; i += 1) {
            const [ax, ay] = stroke[i];
            const [bx, by] = stroke[i + 1];
            if (opDistance(op, ax, ay) <= extra || opDistance(op, bx, by) <= extra) {
                hits.push(op);
                break;
            }
        }
    }
    return hits;
}

/* -------------------------------------------------------------------------- */
/* smoothing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resample a raw pointer trail into a smooth polyline.
 *
 * The browser gives us 30–120 noisy samples per stroke; replaying them with
 * ``lineTo`` looks jagged and stores far more points than the drawing needs.
 * Quadratic mid-point interpolation (the classic "smooth ink" trick) plus a
 * minimum-distance filter gives a natural, teacher-friendly line with a
 * fraction of the payload.
 */
export function smoothPoints(rawPoints, { minDistance = 2.2, maxPoints = 1024 } = {}) {
    if (!rawPoints || rawPoints.length < 3) return (rawPoints || []).map(([x, y]) => [x, y]);
    const packed = [];
    for (const point of rawPoints) {
        const last = packed[packed.length - 1];
        if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= minDistance) {
            packed.push([point[0], point[1]]);
        }
    }
    if (packed.length < 3) return packed.length ? packed : rawPoints.map(([x, y]) => [x, y]);

    const out = [packed[0]];
    for (let i = 1; i < packed.length - 1; i += 1) {
        const [x0, y0] = packed[i];
        const [x1, y1] = packed[i + 1];
        out.push([(x0 + x1) / 2, (y0 + y1) / 2]);
        if (out.length >= maxPoints) break;
    }
    out.push(packed[packed.length - 1]);
    return out;
}

/** Chaikin style corner cutting used for live previews (cheap, allocation-light). */
export function chaikin(points, iterations = 1) {
    let result = points;
    for (let pass = 0; pass < iterations; pass += 1) {
        if (result.length < 3) return result;
        const out = [result[0]];
        for (let i = 0; i < result.length - 1; i += 1) {
            const [x0, y0] = result[i];
            const [x1, y1] = result[i + 1];
            out.push([x0 + (x1 - x0) * 0.25, y0 + (y1 - y0) * 0.25]);
            out.push([x0 + (x1 - x0) * 0.75, y0 + (y1 - y0) * 0.75]);
        }
        out.push(result[result.length - 1]);
        result = out;
    }
    return result;
}

/**
 * Draw a smoothed path through ``points`` on a 2d context. The caller keeps
 * full control of stroke/fill styling.
 */
export function tracePath(ctx, points) {
    if (!points.length) return;
    if (points.length === 1) {
        ctx.moveTo(points[0][0], points[0][1]);
        return;
    }
    ctx.moveTo(points[0][0], points[0][1]);
    if (points.length === 2) {
        ctx.lineTo(points[1][0], points[1][1]);
        return;
    }
    for (let i = 1; i < points.length - 1; i += 1) {
        const [cx, cy] = points[i];
        const [nx, ny] = points[i + 1];
        ctx.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last[0], last[1]);
}

/** Shortest rotation-free rectangle handle positions. */
export function resizeHandles(bounds) {
    const { x, y, w, h } = bounds;
    const mx = x + w / 2;
    const my = y + h / 2;
    return {
        nw: [x, y],
        n: [mx, y],
        ne: [x + w, y],
        e: [x + w, my],
        se: [x + w, y + h],
        s: [mx, y + h],
        sw: [x, y + h],
        w: [x, my],
    };
}

/** Apply a handle drag to a bounds rectangle. */
export function applyResize(bounds, handle, dx, dy) {
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
    return { x, y, w, h };
}
