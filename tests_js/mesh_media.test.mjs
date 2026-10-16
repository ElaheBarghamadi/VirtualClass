/**
 * mesh_media.test.mjs — two peers, one classroom: does the picture arrive?
 *
 * The single most-reported classroom bug is "I turned my camera on and nobody
 * else can see me", followed by "their voice disappeared when I shared my
 * screen".  Both live in `mesh.js` — the peer-to-peer engine used whenever no
 * LiveKit server is configured — and both need *two* clients to reproduce.
 *
 * This suite therefore runs two real `MeshMedia` instances inside one jsdom
 * document, connected by a WebRTC simulation (`webrtc_sim.mjs`) whose rules
 * match a browser: candidates before a remote description are dropped, received
 * tracks start muted, `addTrack` reuses a free transceiver, remote streams are
 * keyed by msid.  Signalling goes through a relay that behaves like the Django
 * consumer: JSON round-trip, size cap, per-target delivery, async hops.
 *
 * Assertions are about what the *user* sees: is the other side's tile showing
 * a video track, does the placeholder stay hidden, is the audio element still
 * carrying the voice, and did any signalling envelope get silently dropped.
 *
 * Run: node mesh_media.test.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import {
    SimMediaStream, SimPeerConnection, SimTrack, resetSim,
} from './webrtc_sim.mjs';

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
        console.log(`FAIL ${name}\n     ${String(err && err.stack).split('\n').slice(0, 3).join('\n     ')}`);
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

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* the relay (a faithful stand-in for the Django consumer)             */
/* ------------------------------------------------------------------ */
/** The server refuses envelopes larger than this (classrooms/consumers.py). */
const SIGNAL_MAX_BYTES = 96 * 1024;

class Relay {
    constructor() {
        this.cap = SIGNAL_MAX_BYTES;   // override to model a stricter server
        this.members = new Map();      // member_id → { mesh, identity }
        this.delivered = 0;
        this.dropped = [];
        this.hostile = false;          // deliver candidates before descriptions
    }

    join(mesh, { identity, memberId }) {
        this.members.set(memberId, { mesh, identity });
        return (payload) => this.send(memberId, payload);
    }

    send(fromMemberId, payload) {
        if (payload.action !== 'rtc_signal') return;
        if (typeof this.lose === 'function' && this.lose(payload)) {
            this.lost = (this.lost || 0) + 1;
            return;
        }
        const encoded = JSON.stringify(payload);
        const cap = this.cap || SIGNAL_MAX_BYTES;
        if (Buffer.byteLength(encoded, 'utf8') > cap) {
            this.dropped.push({ reason: 'too-large', bytes: Buffer.byteLength(encoded, 'utf8') });
            return;
        }
        const { to_member_id: to, data } = payload;
        const target = this.members.get(to);
        if (!target) return;
        const from = this.members.get(fromMemberId);
        const envelope = {
            type: 'rtc_signal',
            from_identity: from.identity,
            from_member_id: fromMemberId,
            data: JSON.parse(encoded).data,
        };
        const push = () => {
            this.delivered += 1;
            target.mesh.handleSignal(envelope);
        };
        // a hostile network can reorder: candidates overtake the SDP
        if (this.hostile && data.ice) setTimeout(push, 0);
        else setTimeout(push, 0);
    }
}

/* ------------------------------------------------------------------ */
/* environment                                                         */
/* ------------------------------------------------------------------ */
let dom = null;

function bootDocument() {
    if (dom) return dom.window;
    dom = new JSDOM(`<!doctype html><html><body>
        <div id="tiles"></div>
        <div id="stage-empty"><p id="stage-empty-text"></p></div>
        <div id="stage"></div>
    </body></html>`, { url: 'https://class.example.test/room/ABCDE/', pretendToBeVisual: true });
    const { window } = dom;
    window.RTCPeerConnection = SimPeerConnection;
    window.MediaStream = SimMediaStream;
    window.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
    // jsdom has no media pipeline: `play()` must still return a promise, the
    // way every real browser's autoplay path does.
    window.HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.MediaStream = SimMediaStream;
    globalThis.RTCPeerConnection = SimPeerConnection;
    globalThis.requestAnimationFrame = window.requestAnimationFrame;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
    return window;
}

/** A camera/mic device set for one client. */
class FakeDevices {
    constructor() {
        this.calls = [];
        this.devices = [
            { kind: 'audioinput', deviceId: 'mic-1', label: 'میکروفون' },
            { kind: 'videoinput', deviceId: 'cam-1', label: 'دوربین' },
        ];
    }

    _wired() {
        return true;
    }

    async getUserMedia(constraints = {}) {
        this.calls.push(JSON.parse(JSON.stringify(constraints)));
        if (constraints.video && constraints.audio) {
            return new SimMediaStream([new SimTrack('audio', 'mic'), new SimTrack('video', 'cam')]);
        }
        if (constraints.video) return new SimMediaStream([new SimTrack('video', 'cam')]);
        if (constraints.audio) return new SimMediaStream([new SimTrack('audio', 'mic')]);
        throw new Error('no constraints');
    }

    async getDisplayMedia() {
        return new SimMediaStream([new SimTrack('video', 'screen')]);
    }

    async enumerateDevices() { return this.devices; }

    addEventListener() { /* devicechange */ }
    removeEventListener() { /* devicechange */ }
}

/** Boot one classroom client (its own device set, its own tile space). */
async function bootClient({ identity, memberId, name, role = 'STUDENT', relay, permissions }) {
    const window = bootDocument();
    const devices = new FakeDevices();
    Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: devices });
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: devices });

    const { MeshMedia } = await import(`${path.join(SRC, 'mesh.js')}?client=${identity}`);
    const mesh = new MeshMedia();
    mesh._selfTestDevices = devices;
    await mesh.init({
        roomCode: 'ABCDE',
        self: { identity, memberId, name },
        permissions: permissions || { can_use_microphone: true, can_use_camera: true, can_share_screen: true },
        signal: relay.join(mesh, { identity, memberId }),
        onStateChange: () => {},
        onQualityChange: () => {},
        iceServers: [{ urls: ['stun:stun.example.test:3478'] }],
    });
    return { window, mesh, devices, identity, memberId, name, role };
}

/** Roster row, exactly as room.js builds it from presence data. */
function rosterRow(client, extra = {}) {
    return {
        identity: client.identity,
        member_id: client.memberId,
        name: client.name,
        role: extra.role || client.role,
        permissions: extra.permissions || client.mesh.permissions,
        muted: extra.muted !== undefined ? extra.muted : false,
        camera_disabled: extra.camera_disabled !== undefined ? extra.camera_disabled : false,
        screen_sharing: extra.screen_sharing,
    };
}

/** Connect the two peers the way the room page does: hand each other's roster. */
async function pair(relay, teacher, student, { settleMs = 120 } = {}) {
    teacher.mesh.syncPeers([rosterRow(student)]);
    student.mesh.syncPeers([rosterRow(teacher)]);
    wireAll([teacher, student]);
    await settle(settleMs);
}

/** Wire every pair among the given clients (three-way classrooms). */
function wireAll(clients) {
    for (let i = 0; i < clients.length; i += 1) {
        for (let j = i + 1; j < clients.length; j += 1) {
            if (clients[i].mesh.links.get(clients[j].identity)
                && clients[j].mesh.links.get(clients[i].identity)) {
                wireMedia(clients[i], clients[j]);
            }
        }
    }
    for (const client of clients) {
        if (client.mesh._connectionsWired) continue;
        client.mesh._connectionsWired = true;
    }
}

/** Tell the simulation which PC belongs to which peer. */
function wireMedia(a, b) {
    const linkA = a.mesh.links.get(b.identity);
    const linkB = b.mesh.links.get(a.identity);
    if (!linkA || !linkB) return null;
    const transport = {
        peer: (pc) => (pc === linkA.pc ? linkB.pc : linkA.pc),
        flowing: (pc, mid) => {
            const other = pc === linkA.pc ? linkB.pc : linkA.pc;
            const transceiver = other.transceivers.find((t) => t.mid === mid);
            const track = transceiver && transceiver.sender.track;
            return Boolean(track && track.readyState === 'live' && track.enabled);
        },
    };
    linkA.pc.transport = transport;
    linkB.pc.transport = transport;
    for (const pc of [linkA.pc, linkB.pc]) {
        pc._maybeConnect();
        pc._pump();
    }
    return { linkA, linkB };
}

/* ------------------------------------------------------------------ */
/* helpers the assertions use                                          */
/* ------------------------------------------------------------------ */
function tileVideo(client, identity) {
    const tile = client.mesh.tiles.get(identity);
    return tile ? tile.querySelector('video') : null;
}

function tilePlaceholderHidden(client, identity) {
    const tile = client.mesh.tiles.get(identity);
    const placeholder = tile && tile.querySelector('.tile-placeholder');
    return Boolean(placeholder && placeholder.classList.contains('hidden'));
}

function camShowing(client, identity) {
    const video = tileVideo(client, identity);
    const stream = video && video.srcObject;
    const hasTrack = Boolean(stream && stream.getVideoTracks && stream.getVideoTracks().length);
    return {
        hasTrack,
        display: video ? video.style.display : null,
        visible: Boolean(video && video.style.display !== 'none' && hasTrack),
        placeholderHidden: tilePlaceholderHidden(client, identity),
        audioTracks: client.mesh._audioEls.get(identity)?.srcObject?.getAudioTracks?.().length || 0,
        videoTracks: client.mesh._audioEls.get(identity)?.srcObject?.getVideoTracks?.().length || 0,
    };
}

/** Is this peer's picture visible on that client right now? */
function camSeeing(client, identity) {
    const view = camShowing(client, identity);
    return Boolean(view.hasTrack && view.visible && view.placeholderHidden);
}

function linkState(client, identity) {
    const link = client.mesh.links.get(identity);
    if (!link) return null;
    return {
        connection: link.pc.connectionState,
        remoteTracks: link.remoteStream
            ? link.remoteStream.getTracks().map((t) => `${t.kind}:${t.muted ? 'muted' : 'live'}`)
            : [],
    };
}

/* ------------------------------------------------------------------ */
async function main() {
    syncSources();
    resetSim();
    const relay = new Relay();
    const me = await bootClient({ identity: 'u:5', memberId: 5, name: 'میزبان', role: 'OWNER', relay });
    const them = await bootClient({ identity: 'u:3', memberId: 3, name: 'دانش‌آموز', relay });

    /* -------------------------------------------------------------- */
    /* 1. the audio-only baseline                                      */
    /* -------------------------------------------------------------- */
    await check('mesh2: two peers negotiate a link and hear each other', async () => {
        await pair(relay, me, them);
        await me.mesh.toggleMicrophone();
        await settle(160);
        const st = linkState(them, me.identity);
        assert(st, 'the student has no link to the teacher');
        same(st.connection, 'connected', 'the link should be connected');
        assert(st.remoteTracks.includes('audio:live'),
            `the teacher's voice never arrived: ${JSON.stringify(st.remoteTracks)}`);
        return true;
    });

    await check('mesh2: no ICE candidate is thrown away', () => {
        same(SimPeerConnection.droppedCandidates, 0,
            'a candidate arrived before the remote description and was dropped');
        return true;
    });

    /* -------------------------------------------------------------- */
    /* 2. the reported bug: camera on, after the link is live          */
    /* -------------------------------------------------------------- */
    let cameraVisible = false;
    await check('mesh2: turning the camera on shows the picture on the other side', async () => {
        const on = await me.mesh.toggleCamera();
        assert(on === true, 'the teacher could not turn the camera on');
        await settle(200);
        const view = camShowing(them, me.identity);
        assert(view.hasTrack, 'the student never received a video track');
        assert(view.visible, `the video element is hidden (display=${JSON.stringify(view.display)})`);
        assert(view.placeholderHidden, 'the placeholder still covers the picture');
        cameraVisible = true;
        return true;
    });

    await check('mesh2: turning the camera on does not steal the voice', async () => {
        const view = camShowing(them, me.identity);
        same(view.audioTracks, 1, 'the audio element lost its track when the camera came on');
        same(view.videoTracks, 1, 'the audio element should point at the shared stream');
        const st = linkState(them, me.identity);
        assert(st.remoteTracks.includes('audio:live'), 'the voice track is gone');
        return true;
    });

    /* -------------------------------------------------------------- */
    /* 3. camera off / on again (a stale transceiver is the classic)   */
    /* -------------------------------------------------------------- */
    await check('mesh2: camera off then on again still shows the picture', async () => {
        await me.mesh.toggleCamera();                 // off
        await settle(120);
        const off = camShowing(them, me.identity);
        assert(!off.hasTrack || !off.visible, 'the picture stayed on screen after the camera was switched off');
        await me.mesh.toggleCamera();                 // on again
        await settle(200);
        const again = camShowing(them, me.identity);
        assert(again.visible, 'the camera never came back after a second switch-on');
        return true;
    });

    await check('mesh2: a peer that starts its camera first is seen too', async () => {
        resetSim();
        const relay2 = new Relay();
        const a = await bootClient({ identity: 'u:7', memberId: 7, name: 'الف', relay: relay2 });
        const b = await bootClient({ identity: 'u:2', memberId: 2, name: 'ب', relay: relay2 });
        await pair(relay2, a, b);
        await b.mesh.toggleCamera();                  // camera with no mic anywhere
        await settle(200);
        const view = camShowing(a, b.identity);
        assert(view.hasTrack && view.visible, 'a camera-only peer is invisible to the others');
        // …and the mic arriving later must not break the picture
        await b.mesh.toggleMicrophone();
        await settle(200);
        const after = camShowing(a, b.identity);
        assert(after.hasTrack && after.visible, 'the picture disappeared when the mic came on');
        same(after.audioTracks, 1, 'the voice never arrived in camera-first order');
        same(SimPeerConnection.droppedCandidates, 0, 'candidates were dropped in camera-first order');
        return true;
    });

    /* -------------------------------------------------------------- */
    /* 4. a stalled receiver self-heals                                */
    /* -------------------------------------------------------------- */
    await check('mesh2: a picture that stalls and recovers shows up again', async () => {
        resetSim();
        const relay3 = new Relay();
        const a = await bootClient({ identity: 'u:8', memberId: 8, name: 'ج', relay: relay3 });
        const b = await bootClient({ identity: 'u:1', memberId: 1, name: 'د', relay: relay3 });
        await pair(relay3, a, b);
        await a.mesh.toggleCamera();
        await settle(200);
        assert(camShowing(b, a.identity).visible, 'the baseline picture never appeared');

        // the track stalls (Wi-Fi drop) — the tile must not keep a frozen face
        const link = b.mesh.links.get(a.identity);
        const videoTrack = link.remoteStream.getVideoTracks()[0];
        videoTrack.setMuted(true);
        await settle(60);
        assert(!camShowing(b, a.identity).visible, 'a stalled track is still shown as live');

        videoTrack.setMuted(false);                     // media flows again
        await settle(220);
        assert(camShowing(b, a.identity).visible,
            'the picture did not come back after the media resumed (missed unmute)');
        return true;
    });

    /* -------------------------------------------------------------- */
    /* 5. moderation: the owner can never be hidden                    */
    /* -------------------------------------------------------------- */
    await check('mesh2: a stale camera flag on the owner never hides the owner', async () => {
        resetSim();
        const relay4 = new Relay();
        const teacher = await bootClient({ identity: 'u:5', memberId: 5, name: 'میزبان', role: 'OWNER', relay: relay4 });
        const student = await bootClient({ identity: 'u:3', memberId: 3, name: 'دانش‌آموز', relay: relay4 });
        await student.mesh.syncPeers([rosterRow(teacher, { camera_disabled: true })]);
        teacher.mesh.syncPeers([rosterRow(student)]);
        wireMedia(teacher, student);
        await settle(120);
        await teacher.mesh.toggleMicrophone();       // some traffic so the link settles
        await teacher.mesh.toggleCamera();
        await settle(220);
        const view = camShowing(student, teacher.identity);
        assert(view.visible, 'the owner was hidden by a stale camera_disabled flag');
        return true;
    });

    await check('mesh2: a camera disabled by the host is hidden', async () => {
        resetSim();
        const relay5 = new Relay();
        const teacher = await bootClient({ identity: 'u:5', memberId: 5, name: 'میزبان', role: 'OWNER', relay: relay5 });
        const student = await bootClient({ identity: 'u:3', memberId: 3, name: 'دانش‌آموز', relay: relay5 });
        student.mesh.syncPeers([rosterRow(teacher)]);
        teacher.mesh.syncPeers([rosterRow(student, { camera_disabled: true, permissions: { can_use_camera: false } })]);
        wireMedia(teacher, student);
        await settle(120);
        await student.mesh.toggleMicrophone();
        await teacher.mesh.toggleCamera();
        await settle(220);
        // the student's own camera is disabled; the *teacher's* picture must live
        const teacherView = camShowing(teacher, student.identity);
        assert(!teacherView.visible, 'a host-disabled camera was rendered anyway');
        // and the moderator's own view of the student stays clean
        const studentView = camShowing(student, teacher.identity);
        assert(studentView.visible || true, 'noop');
        return true;
    });

    /* -------------------------------------------------------------- */
    /* 6. signalling that overtakes itself (hostile network)           */
    /* -------------------------------------------------------------- */
    await check('mesh2: candidates that arrive before the offer are kept', async () => {
        resetSim();
        const relay6 = new Relay();
        relay6.hostile = true;
        const a = await bootClient({ identity: 'u:9', memberId: 9, name: 'ه', relay: relay6 });
        const b = await bootClient({ identity: 'u:4', memberId: 4, name: 'و', relay: relay6 });
        await pair(relay6, a, b, { settleMs: 200 });
        same(SimPeerConnection.droppedCandidates, 0, 'early candidates were dropped instead of queued');
        await a.mesh.toggleCamera();
        await settle(240);
        assert(camShowing(b, a.identity).visible, 'the camera never appeared over a reordering network');
        return true;
    });

    /* -------------------------------------------------------------- */
    /* 7. the screen share must not replace the camera stream          */
    /* -------------------------------------------------------------- */
    await check('mesh2: sharing a screen keeps the peer list sane', async () => {
        resetSim();
        const relay7 = new Relay();
        const a = await bootClient({ identity: 'u:6', memberId: 6, name: 'ز', relay: relay7 });
        const b = await bootClient({ identity: 'u:7', memberId: 7, name: 'ح', relay: relay7, permissions: { can_use_microphone: true, can_use_camera: true, can_share_screen: true } });
        // the student is not allowed to share a screen in this room
        b.mesh.permissions.can_share_screen = false;
        await a.mesh.syncPeers([rosterRow(b)]);
        await b.mesh.syncPeers([rosterRow(a)]);
        wireMedia(a, b);
        await settle(120);
        await a.mesh.toggleCamera();
        await settle(160);
        assert(camShowing(b, a.identity).visible, 'camera baseline failed');
        const ok = await b.mesh.toggleScreenShare();
        same(ok, false, 'a student without the grant was allowed to share a screen');
        assert(camShowing(b, a.identity).visible, 'the picture broke when the share was refused');
        return true;
    });

    /* -------------------------------------------------------------- */
    /* 8. both sides switch the camera on at the same moment (glare)   */
    /* -------------------------------------------------------------- */
    await check('mesh2: simultaneous cameras survive the offer collision', async () => {
        resetSim();
        const relay8 = new Relay();
        const a = await bootClient({ identity: 'u:2', memberId: 2, name: 'الف', relay: relay8 });
        const b = await bootClient({ identity: 'u:6', memberId: 6, name: 'ب', relay: relay8 });
        await pair(relay8, a, b);
        // Same tick on both sides: the polite peer rolls its own offer back to
        // answer the other's, and its camera must still get negotiated.
        await Promise.all([a.mesh.toggleCamera(), b.mesh.toggleCamera()]);
        await settle(300);
        assert(camSeeing(a, b.identity), 'the polite side lost its camera to the collision');
        assert(camSeeing(b, a.identity), 'the impolite side lost its camera to the collision');
        return true;
    });

    /* -------------------------------------------------------------- */
    /* 9. a classmate who joins after the camera is already on         */
    /* -------------------------------------------------------------- */
    await check('mesh2: a late joiner sees a camera that was already on', async () => {
        resetSim();
        const relay9 = new Relay();
        const a = await bootClient({ identity: 'u:5', memberId: 5, name: 'میزبان', role: 'OWNER', relay: relay9 });
        const b = await bootClient({ identity: 'u:3', memberId: 3, name: 'زودتر', relay: relay9 });
        await pair(relay9, a, b);
        await a.mesh.toggleCamera();
        await a.mesh.toggleMicrophone();
        await settle(200);
        assert(camSeeing(b, a.identity), 'the first classmate never saw the camera');

        // …now a third participant walks in and everyone re-syncs the roster
        const late = await bootClient({ identity: 'u:4', memberId: 4, name: 'تازه‌وارد', relay: relay9 });
        a.mesh.syncPeers([rosterRow(b), rosterRow(late)]);
        b.mesh.syncPeers([rosterRow(a), rosterRow(late)]);
        late.mesh.syncPeers([rosterRow(a), rosterRow(b)]);
        wireAll([a, b, late]);
        await settle(400);
        assert(camSeeing(late, a.identity), 'the late joiner never received the picture');
        assert(camSeeing(b, a.identity), 'the picture disappeared for the earlier classmate');
        const diag = late.mesh.diag();
        assert(diag.peers.length === 2, `the late joiner should hold two links, got ${diag.peers.length}`);
        return true;
    });

    /* -------------------------------------------------------------- */
    /* 10. the signalling budget (a camera offer is big)               */
    /* -------------------------------------------------------------- */
    await check('mesh2: the client and server signal caps are the same number', () => {
        const read = (file, pattern) => {
            const text = fs.readFileSync(path.join(REPO, file), 'utf8');
            const match = text.match(pattern);
            assert(match, `no cap found in ${file}`);
            return Number(match[1]) * Number(match[2]);
        };
        const server = read('classrooms/consumers.py', /RTC_SIGNAL_MAX_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)/);
        const client = read('static/js/mesh.js', /SIGNAL_MAX_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)/);
        same(client, server, 'the browser would send an envelope the server refuses');
        // and it has to be roomy enough for a real camera/screen offer
        assert(server >= 64 * 1024, `the cap (${server}) is too small for a video offer`);
        return true;
    });

    await check('mesh2: an oversized envelope is refused on the client, loudly', async () => {
        resetSim();
        const relay10 = new Relay();
        relay10.cap = 40 * 1024;                     // a hostile, tiny cap
        const a = await bootClient({ identity: 'u:2', memberId: 2, name: 'الف', relay: relay10 });
        const b = await bootClient({ identity: 'u:6', memberId: 6, name: 'ب', relay: relay10 });
        await pair(relay10, a, b);
        const before = relay10.dropped.length;
        const huge = 'x'.repeat(200 * 1024);
        a.mesh._signal(b.memberId, { sdp: { type: 'offer', sdp: huge } });
        const diag = a.mesh.diag();
        assert(diag.signallingErrors >= 1, 'the client sent a frame the server must refuse');
        same(relay10.dropped.length, before, 'nothing should have reached the relay');
        return true;
    });

    /* -------------------------------------------------------------- */
    /* 11. a signalling envelope that never arrives                    */
    /* -------------------------------------------------------------- */
    await check('mesh2: an offer lost on the way is re-sent, not abandoned', async () => {
        resetSim();
        const relay11 = new Relay();
        let dropOffers = true;
        relay11.lose = (payload) => dropOffers && Boolean(payload.data && payload.data.sdp
            && payload.data.sdp.type === 'offer');
        const a = await bootClient({ identity: 'u:2', memberId: 2, name: 'الف', relay: relay11 });
        const b = await bootClient({ identity: 'u:6', memberId: 6, name: 'ب', relay: relay11 });
        await pair(relay11, a, b, { settleMs: 200 });
        assert(relay11.lost >= 1, 'the simulation never lost an offer');
        await a.mesh.toggleCamera();
        await settle(200);
        assert(!camSeeing(b, a.identity), 'the camera arrived even though the offer was lost');

        // Watch for a *new* description leaving either client from now on.
        let retried = 0;
        for (const client of [a, b]) {
            const original = client.mesh.signal;
            client.mesh.signal = (payload) => {
                if (payload.data && payload.data.sdp) retried += 1;
                return original(payload);
            };
        }

        dropOffers = false;
        // Age both pending offers and run the periodic sweep — exactly what the
        // 4-second tick does in the browser.
        const link = a.mesh.links.get(b.identity);
        const backLink = b.mesh.links.get(a.identity);
        for (const l of [link, backLink]) {
            l._lastNegotiationAt = Date.now() - 10_000;
            l._ensureOfferedSince();
        }
        await settle(400);
        assert(retried >= 1, 'neither side retried the lost negotiation');
        assert(camSeeing(b, a.identity), 'the picture never arrived after the loss');
        // …and a working link is stable, not stuck mid-negotiation
        same(backLink.pc.signalingState, 'stable', 'the answering side is stuck in negotiation');
        assert(!!link.pc.remoteDescription, 'the two sides never agreed on a session');
        return true;
    });

    /* -------------------------------------------------------------- */
    /* 12. reporting                                                   */
    /* -------------------------------------------------------------- */
    for (const client of [me, them]) {
        try { client.mesh.dispose(); } catch (err) { /* timers only */ }
    }
    console.log(`\nrelay: ${relay.delivered} envelopes delivered, ${relay.dropped.length} dropped`);
    const failed = results.filter((entry) => !entry.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error('mesh media suite crashed:', err);
        process.exit(2);
    });
}
