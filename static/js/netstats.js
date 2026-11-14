/**
 * netstats.js — the real numbers behind «چرا صدا قطع می‌شود؟».
 *
 * Everything here is read from ``RTCPeerConnection.getStats()``: bytes that
 * actually left, packets that actually arrived, the round-trip time of the
 * winsome candidate pair, jitter of the audio stream.  Nothing is inferred
 * from what a participant *says* about their connection — which is the whole
 * point: a student cannot claim «اینترنت من خوب است» when the packets reaching
 * the other side show otherwise.
 *
 * Two directions matter and they are not the same:
 *   • *inbound* metrics (``inKbps``, ``lossPct``, ``jitterMs``) describe what
 *     **we** receive from that peer — i.e. their upload.  This is the
 *     authoritative «how is their internet» for everyone else in the room.
 *   • *outbound* metrics (``outKbps``) describe what we send them.
 *
 * The module is deliberately DOM-free so the maths can be unit-tested in node.
 */

const FA = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

/** Persian digits, rounded, no locale surprises. */
export function fa(value) {
    return String(value).replace(/[0-9]/g, (d) => FA[d]);
}

/** A number with one decimal place, in Persian digits (۱۲٫۴). */
export function faNum(value, digits = 1) {
    if (value == null || !Number.isFinite(value)) return '—';
    const rounded = Number(value.toFixed(digits));
    return fa(String(rounded)).replace('.', '٫');
}

/** kbit/s → «۱٫۲ مگابیت/ث» or «۳۴۰ کیلوبیت/ث». */
export function formatRate(kbps) {
    if (kbps == null || !Number.isFinite(kbps)) return '—';
    if (kbps >= 1000) return `${faNum(kbps / 1000)} مگابیت/ث`;
    return `${fa(Math.round(kbps))} کیلوبیت/ث`;
}

/** Bytes → «۸۴۲ مگابایت» sized for a lesson, not for a datacentre. */
export function formatBytes(bytes) {
    if (bytes == null || !Number.isFinite(bytes)) return '—';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${faNum(mb / 1024)} گیگابایت`;
    if (mb >= 1) return `${fa(Math.round(mb))} مگابایت`;
    return `${fa(Math.max(1, Math.round(bytes / 1024)))} کیلوبایت`;
}

export const QUALITY_LABEL = {
    good: 'خوب',
    fair: 'متوسط',
    poor: 'ضعیف',
    unknown: '—',
};

/**
 * Score one link from measured values only.
 *
 * The thresholds are generous on purpose: a classroom that shows «ضعیف» for
 * every slightly imperfect Wi-Fi link teaches people to ignore the badge.
 * «ضعیف» means the call is *audibly or visibly* breaking up.
 */
export function gradeLink({ lossPct = 0, rttMs = null, jitterMs = null, fps = null, inKbps = 0 } = {}) {
    let score = 0;
    if (lossPct >= 8) score += 2;
    else if (lossPct >= 2.5) score += 1;
    if (rttMs != null) {
        if (rttMs >= 500) score += 2;
        else if (rttMs >= 250) score += 1;
    }
    if (jitterMs != null && jitterMs >= 60) score += 1;
    // A camera that is on but delivering almost no frames is a frozen picture
    // even when the packets that do arrive are clean.
    if (fps != null && fps > 0 && fps < 8) score += 1;
    // Silence from a link that should be carrying audio.
    if (inKbps === 0 && fps === 0) score += 1;
    if (score >= 3) return 'poor';
    if (score >= 1) return 'fair';
    return 'good';
}

/** A link is «weak» only after it has been bad twice in a row (no flicker). */
export function nextQuality(previous, graded) {
    if (graded === 'poor') return previous === 'poor' ? 'poor' : 'fair';
    if (graded === 'good') return 'good';
    return previous === 'poor' ? 'fair' : graded;
}

function kbpsFrom(deltaBytes, deltaMs) {
    if (!(deltaMs > 0) || deltaBytes == null) return 0;
    return (deltaBytes * 8) / deltaMs; // bytes·8 / ms = kbit/s
}

function num(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
}

/**
 * Turns two consecutive ``getStats()`` snapshots into per-second numbers.
 *
 * Kept as a class because the counters are cumulative: the interesting value is
 * always the difference between this sample and the previous one.
 */
export class LinkSampler {
    constructor() {
        this._prev = null;
        this._prevAt = 0;
        this.quality = 'unknown';
        this.totals = { bytesIn: 0, bytesOut: 0 };
        this._reportedTotals = { bytesIn: 0, bytesOut: 0 };
    }

    /** @param {RTCStatsReport} report @param {number} now milliseconds */
    update(report, now = Date.now()) {
        const rows = [];
        report.forEach((row) => rows.push(row));

        const inbound = rows.filter((r) => r.type === 'inbound-rtp'
            && (r.kind === 'audio' || r.kind === 'video' || r.mediaType === 'audio' || r.mediaType === 'video'));
        const outbound = rows.filter((r) => r.type === 'outbound-rtp'
            && (r.kind === 'audio' || r.kind === 'video' || r.mediaType === 'audio' || r.mediaType === 'video'));
        const pair = rows.find((r) => r.type === 'candidate-pair' && r.state === 'succeeded'
            && r.currentRoundTripTime != null);

        const video = inbound.find((r) => (r.kind || r.mediaType) === 'video');
        const audio = inbound.find((r) => (r.kind || r.mediaType) === 'audio');
        const videoOut = outbound.find((r) => (r.kind || r.mediaType) === 'video');

        const sum = (list, key) => list.reduce((acc, r) => acc + num(r[key]), 0);
        const bytesIn = sum(inbound, 'bytesReceived');
        const audioBytes = num(audio && audio.bytesReceived);
        const bytesOut = sum(outbound, 'bytesSent');
        const lost = sum(inbound, 'packetsLost');
        const received = sum(inbound, 'packetsReceived');

        // ---- deltas -------------------------------------------------------
        const prev = this._prev;
        const deltaMs = prev ? now - this._prevAt : 0;
        const dIn = prev ? bytesIn - prev.bytesIn : 0;
        const dOut = prev ? bytesOut - prev.bytesOut : 0;
        const dLost = prev ? Math.max(0, lost - prev.lost) : 0;
        const dRecv = prev ? Math.max(0, received - prev.received) : 0;
        const dAudio = prev ? Math.max(0, audioBytes - prev.audioBytes) : 0;
        this._prev = { bytesIn, bytesOut, lost, received, audioBytes };
        this._prevAt = now;

        this.totals = { bytesIn, bytesOut };

        const lossPct = dRecv + dLost > 0 ? (dLost / (dRecv + dLost)) * 100 : null;
        const rttMs = pair ? num(pair.currentRoundTripTime) * 1000 : null;
        const jitterMs = audio && audio.jitter != null ? num(audio.jitter) * 1000 : null;
        const fps = videoOut && videoOut.framesPerSecond != null
            ? num(videoOut.framesPerSecond)
            : (video && video.framesPerSecond != null ? num(video.framesPerSecond) : null);
        const width = videoOut?.frameWidth || video?.frameWidth || null;
        const height = videoOut?.frameHeight || video?.frameHeight || null;
        const limited = outbound.map((r) => r.qualityLimitationReason).find((r) => r && r !== 'none') || null;

        // Path: relay means every frame is paid for twice.
        const local = pair && report.get(pair.localCandidateId);
        const remote = pair && report.get(pair.remoteCandidateId);
        const types = [local?.candidateType, remote?.candidateType].filter(Boolean);
        const path = types.includes('relay') ? 'relay' : (types.length ? 'direct' : null);

        const metrics = {
            at: now,
            inKbps: kbpsFrom(dIn, deltaMs),
            outKbps: kbpsFrom(dOut, deltaMs),
            audioInKbps: kbpsFrom(dAudio, deltaMs),
            lossPct,
            rttMs,
            jitterMs,
            fps,
            width,
            height,
            path,
            limited,
            bytesIn,
            bytesOut,
            limiter: limited,
        };
        metrics.quality = gradeLink(metrics);
        return metrics;
    }

    /** Merge a fresh measurement into the badge state with hysteresis. */
    settle(metrics) {
        this.quality = nextQuality(this.quality, metrics.quality);
        return this.quality;
    }
}

/** Sum of every link → the row that describes *our* own connection. */
export function combineOwnership(rows) {
    const total = {
        inKbps: 0,
        outKbps: 0,
        lossPct: null,
        rttMs: null,
        jitterMs: null,
        bytesIn: 0,
        bytesOut: 0,
        peers: 0,
        poorPeers: 0,
        relayPeers: 0,
    };
    let worstLoss = null;
    let worstRtt = null;
    let worstJitter = null;
    for (const row of rows) {
        if (!row) continue;
        total.peers += 1;
        total.inKbps += row.inKbps || 0;
        total.outKbps += row.outKbps || 0;
        total.bytesIn += row.bytesIn || 0;
        total.bytesOut += row.bytesOut || 0;
        if (row.quality === 'poor') total.poorPeers += 1;
        if (row.path === 'relay') total.relayPeers += 1;
        if (row.lossPct != null) worstLoss = Math.max(worstLoss ?? 0, row.lossPct);
        if (row.rttMs != null) worstRtt = Math.max(worstRtt ?? 0, row.rttMs);
        if (row.jitterMs != null) worstJitter = Math.max(worstJitter ?? 0, row.jitterMs);
    }
    total.lossPct = worstLoss;
    total.rttMs = worstRtt;
    total.jitterMs = worstJitter;
    total.quality = gradeLink({
        lossPct: worstLoss ?? 0,
        rttMs: worstRtt,
        jitterMs: worstJitter,
    });
    return total;
}
