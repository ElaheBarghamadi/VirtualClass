/**
 * recorder.js — on-device class recording (no server involved).
 *
 * The server never sees a byte of the recording: the visible stage is
 * composited on an offscreen canvas, every audible participant is mixed
 * with the Web Audio API, and MediaRecorder writes a single WebM blob that
 * stays in memory so it can be played back or saved before it is released.
 *
 * Performance budget (this runs on a teacher's laptop while teaching):
 *  · capped frames per second and a downscaled canvas (854×480 by default),
 *  · a `setTimeout` scheduler instead of rAF — a background tab costs ~1 Hz,
 *  · fixed-size drawing only for videos that actually have frames,
 *  · one AudioContext for all sources, torn down on stop,
 *  · hard caps on duration and memory, so a forgotten recording cannot
 *    exhaust RAM or block the UI.
 */
import { Media } from './media.js';

/** Presets: `light` is the default because it barely touches the CPU. */
export const RECORD_PRESETS = {
    light: { fps: 12, width: 854, height: 480, videoBps: 900_000, audioBps: 48_000 },
    hd: { fps: 24, width: 1280, height: 720, videoBps: 2_200_000, audioBps: 96_000 },
};

const MAX_BYTES = 420 * 1024 * 1024;   // ~420 MB in memory, then auto-stop
const MAX_MS = 2 * 60 * 60 * 1000;     // 2 hours per recording
const MAX_AUDIO_SOURCES = 24;          // mixer guard
const MAX_TILES = 6;                   // 3×2 grid, more would be unreadable
const TILE_REFRESH_FRAMES = 30;        // re-scan the DOM ~ twice a second

function pickMimeType() {
    const candidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4',
    ];
    if (!window.MediaRecorder?.isTypeSupported) return '';
    return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

class LocalRecorderImpl {
    constructor() {
        this.state = 'idle';        // idle | recording | stopping
        this.preset = 'light';
        this.recorder = null;
        this.canvas = null;
        this.ctx = null;
        this.audioCtx = null;
        this.audioNodes = [];
        this.chunks = [];
        this.bytes = 0;
        this.startedAt = 0;
        this.timer = null;
        this._frame = 0;
        this._videos = [];
        this._watchdog = null;
        this.stoppedReason = '';    // '' | 'size' | 'duration' | 'manual'
        this.onChange = () => {};   // room.js hook (button state / timer)
    }

    get recording() {
        return this.state === 'recording';
    }

    get supported() {
        return Boolean(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);
    }

    /** Seconds since the recording started (0 when idle). */
    get elapsed() {
        return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
    }

    // ---------------------------------------------------------------- start
    async start(preset = 'light') {
        if (this.state !== 'idle') return null;
        if (!this.supported) throw new Error('unsupported');

        const conf = RECORD_PRESETS[preset] || RECORD_PRESETS.light;
        this.preset = RECORD_PRESETS[preset] ? preset : 'light';

        // 1. canvas + its video track (cheap: fixed size, capped fps)
        this.canvas = document.createElement('canvas');
        this.canvas.width = conf.width;
        this.canvas.height = conf.height;
        this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
        const canvasStream = this.canvas.captureStream(conf.fps);

        // 2. audio: mix every audible source into ONE track
        const mixed = new MediaStream();
        const audioTrack = await this._buildAudioMix();
        if (audioTrack) mixed.addTrack(audioTrack);
        canvasStream.getVideoTracks().forEach((t) => mixed.addTrack(t));

        if (!mixed.getTracks().length) {
            this._teardown();
            throw new Error('no-media');
        }

        // Nothing on stage and nobody talking → nothing worth recording.
        if (!audioTrack && !this._hasVisualSource()) {
            this._teardown();
            throw new Error('no-media');
        }

        // 3. recorder
        const mimeType = pickMimeType();
        const options = {
            videoBitsPerSecond: conf.videoBps,
            audioBitsPerSecond: conf.audioBps,
        };
        if (mimeType) options.mimeType = mimeType;
        try {
            this.recorder = new MediaRecorder(mixed, options);
        } catch (e) {
            this._teardown();
            throw new Error('unsupported');
        }

        this._stream = mixed;
        this.chunks = [];
        this.bytes = 0;
        this.stoppedReason = '';
        this._frame = 0;
        this._videos = this._videoTiles();

        this.recorder.ondataavailable = (ev) => {
            if (!ev.data || !ev.data.size) return;
            this.chunks.push(ev.data);
            this.bytes += ev.data.size;
            if (this.bytes > MAX_BYTES && this.state === 'recording') {
                // Stop itself instead of letting the tab run out of memory.
                this.stoppedReason = 'size';
                this.stop().catch(() => {});
            }
        };
        this.recorder.onerror = () => {
            this.stoppedReason = 'error';
            this.stop().catch(() => {});
        };

        this.recorder.start(2000);           // 2s chunks → bounded memory spikes
        this.state = 'recording';
        this.startedAt = Date.now();
        this._schedule();
        this._watchdog = setTimeout(() => {
            if (this.state === 'recording') {
                this.stoppedReason = 'duration';
                this.stop().catch(() => {});
            }
        }, MAX_MS);
        this.onChange(this);
        return { preset: this.preset, fps: conf.fps };
    }

    // ----------------------------------------------------------------- stop
    /** @returns {Promise<{blob: Blob, url: string, duration: number, size: number, preset: string, reason: string} | null>} */
    stop() {
        if (this.state !== 'recording') return Promise.resolve(null);
        this.state = 'stopping';
        clearTimeout(this.timer);
        clearTimeout(this._watchdog);
        this.timer = null;
        const duration = Date.now() - this.startedAt;
        const reason = this.stoppedReason || 'manual';
        const recorder = this.recorder;

        return new Promise((resolve) => {
            const finish = () => {
                const type = recorder?.mimeType || 'video/webm';
                const blob = new Blob(this.chunks, { type });
                this.chunks = [];
                this._teardown();
                this.state = 'idle';
                this.startedAt = 0;
                this.onChange(this);
                resolve({
                    blob,
                    url: blob.size ? URL.createObjectURL(blob) : '',
                    duration,
                    size: blob.size,
                    preset: this.preset,
                    reason,
                });
            };
            recorder.onstop = finish;
            try {
                recorder.stop();
            } catch (e) {
                finish();
            }
        });
    }

    // ------------------------------------------------------------- internals
    _schedule() {
        const fps = (RECORD_PRESETS[this.preset] || RECORD_PRESETS.light).fps;
        const frameMs = 1000 / fps;
        const loop = () => {
            if (this.state !== 'recording') return;
            const t0 = performance.now();
            this._draw();
            this._frame += 1;
            // Compensate for draw cost so we never queue frames up.
            const wait = Math.max(16, frameMs - (performance.now() - t0));
            this.timer = setTimeout(loop, wait);
        };
        this.timer = setTimeout(loop, 0);
    }

    /** Which stage view is on screen right now (mirrors room.js switchView). */
    _activeView() {
        for (const name of ['media', 'screen', 'whiteboard', 'presentation']) {
            const el = document.getElementById(`view-${name}`);
            if (el && !el.classList.contains('hidden')) return name;
        }
        return 'media';
    }

    _hasVisualSource() {
        const view = this._activeView();
        if (view === 'presentation' || view === 'whiteboard') return true;
        return this._videoTiles().length > 0;
    }

    /** Live <video> elements that actually have pixels right now. */
    _videoTiles() {
        const out = [];
        for (const el of document.querySelectorAll('video')) {
            if (!el.srcObject || el.readyState < 2 || !el.videoWidth) continue;
            const hasVideo = el.srcObject.getVideoTracks().some((t) => t.readyState === 'live');
            if (!hasVideo) continue;
            if (el.offsetParent === null && !el.closest('#tiles')) continue; // hidden
            out.push(el);
            if (out.length >= MAX_TILES) break;
        }
        return out;
    }

    _draw() {
        const { ctx, canvas } = this;
        if (!ctx) return;
        const W = canvas.width;
        const H = canvas.height;
        ctx.fillStyle = '#0b0d18';
        ctx.fillRect(0, 0, W, H);

        const view = this._activeView();
        if (view === 'presentation') {
            // slide + its annotation layer, exactly as the room shows them
            this._drawLayers([
                document.getElementById('pres-canvas'),
                document.getElementById('pres-annot-canvas'),
            ], W, H, '#0b0d18');
            return;
        }
        if (view === 'whiteboard') {
            this._drawLayers([
                document.querySelector('.wb-canvas-wrap .lower-canvas') || document.getElementById('whiteboard-canvas'),
                document.querySelector('.wb-canvas-wrap .upper-canvas'),
            ], W, H, '#ffffff');
            return;
        }
        this._drawVideoGrid(W, H);
    }

    /** Contain-fit a stack of same-sized canvases (page render + strokes). */
    _drawLayers(layers, W, H, background) {
        const first = layers.find(Boolean);
        if (!first) return;
        const sw = first.width;
        const sh = first.height;
        if (!sw || !sh) return;
        const scale = Math.min(W / sw, H / sh);
        const dw = sw * scale;
        const dh = sh * scale;
        const x = (W - dw) / 2;
        const y = (H - dh) / 2;
        this.ctx.fillStyle = background;
        this.ctx.fillRect(x, y, dw, dh);
        layers.forEach((layer) => {
            if (!layer || !layer.width) return;
            try {
                this.ctx.drawImage(layer, x, y, dw, dh);
            } catch (e) {
                /* canvas mid-resize — skip this frame */
            }
        });
    }

    _drawVideoGrid(W, H) {
        const { ctx } = this;
        // Cheap re-scan: participants can join/leave mid-recording.
        let videos = this._videos;
        if (this._frame % TILE_REFRESH_FRAMES === 0) {
            videos = this._videos = this._videoTiles();
        }
        const n = videos.length;
        if (!n) return;

        const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
        const rows = Math.ceil(n / cols);
        const cellW = W / cols;
        const cellH = H / rows;

        videos.forEach((video, i) => {
            const x = (i % cols) * cellW;
            const y = Math.floor(i / cols) * cellH;
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            if (!vw || !vh) return;
            // cover-fit: fill the cell, crop the overflow, keep the aspect ratio
            const scale = Math.max((cellW - 6) / vw, (cellH - 6) / vh);
            const dw = vw * scale;
            const dh = vh * scale;
            try {
                ctx.drawImage(video, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
            } catch (e) {
                /* a track disappeared mid-frame — skip it this round */
            }
        });
    }

    /** Build one mixed audio track from every live audio source in the room. */
    async _buildAudioMix() {
        const tracks = this._audioTracks();
        if (!tracks.length) return null;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return tracks[0];
        try {
            this.audioCtx = new Ctx();
            if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
            const dest = this.audioCtx.createMediaStreamDestination();
            tracks.slice(0, MAX_AUDIO_SOURCES).forEach((track) => {
                try {
                    const src = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
                    src.connect(dest);
                    this.audioNodes.push(src);
                } catch (e) {
                    /* a muted/consumed track can refuse to connect — ignore */
                }
            });
            return dest.stream.getAudioTracks()[0] || null;
        } catch (e) {
            return tracks[0];  // fall back to a single source, still recordable
        }
    }

    /** Every distinct live audio track: remote participants + own microphone. */
    _audioTracks() {
        const seen = new Map();
        const add = (track) => {
            if (track && track.kind === 'audio' && track.readyState === 'live' && !seen.has(track.id)) {
                seen.set(track.id, track);
            }
        };
        document.querySelectorAll('video, audio').forEach((el) => {
            const stream = el.srcObject;
            if (stream?.getAudioTracks) stream.getAudioTracks().forEach(add);
        });
        const impl = Media.impl;
        // Mesh engine keeps the raw local stream; LiveKit exposes publications.
        impl?.localStream?.getAudioTracks?.().forEach(add);
        const pubs = impl?.localParticipant?.audioTrackPublications;
        if (pubs && typeof pubs.forEach === 'function') {
            pubs.forEach((pub) => add(pub?.track?.mediaStreamTrack));
        }
        return [...seen.values()];
    }

    _teardown() {
        clearTimeout(this.timer);
        clearTimeout(this._watchdog);
        this.timer = null;
        this._watchdog = null;
        if (this._stream) {
            this._stream.getTracks().forEach((t) => {
                try { t.stop(); } catch (e) { /* already gone */ }
            });
            this._stream = null;
        }
        this.audioNodes.forEach((node) => {
            try { node.disconnect(); } catch (e) { /* already gone */ }
        });
        this.audioNodes = [];
        if (this.audioCtx) {
            const ctx = this.audioCtx;
            this.audioCtx = null;
            ctx.close?.().catch(() => {});
        }
        this.recorder = null;
        this.canvas = null;
        this.ctx = null;
    }

    /** Release everything (page unload / leaving the room). */
    dispose() {
        if (this.state === 'recording') {
            try { this.recorder.stop(); } catch (e) { /* ignore */ }
        }
        this._teardown();
        this.state = 'idle';
        this.startedAt = 0;
    }
}

export const Recorder = new LocalRecorderImpl();
