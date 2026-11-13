/**
 * meter.js — real audio-level meters (shared by media.js and mesh.js).
 *
 * Levels come from a WebAudio AnalyserNode reading the actual PCM samples of
 * the track — never faked.  The context is created lazily (browsers require a
 * user gesture; our toggles ARE gestures) and shared between all analysers in
 * the page.
 *
 * Why this file does more than "read the analyser"
 * -----------------------------------------------
 * A raw per-frame peak is *noisy*: syllable by syllable it slams to 1 and back
 * to 0, so a meter fed from it flickers, the halo around the mic button jumps,
 * and every tile's speaking ring blinks on and off.  That reads as "the page is
 * shaking" and it tells nobody whether they are actually being heard.
 *
 * So the raw signal is shaped here, once, for both engines:
 *
 *   * RMS instead of peak — energy, not the loudest single sample;
 *   * mapped through a speech-friendly dB window, so quiet speech moves the
 *     meter and a loud room saturates it instead of pinning it;
 *   * an attack/release envelope — fast to rise (you speak, it moves), slow to
 *     fall (it stops twitching between syllables);
 *   * quantised, and only written to the DOM when the number really changed,
 *     so a 60 fps loop does not repaint the control bar 60 times a second;
 *   * a speaking gate with hysteresis and a hold — "talking" starts well above
 *     where it stops, and a short pause does not end it.  That is what keeps
 *     the badge and the ring still.
 */
let ctx = null;

/** dB window mapped onto 0..1: below the floor is silence, above is full. */
const LEVEL_FLOOR_DB = -58;
const LEVEL_CEIL_DB = -12;

export function audioContext() {
    if (!ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        ctx = new Ctor();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
}

/** Wrap a MediaStream in an AnalyserNode (caller keeps the reference). */
export function createAnalyser(stream) {
    const ac = audioContext();
    if (!ac) return null;
    try {
        const src = ac.createMediaStreamSource(stream);
        const analyser = ac.createAnalyser();
        analyser.fftSize = 512;
        // A little smoothing on the analyser itself is free and helps a lot.
        analyser.smoothingTimeConstant = 0.6;
        src.connect(analyser);
        analyser._meterBuf = new Uint8Array(analyser.frequencyBinCount);
        analyser._timeBuf = new Uint8Array(analyser.fftSize);
        analyser._meterSrc = src;
        return analyser;
    } catch (e) {
        return null;
    }
}

/** Peak level 0..1 from the analyser's time-domain data (legacy helper). */
export function analyserLevel(analyser) {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(analyser._meterBuf);
    let peak = 0;
    const buf = analyser._meterBuf;
    for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i] - 128);
        if (v > peak) peak = v;
    }
    return Math.min(1, peak / 90);
}

/** RMS of the current window, 0..1 (1 = full scale). */
export function analyserRms(analyser) {
    if (!analyser) return 0;
    const buf = analyser._timeBuf || analyser._meterBuf;
    if (!buf) return 0;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
    }
    return Math.sqrt(sum / buf.length);
}

/** Map an RMS value onto the speech window, 0..1. */
export function levelFromRms(rms) {
    if (!(rms > 0)) return 0;
    const db = 20 * Math.log10(rms);
    const t = (db - LEVEL_FLOOR_DB) / (LEVEL_CEIL_DB - LEVEL_FLOOR_DB);
    return Math.max(0, Math.min(1, t));
}

/**
 * Smoothed, quantised level for one analyser.
 *
 * ``read()`` is meant to be called from a frame loop; it returns a number that
 * only changes in ``step`` increments, which is exactly what CSS wants.
 */
export function createLevelTracker(analyser, { attack = 0.55, release = 0.14, step = 0.02 } = {}) {
    let value = 0;
    return {
        read() {
            const target = levelFromRms(analyserRms(analyser));
            const k = target > value ? attack : release;
            value += (target - value) * k;
            if (value < 0.015) value = 0;          // the floor is really zero
            return step > 0 ? Math.round(value / step) * step : value;
        },
        reset() {
            value = 0;
            return 0;
        },
        get value() {
            return value;
        },
    };
}

/**
 * "Is this person talking right now?" — with hysteresis and a hold.
 *
 * Rising needs ``on``; falling needs to stay under ``off`` for ``holdMs``, so
 * a breath between words does not blink the badge off and on again.
 */
export function createSpeakingGate({ on = 0.2, off = 0.08, holdMs = 520 } = {}) {
    let speaking = false;
    let quietSince = 0;
    return {
        update(level, now = performance.now()) {
            if (level >= on) {
                speaking = true;
                quietSince = 0;
            } else if (speaking) {
                if (level <= off) {
                    if (!quietSince) quietSince = now;
                    if (now - quietSince >= holdMs) speaking = false;
                } else {
                    quietSince = 0;
                }
            }
            return speaking;
        },
        reset() {
            speaking = false;
            quietSince = 0;
            return speaking;
        },
        get value() {
            return speaking;
        },
    };
}

/**
 * One frame loop for meters: ~20 fps is plenty for a level bar and a fraction
 * of the repaint cost of 60.  A throwing tick must not kill the loop.
 */
export function startLevelLoop(tick, fps = 20) {
    let raf = 0;
    let last = 0;
    const step = 1000 / Math.max(1, fps);
    const frame = (t) => {
        if (t - last >= step) {
            last = t;
            try { tick(t); } catch (err) { console.warn('[meter] tick failed', err); }
        }
        raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
    };
}

/**
 * Paint the control-bar microphone: the level bar under the icon and the
 * "you are talking" ring.  DOM writes happen only when the value changed.
 */
export function paintMic(level, speaking) {
    const btn = document.getElementById('btn-mic');
    if (!btn) return;
    const value = Math.max(0, Math.min(1, Number(level) || 0));
    const key = value.toFixed(2);
    if (btn.dataset.level !== key) {
        btn.dataset.level = key;
        btn.style.setProperty('--mic-level', value.toFixed(3));
    }
    const flag = speaking ? '1' : '0';
    if (btn.dataset.speaking !== flag) btn.dataset.speaking = flag;
}

/** Silence the mic button (mic off, socket gone, level loop stopped). */
export function resetMic() {
    const btn = document.getElementById('btn-mic');
    if (!btn) return;
    btn.dataset.level = '0.00';
    btn.dataset.speaking = '0';
    btn.style.setProperty('--mic-level', '0');
}

/** Paint one participant tile: the corner meter and the speaking badge. */
export function paintTile(tile, level, speaking) {
    if (!tile) return;
    const value = Math.max(0, Math.min(1, Number(level) || 0));
    const key = value.toFixed(2);
    if (tile.dataset.level !== key) {
        tile.dataset.level = key;
        tile.style.setProperty('--lvl', value.toFixed(3));
    }
    if (tile.classList.contains('speaking') !== Boolean(speaking)) {
        tile.classList.toggle('speaking', Boolean(speaking));
        tile.querySelector('.tile-speaking')?.setAttribute('aria-hidden', String(!speaking));
    }
}

/** Disconnect an analyser created by createAnalyser. */
export function disposeAnalyser(analyser) {
    if (!analyser) return;
    try { analyser._meterSrc && analyser._meterSrc.disconnect(); } catch (e) { /* noop */ }
    try { analyser.disconnect(); } catch (e) { /* noop */ }
}
