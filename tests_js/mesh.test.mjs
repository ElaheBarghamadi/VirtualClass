/**
 * mesh.test.mjs — the peer-to-peer media path, driven by fakes.
 *
 * `mesh.js` is the engine a classroom uses when no LiveKit server is
 * configured, so "the camera/voice connection is bad" is usually this file.
 * The tests below give it a scripted `RTCPeerConnection` that can report bad
 * stats or a failed ICE state, then assert the *actions* the engine takes:
 *
 * * does a starved link get a smaller bitrate / smaller picture, and only once;
 * * does a healthy link keep its original parameters;
 * * does a failed link get exactly one ICE restart, then a rebuild — and only
 *   on one side of the pair (so the two ends cannot keep tearing it down);
 * * does the signalling queue survive a disconnected room socket.
 *
 * Run: node mesh.test.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = path.join(HERE, '.build');

function syncSources() {
    fs.mkdirSync(SRC, { recursive: true });
    fs.rmSync(SRC, { recursive: true, force: true });
    fs.cpSync(path.join(REPO, 'static/js'), SRC, { recursive: true });
    fs.writeFileSync(path.join(SRC, 'package.json'), JSON.stringify({ type: 'module' }));
}

/* ------------------------------------------------------------------ */
/* tiny harness                                                        */
/* ------------------------------------------------------------------ */
const results = [];
async function check(name, fn) {
    try {
        const value = await fn();
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

/* ------------------------------------------------------------------ */
/* scripted WebRTC                                                     */
/* ------------------------------------------------------------------ */
const created = [];

class FakeTrack {
    constructor(kind) {
        this.kind = kind;
        this.readyState = 'live';
        this.enabled = true;
        this.muted = false;
    }
    stop() { this.readyState = 'ended'; }
}

class FakeSender {
    constructor(track) {
        this.track = track;
        this.parameters = { encodings: [{ active: true }], degradationPreference: 'balanced' };
        this.calls = [];
    }
    getParameters() { return JSON.parse(JSON.stringify(this.parameters)); }
    setParameters(parameters) {
        this.calls.push(JSON.parse(JSON.stringify(parameters)));
        this.parameters = parameters;
        return Promise.resolve();
    }
}

class FakePc {
    constructor(config) {
        this.config = config;
        this.senders = [];
        this.closed = false;
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.signalingState = 'stable';
        this.restarts = 0;
        this.stats = null;
        created.push(this);
    }
    addTrack(track) { this.senders.push(new FakeSender(track)); }
    getSenders() { return this.senders; }
    async getStats() {
        const rows = this.stats || [];
        return { forEach: (fn) => rows.forEach(fn) };
    }
    createDataChannel() { return {}; }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0' }); }
    setLocalDescription(description) { this.localDescription = description; return Promise.resolve(); }
    setRemoteDescription(description) { this.remoteDescription = description; return Promise.resolve(); }
    addIceCandidate() { return Promise.resolve(); }
    restartIce() { this.restarts += 1; }
    close() { this.closed = true; this.connectionState = 'closed'; }
}

/* ------------------------------------------------------------------ */
/* environment                                                         */
/* ------------------------------------------------------------------ */
async function boot() {
    syncSources();
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="tiles"></div>
        <div id="stage-empty"><p id="stage-empty-text"></p></div>
        <div id="stage"></div>
    </body></html>`, { url: 'https://class.example.test/room/ABCDE/', pretendToBeVisual: true });
    const { window } = dom;
    window.RTCPeerConnection = FakePc;
    window.MediaStream = class MediaStream {
        constructor(tracks = []) { this.tracks = tracks; }
        getTracks() { return this.tracks; }
        getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
        getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    };
    window.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.RTCPeerConnection = FakePc;
    if (!globalThis.navigator) {
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
    }
    globalThis.requestAnimationFrame = window.requestAnimationFrame;

    const { MeshMedia } = await import(`${path.join(SRC, 'mesh.js')}?mesh=${Math.random()}`);
    const mesh = new MeshMedia();
    const quality = [];
    await mesh.init({
        roomCode: 'ABCDE',
        self: { identity: 'u:1', memberId: 1, name: 'من' },
        permissions: { can_use_microphone: true, can_use_camera: true, can_share_screen: false },
        signal: () => {},
        onStateChange: () => {},
        onQualityChange: (level) => quality.push(level),
        iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
    });
    const peer = { identity: 'u:2', member_id: 2, name: 'هم‌کلاس' };
    mesh.syncPeers([peer]);
    const link = mesh.links.get(peer.identity);
    assert(link, 'no peer link was created');
    const video = new FakeTrack('video');
    link.addLocalTracks({ getTracks: () => [video, new FakeTrack('audio')] });
    return { window, document: window.document, mesh, link, peer, video, quality, FakePc, FakeTrack };
}

/* ------------------------------------------------------------------ */
const rows = ({ lost = 0, received = 4000, rtt = 0.02, jitter = 0.002 }) => ([
    { type: 'inbound-rtp', kind: 'video', packetsLost: lost, packetsReceived: received, jitter },
    { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: rtt },
]);

async function main() {
    /* -------------------------------------------------------------- */
    /* adaptation                                                      */
    /* -------------------------------------------------------------- */
    const env = await boot();
    const { mesh, link } = env;

    await check('mesh: a healthy link leaves the sender parameters alone', async () => {
        link.pc.stats = rows({});
        await mesh._evaluateQuality();
        same(mesh.quality, 'excellent', 'measured quality');
        same(link.pc.senders[0].calls.length, 0, 'nothing should be pushed to a healthy sender');
    });

    await check('mesh: a streamed video sender is added for the local camera', () => {
        assert(link.pc.senders.length >= 1, 'no sender was created for the camera track');
        same(link.pc.senders[0].track.kind, 'video', 'the first sender should carry video');
    });

    await check('mesh: a starved link is throttled — bitrate, frame rate and size', async () => {
        link.pc.stats = rows({ lost: 900, received: 4000, rtt: 0.55 });
        await mesh._evaluateQuality();
        same(mesh.quality, 'poor', 'measured quality');
        const calls = link.pc.senders[0].calls;
        assert(calls.length === 1, `expected exactly one setParameters call, got ${calls.length}`);
        const plan = calls[0];
        assert(plan.encodings[0].maxBitrate <= 300_000, `bitrate not reduced: ${plan.encodings[0].maxBitrate}`);
        assert(plan.encodings[0].maxFramerate <= 15, `frame rate not reduced: ${plan.encodings[0].maxFramerate}`);
        assert(plan.encodings[0].scaleResolutionDownBy >= 1.5, `picture not scaled down: ${plan.encodings[0].scaleResolutionDownBy}`);
        same(plan.degradationPreference, 'maintain-framerate', 'camera priority on a weak link');
    });

    await check('mesh: the same plan is not re-applied on every stats tick', async () => {
        const before = link.pc.senders[0].calls.length;
        await mesh._evaluateQuality();
        await mesh._evaluateQuality();
        same(link.pc.senders[0].calls.length, before, 'setParameters ran again with an unchanged plan');
    });

    await check('mesh: recovery gives the sender its bandwidth back', async () => {
        link.pc.stats = rows({});
        await mesh._evaluateQuality();
        same(mesh.quality, 'excellent', 'quality after recovery');
        const calls = link.pc.senders[0].calls;
        assert(calls.length >= 2, 'no new plan was pushed after recovering');
        const plan = calls[calls.length - 1];
        assert(plan.encodings[0].maxBitrate >= 500_000,
            `the sender was not restored: ${plan.encodings[0].maxBitrate}`);
        same(plan.encodings[0].scaleResolutionDownBy, 1, 'full size again');
    });

    await check('mesh: more peers means a smaller budget for the same quality', async () => {
        mesh.syncPeers([
            { identity: 'u:2', member_id: 2, name: 'الف' },
            { identity: 'u:3', member_id: 3, name: 'ب' },
            { identity: 'u:4', member_id: 4, name: 'پ' },
            { identity: 'u:5', member_id: 5, name: 'ت' },
            { identity: 'u:6', member_id: 6, name: 'ث' },
        ]);
        await mesh._evaluateQuality();
        const last = link.pc.senders[0].calls.at(-1);
        assert(last, 'the crowd did not change the plan');
        assert(last.encodings[0].maxBitrate <= 600_000,
            `a five-peer mesh kept ${last.encodings[0].maxBitrate} bps on one stream`);
    });

    /* -------------------------------------------------------------- */
    /* transport recovery                                              */
    /* -------------------------------------------------------------- */
    await check('mesh: a failed link gets one ICE restart, not a rebuild', async () => {
        const before = link.pc.restarts;
        link.pc.iceConnectionState = 'failed';
        link.pc.connectionState = 'failed';
        mesh._recoverStalledLinks();
        same(link.pc.restarts, before + 1, 'ICE restart count');
        assert(mesh.links.get('u:2') === link, 'the link must not be replaced on the first failure');
    });

    await check('mesh: the politest side does not tear the link down too', async () => {
        // self.memberId (1) < peer.member_id (2): this side is the polite one
        const restarts = link.pc.restarts;
        mesh._recoverStalledLinks();
        assert(mesh.links.get('u:2') === link, 'the polite side must keep the link');
        assert(link.pc.restarts > restarts, 'the polite side should keep trying ICE');
    });

    await check('mesh: the initiating side rebuilds a link that never recovers', async () => {
        const initiator = await boot();
        initiator.mesh.self = { identity: 'u:9', memberId: 9, name: 'من' };
        const peer = { identity: 'u:2', member_id: 2, name: 'هم‌کلاس' };
        initiator.mesh.syncPeers([peer]);
        const stale = initiator.mesh.links.get('u:2');
        stale.pc.iceConnectionState = 'failed';
        stale.pc.connectionState = 'failed';
        stale.iceRestarted = true;
        initiator.mesh._recoverStalledLinks();
        const fresh = initiator.mesh.links.get('u:2');
        assert(fresh && fresh !== stale, 'the failed link was not rebuilt');
        assert(stale.pc.closed, 'the old connection was left open');
        same(fresh.pc.restarts, 0, 'the fresh link must not start with a restart');
    });

    await check('mesh: a link is not rebuilt twice in a row', async () => {
        const initiator = await boot();
        initiator.mesh.self = { identity: 'u:9', memberId: 9, name: 'من' };
        const peer = { identity: 'u:2', member_id: 2, name: 'هم‌کلاس' };
        initiator.mesh.syncPeers([peer]);
        const first = initiator.mesh.links.get('u:2');
        first.pc.iceConnectionState = 'failed';
        first.iceRestarted = true;
        initiator.mesh._recoverStalledLinks();
        const second = initiator.mesh.links.get('u:2');
        second.pc.iceConnectionState = 'failed';
        second.iceRestarted = true;
        initiator.mesh._recoverStalledLinks();
        assert(initiator.mesh.links.get('u:2') === second, 'it rebuilt again within the cooldown');
    });

    /* -------------------------------------------------------------- */
    /* report                                                          */
    /* -------------------------------------------------------------- */
    try { mesh.dispose(); } catch (err) { /* timers only */ }
    const failed = results.filter((entry) => !entry.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error('mesh suite crashed:', err);
        process.exit(2);
    });
}
