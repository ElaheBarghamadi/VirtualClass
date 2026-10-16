/**
 * policy.test.mjs — the media/connection policy, as pure functions.
 *
 * These are the numbers that decide what a weak link costs the class: when the
 * camera drops resolution, when a sender is throttled, when a peer connection
 * is restarted instead of rebuilt, and how long a client waits before dialling
 * again.  No browser or network is needed to pin them down.
 *
 * Run: node policy.test.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
    QUALITY, audioPlanFor, backoffDelay, planFor, qualityOf, transportAdvice,
    uplinkFactor, worstQuality,
} from '../static/js/net/policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const results = [];
function check(name, fn) {
    try {
        const value = fn();
        if (value === false) throw new Error('assertion returned false');
        results.push({ name, ok: true });
        console.log(`ok   ${name}`);
    } catch (err) {
        results.push({ name, ok: false, err });
        console.log(`FAIL ${name}\n     ${String(err && err.message).split('\n').join('\n     ')}`);
    }
}
function assert(cond, message) {
    if (!cond) throw new Error(message || 'assertion failed');
}
function same(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${message || 'not equal'}\n  actual:   ${a}\n  expected: ${b}`);
}

async function main() {
    /* ------------------------------------------------------------------ */
    /* quality ladder                                                      */
    /* ------------------------------------------------------------------ */
    check('quality: a clean link is excellent', () => {
        same(qualityOf({ received: 5000, lost: 0, rtt: 0.03, jitter: 0.004 }), QUALITY.EXCELLENT);
    });

    check('quality: mild loss or latency is good', () => {
        same(qualityOf({ received: 5000, lost: 120, rtt: 0.05 }), QUALITY.GOOD, '3% loss');
        same(qualityOf({ received: 5000, lost: 0, rtt: 0.2 }), QUALITY.GOOD, '200 ms rtt');
        same(qualityOf({ received: 5000, lost: 0, rtt: 0.03, jitter: 0.07 }), QUALITY.GOOD, '70 ms jitter');
    });

    check('quality: heavy loss or a long rtt is poor', () => {
        same(qualityOf({ received: 5000, lost: 400, rtt: 0.05 }), QUALITY.POOR, '7% loss');
        same(qualityOf({ received: 5000, lost: 0, rtt: 0.5 }), QUALITY.POOR, '500 ms rtt');
    });

    check('quality: a handful of packets at startup does not decide anything', () => {
        same(qualityOf({ received: 4, lost: 2, rtt: 0.02 }), QUALITY.EXCELLENT,
            'one lost packet out of six must not be read as 33% loss');
    });

    check('quality: the worse of two links wins', () => {
        same(worstQuality(QUALITY.EXCELLENT, QUALITY.GOOD), QUALITY.GOOD);
        same(worstQuality(QUALITY.POOR, QUALITY.GOOD), QUALITY.POOR);
        same(worstQuality(QUALITY.EXCELLENT, null), QUALITY.EXCELLENT);
    });

    /* ------------------------------------------------------------------ */
    /* the plan handed to the sender                                       */
    /* ------------------------------------------------------------------ */
    check('plan: worse quality means less bitrate, less frames, smaller picture', () => {
        const excellent = planFor({ quality: QUALITY.EXCELLENT, peerCount: 2 });
        const good = planFor({ quality: QUALITY.GOOD, peerCount: 2 });
        const poor = planFor({ quality: QUALITY.POOR, peerCount: 2 });
        assert(excellent.maxBitrate > good.maxBitrate, 'good must cost less than excellent');
        assert(good.maxBitrate > poor.maxBitrate, 'poor must cost less than good');
        assert(excellent.maxFramerate > poor.maxFramerate, 'poor must drop the frame rate');
        assert(poor.scaleResolutionDownBy > excellent.scaleResolutionDownBy,
            'poor must send a smaller picture');
        same(excellent.degradationPreference, 'balanced');
        same(poor.degradationPreference, 'maintain-framerate',
            'a weak camera link should keep motion, not detail');
    });

    check('plan: a crowd shrinks every stream (one upload per peer)', () => {
        const solo = planFor({ quality: QUALITY.GOOD, peerCount: 2 });
        const few = planFor({ quality: QUALITY.GOOD, peerCount: 4 });
        const many = planFor({ quality: QUALITY.GOOD, peerCount: 8 });
        assert(solo.maxBitrate > few.maxBitrate, 'four peers must cost less than two');
        assert(few.maxBitrate > many.maxBitrate, 'eight peers must cost less than four');
        assert(many.scaleResolutionDownBy >= 2, 'eight peers should send a half-size picture');
        assert(uplinkFactor(1) === 1 && uplinkFactor(8) < 0.5, 'uplink factor must shrink');
    });

    check('plan: a shared screen keeps its text readable', () => {
        const screen = planFor({ quality: QUALITY.GOOD, peerCount: 3, isScreen: true });
        same(screen.degradationPreference, 'maintain-resolution', 'screen share priority');
        const camera = planFor({ quality: QUALITY.GOOD, peerCount: 3 });
        assert(screen.maxBitrate > camera.maxBitrate, 'a screen needs more bitrate than a face');
        const badScreen = planFor({ quality: QUALITY.POOR, peerCount: 3, isScreen: true });
        same(badScreen.degradationPreference, 'maintain-framerate',
            'when the link is really bad, motion wins over text');
    });

    check('plan: bitrate never falls below a usable floor', () => {
        const plan = planFor({ quality: QUALITY.POOR, peerCount: 12, isScreen: false });
        assert(plan.maxBitrate >= 80_000, `floor breached: ${plan.maxBitrate}`);
        assert(Number.isFinite(plan.maxFramerate) && plan.maxFramerate >= 1, 'frame rate must be finite');
        assert(plan.scaleResolutionDownBy >= 1, 'scaling down by less than 1 is nonsense');
    });

    check('plan: audio stays intelligible and cheap', () => {
        assert(audioPlanFor({ quality: QUALITY.POOR }).maxBitrate < audioPlanFor({ quality: QUALITY.EXCELLENT }).maxBitrate,
            'poor audio should cost less');
        same(audioPlanFor({ quality: QUALITY.POOR }).fec, true, 'FEC on a lossy link');
        same(audioPlanFor({ quality: QUALITY.EXCELLENT }).dtx, true, 'silence should not be sent');
    });

    /* ------------------------------------------------------------------ */
    /* reconnect timing                                                    */
    /* ------------------------------------------------------------------ */
    check('backoff: grows, is capped and always jittered', () => {
        const base = { base: 1000, max: 15000, jitter: 0.3, random: () => 0.5 };
        const delays = [0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, base));
        for (let i = 1; i < delays.length; i += 1) {
            assert(delays[i] >= delays[i - 1], `attempt ${i} waited ${delays[i]} after ${delays[i - 1]}`);
        }
        assert(delays[delays.length - 1] <= 15000, 'the cap must hold');
        assert(delays[0] >= 250, 'never retry instantly');
    });

    check('backoff: the jitter spreads a whole class out', () => {
        const low = backoffDelay(3, { base: 1000, jitter: 0.5, random: () => 0 });
        const high = backoffDelay(3, { base: 1000, jitter: 0.5, random: () => 1 });
        assert(high > low, 'the random source must move the delay');
        assert(low >= 250 && high <= 15000, `out of range: ${low}…${high}`);
    });

    check('backoff: a negative or absurd attempt is still sane', () => {
        assert(backoffDelay(-5) >= 250, 'negative attempts must not produce a negative delay');
        assert(backoffDelay(9999) <= 15000, 'a huge attempt must hit the cap');
    });

    /* ------------------------------------------------------------------ */
    /* what to do about a bad link                                         */
    /* ------------------------------------------------------------------ */
    check('advice: a healthy link is left alone', () => {
        same(transportAdvice({ iceState: 'connected' }), 'ok');
        same(transportAdvice({ iceState: 'completed', poorStreak: 1 }), 'ok');
    });

    check('advice: a starved link is throttled, not torn down', () => {
        same(transportAdvice({ iceState: 'connected', poorStreak: 2 }), 'throttle');
    });

    check('advice: a failed link gets one ICE restart, then is rebuilt', () => {
        same(transportAdvice({ iceState: 'failed' }), 'restart-ice');
        same(transportAdvice({ iceState: 'failed', alreadyRestarted: true }), 'recreate');
    });

    check('advice: a disconnected link is given time to come back', () => {
        same(transportAdvice({ iceState: 'disconnected', disconnectedMs: 500 }), 'ok',
            'a blip must not trigger anything');
        same(transportAdvice({ iceState: 'disconnected', disconnectedMs: 5000 }), 'restart-ice');
        same(transportAdvice({ iceState: 'disconnected', disconnectedMs: 20000, alreadyRestarted: true }),
            'recreate');
    });

    const failed = results.filter((entry) => !entry.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error('policy suite crashed:', err);
        process.exit(2);
    });
}
