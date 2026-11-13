/**
 * check_board_geometry.mjs — run the REAL whiteboard geometry on several screen
 * sizes and assert the page keeps its fixed 12:7 shape.
 *
 * The methods are lifted verbatim from `static/js/whiteboard.js` (no copies to
 * drift out of sync), so this fails the moment the board goes back to
 * stretching itself to the wrapper.
 *
 *   node scripts/check_board_geometry.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync('/home/user/VirtualClass/static/js/whiteboard.js', 'utf8');

/** Pull a whole method declaration (params + body) out of the real file. */
function method(name) {
  const start = src.indexOf(`\n    ${name}(`);
  if (start < 0) throw new Error(`method ${name} not found`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start + 1, j + 1); }
  }
  throw new Error('unbalanced');
}

const REF_W = 1200, REF_H = 700;

class WB {
  constructor(w, h) {
    this.width = w; this.height = h;
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.vt = null;
    this.canvas = { setViewportTransform: (m) => { this.vt = m; } };
  }
  _w() { return this.width; }
  _h() { return this.height; }
  _applyBgLayer() {}
  _applyCursorScale() {}
  _updateZoomUI() {}
  _render() {}
}

const names = ['_fit', '_ox', '_oy', '_zs', '_pageRect', '_clampPan', '_applyTransform', 'setZoom', '_worldToCss', '_clampToPage'];
const body = names.map((n) => method(n)).join('\n');
const factory = new Function('REF_W', 'REF_H', 'MIN_ZOOM', 'MAX_ZOOM', `
  return class extends Object {
    ${body}
  };
`);
const MIN_ZOOM = 1, MAX_ZOOM = 4;
const Methods = factory(REF_W, REF_H, MIN_ZOOM, MAX_ZOOM);
for (const name of names) WB.prototype[name] = Methods.prototype[name];

const sizes = [[1000, 600], [390, 500], [1440, 900], [768, 1024], [1920, 760], [320, 380]];
let failures = 0;
const fail = (msg) => { failures++; console.log('FAIL:', msg); };

for (const [w, h] of sizes) {
  const b = new WB(w, h);
  b.panX = 0; b.panY = 0;
  b._clampPan();
  b._applyTransform();
  const p = b._pageRect();
  const aspect = p.w / p.h;
  const want = REF_W / REF_H;
  if (Math.abs(aspect - want) > 1e-6) fail(`${w}x${h}: aspect ${aspect.toFixed(4)} != ${want.toFixed(4)}`);
  if (p.x < -0.001 || p.y < -0.001) fail(`${w}x${h}: page starts outside the wrap (${p.x},${p.y})`);
  if (p.x + p.w > w + 0.001 || p.y + p.h > h + 0.001) fail(`${w}x${h}: page overflows the wrap`);
  // centred letterbox at 100%
  if (Math.abs((p.x - (w - p.x - p.w))) > 0.01) fail(`${w}x${h}: not horizontally centred`);
  if (Math.abs((p.y - (h - p.y - p.h))) > 0.01) fail(`${w}x${h}: not vertically centred`);
  // one uniform scale in the transform
  const [a, bb2, c, d] = b.vt;
  if (a !== d || bb2 !== 0 || c !== 0) fail(`${w}x${h}: transform is not uniform (${b.vt})`);
  // the top-left of the page maps to the top-left of the page rect
  const tl = b._worldToCss({ x: 0, y: 0 });
  if (Math.abs(tl.x - p.x) > 1e-6 || Math.abs(tl.y - p.y) > 1e-6) fail(`${w}x${h}: world→css disagrees with the page rect`);

  // zoom about a point keeps that point fixed, aspect still intact.
  // (The anchor can only hold where the pan clamp allows it, so the exactness
  // check uses the middle of the page — the corner case is checked below.)
  const cx = w * 0.5, cy = h * 0.5;
  const beforeX = (cx - p.x) / p.w, beforeY = (cy - p.y) / p.h;
  b.setZoom(2.5, cx, cy);
  const p2 = b._pageRect();
  if (Math.abs(p2.w / p2.h - want) > 1e-6) fail(`${w}x${h}: zoom broke the aspect`);
  const afterX = (cx - p2.x) / p2.w, afterY = (cy - p2.y) / p2.h;
  if (Math.abs(afterX - beforeX) > 1e-6 || Math.abs(afterY - beforeY) > 1e-6) {
    fail(`${w}x${h}: zoom drifted the anchor (${beforeX.toFixed(4)}→${afterX.toFixed(4)}, ${beforeY.toFixed(4)}→${afterY.toFixed(4)})`);
  }
  // panning cannot expose the desk while zoomed in
  b.panX = 5000; b.panY = 5000; b._clampPan();
  const p3 = b._pageRect();
  if (p3.x > 0.5 || p3.y > 0.5) fail(`${w}x${h}: pan escaped the page (${p3.x},${p3.y})`);
  b.panX = -5000; b.panY = -5000; b._clampPan();
  const p4 = b._pageRect();
  if (p4.x + p4.w < w - 0.5 || p4.y + p4.h < h - 0.5) fail(`${w}x${h}: pan left a gap at the far edge`);

  // zooming at a corner keeps the page covering the wrapper (no desk gap)
  b.setZoom(1); b.panX = 0; b.panY = 0;
  b.setZoom(3, 4, h - 4);
  const pc = b._pageRect();
  if (pc.x > 0.5 || pc.y > 0.5 || pc.x + pc.w < w - 0.5 || pc.y + pc.h < h - 0.5) {
    fail(`${w}x${h}: corner zoom left a gap around the page (${JSON.stringify(pc)})`);
  }

  // reset: page centred again
  b.zoom = 1; b.panX = 0; b.panY = 0; b._clampPan(); b._applyTransform();
  console.log(`${String(w).padStart(4)}x${String(h).padStart(4)} → page ${p.w.toFixed(1)}x${p.h.toFixed(1)} (fit ${(p.w / REF_W).toFixed(3)}) letterbox y=${p.y.toFixed(1)}`);
}

// ink is confined to the page
const b = new WB(1000, 600);
const clamped = b._clampToPage({ x: -50, y: 5000 });
if (clamped.x !== 0 || clamped.y !== REF_H) fail('pointer clamp does not hold ink on the page');

console.log(failures ? `\n${failures} failure(s)` : '\nall geometry checks passed');
process.exit(failures ? 1 : 0);
