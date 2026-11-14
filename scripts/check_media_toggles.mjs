/**
 * check_media_toggles.mjs — run the REAL mesh/media code against a stubbed
 * browser and assert the things `node --check` cannot see.
 *
 * The bugs this guards against are all race conditions, and every one of them
 * looked like «the camera works sometimes» to a teacher:
 *
 *   1. a second tap while `getUserMedia` was open used to be dropped, so
 *      on/off/on ended wherever the first tap left it;
 *   2. a moderator's mute could be undone by a `getUserMedia` that resolved
 *      afterwards — a ghost microphone in a room that had already muted it;
 *   3. every ICE candidate was its own WebSocket message, so a joining trio
 *      exceeded the server's per-connection budget and candidates were
 *      silently dropped (SDP arrived, the path never completed);
 *   4. the same media state was announced two or three times per toggle, each
 *      one a database read plus a broadcast to every participant;
 *   5. teardown left timers, buffered signals and open devices behind.
 *
 *   node scripts/check_media_toggles.mjs
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'static', 'js');

let failures = 0;
function check(ok, message) {
    if (ok) {
        console.log(`ok   ${message}`);
    } else {
        failures += 1;
        console.error(`FAIL ${message}`);
    }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- browser stubs
function fakeEl() {
    return {
        className: '', innerHTML: '', textContent: '', tabIndex: 0, title: '',
        dataset: {}, children: [],
        style: { setProperty() {}, removeProperty() {} },
        classList: {
            _s: new Set(),
            add(...c) { c.forEach((x) => this._s.add(x)); },
            remove(...c) { c.forEach((x) => this._s.delete(x)); },
            toggle(c, on) {
                const want = on === undefined ? !this._s.has(c) : Boolean(on);
                want ? this._s.add(c) : this._s.delete(c);
                return want;
            },
            contains(c) { return this._s.has(c); },
        },
        append(...kids) { this.children.push(...kids); },
        appendChild(k) { this.children.push(k); return k; },
        prepend(k) { this.children.unshift(k); return k; },
        remove() {},
        setAttribute() {}, getAttribute() { return null; },
        addEventListener() {}, removeEventListener() {},
        querySelector() { return fakeEl(); },
        querySelectorAll() { return []; },
        closest() { return null; },
        play() { return Promise.resolve(); },
        requestFullscreen() { return Promise.resolve(); },
    };
}

const tilesEl = fakeEl();
const emptyEl = fakeEl();
globalThis.document = {
    hidden: false,
    fullscreenElement: null,
    body: fakeEl(),
    documentElement: fakeEl(),
    getElementById(id) {
        if (id === 'tiles') return tilesEl;
        if (id === 'stage-empty') return emptyEl;
        return null;
    },
    createElement() { return fakeEl(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
globalThis.Event = class { constructor(type) { this.type = type; } };
globalThis.MediaStream = class {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
    addTrack(t) { this.tracks.push(t); }
    removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); }
};
globalThis.HTMLElement = class {};
globalThis.HTMLAudioElement = { prototype: {} };

class FakeTrack {
    constructor(kind) {
        this.kind = kind;
        this.readyState = 'live';
        this.enabled = true;
        this.muted = false;
        this.stopped = false;
        this._listeners = {};
    }
    stop() { this.stopped = true; this.readyState = 'ended'; }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    removeEventListener() {}
    getSettings() { return { deviceId: 'device-default' }; }
    dispatchEvent(event) { (this._listeners[event.type] || []).forEach((fn) => fn(event)); }
}

// getUserMedia that resolves only when the test says so, so a toggle can be
// "still in flight" — which is the state every one of these bugs lived in.
let pending = [];
const acquisitions = [];
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
        mediaDevices: {
            getUserMedia(constraints) {
                const kind = constraints.audio ? 'audio' : 'video';
                return new Promise((resolve) => {
                    pending.push(() => {
                        const track = new FakeTrack(kind);
                        const stream = new globalThis.MediaStream([track]);
                        acquisitions.push({ kind, stream, track });
                        resolve(stream);
                    });
                });
            },
            addEventListener() {}, removeEventListener() {}, enumerateDevices: async () => [],
        },
    },
});
async function releaseDevices() {
    const queue = pending;
    pending = [];
    queue.forEach((fn) => fn());
    await sleep(0);
}

class FakePC {
    constructor() {
        this.signalingState = 'stable';
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this._senders = [];
    }
    addTransceiver(kind) {
        const sender = {
            kind, track: null,
            replaceTrack: async (track) => { sender.track = track; },
        };
        this._senders.push(sender);
        return { sender };
    }
    getSenders() { return this._senders; }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
    setLocalDescription() { this.signalingState = 'have-local-offer'; return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0' }); }
    addIceCandidate() { return Promise.resolve(); }
    restartIce() {}
    getStats() { return Promise.resolve(new Map()); }
    close() { this.signalingState = 'closed'; this.connectionState = 'closed'; }
}
globalThis.RTCPeerConnection = FakePC;

// ------------------------------------------------------------------- the code
const { MeshMedia } = await import(path.join(JS, 'mesh.js'));
const { Media } = await import(path.join(JS, 'media.js'));

const signals = [];
const mesh = new MeshMedia();
await mesh.init({
    roomCode: 'check',
    self: { identity: 'u:1', memberId: 1, name: 'me' },
    permissions: { can_use_microphone: true, can_use_camera: true },
    signal: (payload) => signals.push(payload),
    onStateChange: () => {},
    onQualityChange: () => {},
    onNetStats: () => {},
});

// ---- 1. intent queue ------------------------------------------------------
mesh.syncPeers([{ identity: 'u:2', member_id: 2, name: 'peer', permissions: {}, muted: false }]);
const link = mesh.links.get('u:2');
check(Boolean(link) && !link.closed, 'a peer link is created and open');
const baseline = signals.length;

const first = mesh.toggleMicrophone();
const second = mesh.toggleMicrophone();
await releaseDevices();
await Promise.all([first, second]);
check(mesh.micOn === false, 'a fast on/off double tap ends with the microphone OFF');
check(acquisitions.at(-1).track.stopped, 'the stale acquisition is stopped, never published');
check(signals.length === baseline, 'a microphone toggle sends no renegotiation traffic');

// ---- 2. epoch guard (moderation wins) ------------------------------------
const pendingOn = mesh.toggleMicrophone();
mesh.applyModerationState({ muted: true, camera_disabled: false });
await releaseDevices();
await pendingOn;
check(mesh.micOn === false, 'a late getUserMedia cannot undo a moderator mute');
check(acquisitions.at(-1).track.stopped, 'the muted acquisition is released');
check(mesh._canUseMic() === false, 'the microphone is revoked while muted');

mesh.permissions.can_use_microphone = true;
mesh.applyModerationState({ muted: false, camera_disabled: false });
check(mesh._canUseMic() === true, 'a re-grant restores the microphone without a reload');

// ---- 3. camera ------------------------------------------------------------
const camOn = mesh.toggleCamera();
await releaseDevices();
await camOn;
const camTrack = mesh.localStream.getVideoTracks()[0];
check(mesh.cameraOn === true && camTrack && !camTrack.stopped, 'the camera turns on and keeps its track');
mesh._camOff();
check(mesh.cameraOn === false && camTrack.stopped, 'turning the camera off stops the device');

// ---- 4. ICE batching ------------------------------------------------------
link._queueIce('media', { candidate: 'c1' });
link._queueIce('media', { candidate: 'c2' });
check(signals.length === baseline, 'queued candidates wait for the coalescing window');
await sleep(200);
const batches = signals.filter((message) => message.data && message.data.ice);
check(batches.length === 1, 'two candidates become one envelope');
check(Array.isArray(batches[0].data.ice) && batches[0].data.ice.length === 2, 'the envelope carries the batch');
check(batches[0].action === 'rtc_signal' && batches[0].to_member_id === 2, 'the batch is addressed to the peer');

link._queueIce('media', { candidate: 'c3' });
await sleep(200);
const lone = signals.filter((message) => message.data && message.data.ice).at(-1);
check(!Array.isArray(lone.data.ice) && lone.data.ice.candidate === 'c3', 'a lone candidate is not wrapped in an array');

// ---- 5. teardown ----------------------------------------------------------
const inFlight = mesh.toggleMicrophone();
mesh.dispose();
await releaseDevices();
await inFlight;
check(mesh._disposed === true, 'dispose marks the engine dead');
check(link.closed === true, 'dispose closes the peer link');
check(mesh._fadeTimers.size === 0, 'dispose leaves no peer-fade timers');
check(mesh._pendingSignals.length === 0, 'dispose clears the buffered signals');
check(!mesh._statsTimer && !mesh._speakerTimer && !mesh._netTimer, 'dispose clears every interval');
check(acquisitions.at(-1).track.stopped, 'a getUserMedia resolving after dispose is stopped');

// ---- 6. the facade announces once ----------------------------------------
const sent = [];
await Media.init({
    roomCode: 'check2',
    self: { identity: 'u:9', memberId: 9, name: 'me' },
    permissions: { can_use_microphone: true, can_use_camera: true },
    signal: () => {},
    mediaEnabled: false,
    meshEnabled: true,
    mediaUrl: '',
    onStateChange: (state) => sent.push(state),
    onQualityChange: () => {},
    onNetStats: () => {},
});
const impl = Media.impl;
impl._syncLocalUI();
await sleep(140);
check(sent.length === 1, 'the first media state is announced once');

impl._syncLocalUI();
impl._syncLocalUI();
await sleep(140);
check(sent.length === 1, 'identical repeats never reach the socket');

impl.micOn = true;
impl._syncLocalUI();
impl._syncLocalUI();
impl._syncLocalUI();
await sleep(140);
check(sent.length === 2 && sent[1].mic_on === true, 'a real change is announced exactly once');

Media.pushMediaState();
check(sent.length === 3, 'a reconnect replay bypasses the dedupe');
Media.dispose();

// ------------------------------------------------------------------- summary
tilesEl.children.length = 0;
if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nall media-toggle checks passed');
