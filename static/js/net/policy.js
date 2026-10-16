/**
 * net/policy.js — the numbers behind "the connection is bad".
 *
 * Every decision the media layer makes from measured WebRTC stats lives here as
 * a pure function, so it can be reasoned about and tested without a browser:
 *
 * * ``qualityOf``       — one place that turns loss/rtt/jitter into a level.
 * * ``planFor``         — what to do about it: bitrate, resolution, frame rate
 *                         and the degradation preference handed to the sender.
 * * ``backoffDelay``    — jittered reconnect timing (a whole class must not
 *                         retry in lockstep and hammer the server).
 * * ``transportAdvice`` — when to restart ICE, when to rebuild the peer
 *                         connection, and when to just wait.
 */

export const QUALITY = {
    EXCELLENT: 'excellent',
    GOOD: 'good',
    POOR: 'poor',
};

const RANK = { [QUALITY.EXCELLENT]: 0, [QUALITY.GOOD]: 1, [QUALITY.POOR]: 2 };

/** The worse of two quality levels. */
export function worstQuality(a, b) {
    if (!a) return b;
    if (!b) return a;
    return (RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b;
}

/**
 * Turn real RTCStatsReport numbers into a level.
 *
 * ``received``/``lost`` are packet counters, ``rtt`` and ``jitter`` are in
 * seconds (the units the WebRTC stats API uses).  ``minimum`` keeps a healthy
 * link from being judged on a handful of packets at startup.
 */
export function qualityOf({ received = 0, lost = 0, rtt = null, jitter = null, minimum = 50 } = {}) {
    const total = received + lost;
    const lossRate = total > 0 ? lost / total : 0;
    let level = QUALITY.EXCELLENT;

    // A single lost packet out of the first six must not read as 33% loss:
    // loss is only judged once there is a meaningful sample.
    if (total >= minimum) {
        if (lossRate > 0.05) level = QUALITY.POOR;
        else if (lossRate > 0.015) level = QUALITY.GOOD;
    }
    if (rtt !== null && rtt !== undefined) {
        if (rtt > 0.4) level = QUALITY.POOR;
        else if (rtt > 0.15 && level === QUALITY.EXCELLENT) level = QUALITY.GOOD;
    }
    if (jitter !== null && jitter !== undefined && jitter > 0.05 && level === QUALITY.EXCELLENT) {
        level = QUALITY.GOOD;
    }
    return level;
}

/**
 * How much of the uplink one video stream may use.
 *
 * In a mesh every participant uploads one copy per peer, so the same camera
 * bitrate that is fine for a two-person call saturates a 25 Mbps domestic
 * uplink at eight people.  The budget shrinks with the room.
 */
export function uplinkFactor(peerCount = 1) {
    if (peerCount <= 2) return 1;
    if (peerCount <= 4) return 0.6;
    if (peerCount <= 6) return 0.45;
    return 0.3;
}

const BASE_VIDEO = {
    [QUALITY.EXCELLENT]: { camera: 900_000, screen: 1_500_000, fps: 30, scale: 1 },
    [QUALITY.GOOD]: { camera: 500_000, screen: 900_000, fps: 24, scale: 1 },
    [QUALITY.POOR]: { camera: 250_000, screen: 400_000, fps: 15, scale: 1.5 },
};

/**
 * Sender parameters for the current quality and room size.
 *
 * ``degradationPreference`` is the part that actually decides what the viewer
 * loses: a camera keeps its frame rate when the network is weak (motion matters
 * more than detail), while a shared screen keeps its resolution (text has to
 * stay readable) unless the link is really bad.
 */
export function planFor({ quality = QUALITY.EXCELLENT, peerCount = 1, isScreen = false } = {}) {
    const base = BASE_VIDEO[quality] || BASE_VIDEO[QUALITY.EXCELLENT];
    const factor = uplinkFactor(peerCount);
    const raw = (isScreen ? base.screen : base.camera) * factor;
    // round to something readable in the logs/diagnostics
    const maxBitrate = Math.max(80_000, Math.round(raw / 10_000) * 10_000);
    const crowdScale = peerCount >= 7 ? 2 : (peerCount >= 5 ? 1.5 : 1);
    const scaleResolutionDownBy = Math.max(base.scale, peerCount >= 5 ? crowdScale : base.scale);
    let degradationPreference = 'balanced';
    if (isScreen) {
        degradationPreference = quality === QUALITY.POOR ? 'maintain-framerate' : 'maintain-resolution';
    } else if (quality === QUALITY.POOR) {
        degradationPreference = 'maintain-framerate';
    }
    return {
        maxBitrate,
        maxFramerate: base.fps,
        scaleResolutionDownBy,
        degradationPreference,
        peerCount,
        quality,
    };
}

/** Audio is cheap but not free: keep it intelligible on a bad link. */
export function audioPlanFor({ quality = QUALITY.EXCELLENT } = {}) {
    return {
        maxBitrate: quality === QUALITY.POOR ? 24_000 : 40_000,
        // Opus in-band FEC and DTX keep speech alive through loss and silence
        fec: true,
        dtx: true,
    };
}

/**
 * Jittered exponential backoff.
 *
 * ``random`` is injectable so the timing is testable; production passes the
 * default.  The result is always inside ``[250, max]``.
 */
export function backoffDelay(attempt = 0, { base = 1000, max = 15_000, jitter = 0.3, random = Math.random } = {}) {
    const step = Math.max(0, Math.floor(attempt));
    const raw = Math.min(base * (1.8 ** step), max);
    const spread = raw * jitter;
    const value = raw - spread + random() * spread * 2;
    return Math.min(max, Math.max(250, Math.round(value)));
}

/**
 * What to do about a peer connection that is not healthy.
 *
 * ``disconnected`` is usually transient (Wi-Fi blip, laptop wake) so it is only
 * acted on after the grace period; ``failed`` warrants an ICE restart, and a
 * link that already restarted without recovering has to be rebuilt.
 */
export function transportAdvice({
    iceState = 'new', poorStreak = 0, disconnectedMs = 0, graceMs = 4000, alreadyRestarted = false,
} = {}) {
    if (iceState === 'failed') return alreadyRestarted ? 'recreate' : 'restart-ice';
    if (iceState === 'disconnected' && disconnectedMs >= graceMs) {
        return alreadyRestarted ? 'recreate' : 'restart-ice';
    }
    // a link that keeps reporting poor quality without ever failing is being
    // starved, not broken: lower the bitrate instead of tearing it down
    if (poorStreak >= 2) return 'throttle';
    return 'ok';
}
