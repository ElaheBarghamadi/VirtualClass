/**
 * whiteboard.js — local whiteboard foundation (HTML Canvas).
 *
 * Supports: pen, eraser, text, undo, redo, clear.
 * Synchronisation between participants (over WebSocket) is a later
 * phase; the stroke model here is already serialisable for that.
 */
class WhiteboardImpl {
    constructor() {
        this.canvas = null;
        this.ctx = null;
        this.tool = 'pen';
        this.color = '#2563eb';
        this.drawing = false;
        this.strokes = [];      // completed strokes (serialisable)
        this.redoStack = [];
        this.current = null;
        this.brush = 3;
        this.eraserSize = 24;
    }

    init() {
        this.canvas = document.getElementById('whiteboard-canvas');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.resize();
        window.addEventListener('resize', () => this.resize());

        // Pointer events cover mouse + touch + pen uniformly.
        this.canvas.addEventListener('pointerdown', (e) => this.start(e));
        this.canvas.addEventListener('pointermove', (e) => this.move(e));
        window.addEventListener('pointerup', () => this.end());

        document.querySelectorAll('.wb-tool').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.wb-tool').forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                this.tool = btn.dataset.tool;
            });
        });
        document.querySelectorAll('.wb-action').forEach((btn) => {
            btn.addEventListener('click', () => this.run(btn.dataset.action));
        });
        document.getElementById('wb-color')?.addEventListener('input', (e) => {
            this.color = e.target.value;
        });
    }

    resize() {
        if (!this.canvas || this.canvas.offsetParent === null) return;
        const rect = this.canvas.getBoundingClientRect();
        if (rect.width === 0) return;
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.redraw();
    }

    // -- drawing ---------------------------------------------------------------
    pos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    start(e) {
        this.canvas.setPointerCapture(e.pointerId);
        const p = this.pos(e);
        if (this.tool === 'text') {
            const text = prompt('متن مورد نظر:');
            if (text) {
                this.strokes.push({ tool: 'text', x: p.x, y: p.y, text, color: this.color, size: 20 });
                this.redoStack = [];
                this.redraw();
            }
            return;
        }
        this.drawing = true;
        this.current = { tool: this.tool, color: this.color, points: [p] };
    }

    move(e) {
        if (!this.drawing || !this.current) return;
        this.current.points.push(this.pos(e));
        this.redraw(this.current);
    }

    end() {
        if (!this.drawing || !this.current) return;
        this.strokes.push(this.current);
        this.current = null;
        this.drawing = false;
        this.redoStack = [];
        this.redraw();
    }

    run(action) {
        if (action === 'undo' && this.strokes.length) {
            this.redoStack.push(this.strokes.pop());
        } else if (action === 'redo' && this.redoStack.length) {
            this.strokes.push(this.redoStack.pop());
        } else if (action === 'clear') {
            this.strokes = [];
            this.redoStack = [];
        }
        this.redraw();
    }

    drawStroke(stroke) {
        const ctx = this.ctx;
        if (stroke.tool === 'text') {
            ctx.fillStyle = stroke.color;
            ctx.font = `${stroke.size}px Vazirmatn, sans-serif`;
            ctx.fillText(stroke.text, stroke.x, stroke.y);
            return;
        }
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (stroke.tool === 'eraser') {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = this.eraserSize;
        } else {
            ctx.strokeStyle = stroke.color;
            ctx.lineWidth = this.brush;
        }
        ctx.beginPath();
        stroke.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
    }

    redraw(live = null) {
        if (!this.ctx) return;
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.strokes.forEach((s) => this.drawStroke(s));
        if (live) this.drawStroke(live);
    }
}

export const Whiteboard = new WhiteboardImpl();
