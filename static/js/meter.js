/**
 * meter.js — real audio-level meters (shared by media.js and mesh.js).
 *
 * Levels come from a WebAudio AnalyserNode reading the actual PCM
 * samples of the track — never faked.  The context is created lazily
 * (browsers require a user gesture; our toggles ARE gestures) and
 * shared between all analysers in the page.
 */
let ctx = null;

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
        src.connect(analyser);
        analyser._meterBuf = new Uint8Array(analyser.frequencyBinCount);
        analyser._meterSrc = src;
        return analyser;
    } catch (e) {
        return null;
    }
}

/** Peak level 0..1 from the analyser's time-domain data. */
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

/** Disconnect an analyser created by createAnalyser. */
export function disposeAnalyser(analyser) {
    if (!analyser) return;
    try { analyser._meterSrc && analyser._meterSrc.disconnect(); } catch (e) { /* noop */ }
    try { analyser.disconnect(); } catch (e) { /* noop */ }
}
