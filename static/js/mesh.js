/**
 * mesh.js — peer-to-peer media fallback (no external SFU required).
 *
 * When a LiveKit server is not configured, classroom audio/video/screen
 * still has to work: this module builds a small WebRTC *mesh* between the
 * participants.  Django never touches media — it only relays opaque
 * SDP/ICE envelopes between classmates over the presence WebSocket
 * ({"action":"rtc_signal"}), validated and size-capped server-side.
 *
 * Design notes:
 * - One RTCPeerConnection per peer for camera+mic, plus a *separate*
 *   connection per peer for screen share, so remote screens are never
 *   confused with camera video.
 * - "Perfect negotiation" pattern with a deterministic polite peer
 *   (lower member id is polite) — avoids glare on simultaneous offers.
 * - Track enable/disable (mute) needs no renegotiation; adding tracks
 *   triggers onnegotiationneeded automatically.
 * - Quality is computed from real getStats() data (packets lost/received,
 *   RTT) — never faked.
 * - Fine for small classrooms; large rooms should configure LiveKit.
 */
import { toast } from './toast.js';
import { LinkSampler, combineOwnership, formatRate } from './netstats.js';
import {
    analyserLevel, createAnalyser, createLevelTracker, createSpeakingGate, disposeAnalyser,
    paintMic, paintTile, resetMic, startLevelLoop,
} from './meter.js';

// Deployment-configurable (WEBRTC_ICE_SERVERS → data-ice-servers on the
// room root → Media.init).  Default is public Google STUN, which has no
// TURN relay — strict NATs need a coturn entry to connect reliably.
const DEFAULT_ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
let ICE_SERVERS = DEFAULT_ICE_SERVERS;

// How long we give a peer link to come up before declaring it unreachable,
// and how patient we are with a transient network drop before restarting ICE.
const CONNECT_TIMEOUT_MS = 10000;
const DISCONNECT_GRACE_MS = 3000;

/** Does the deployment provide a TURN relay?  Without one, strict NATs
 *  (corporate / mobile networks) can never be traversed and the failure
 *  message has to say so instead of hinting at a mystery. */
function hasTurnServer() {
    return ICE_SERVERS.some((s) => []
        .concat(s.urls || [])
        .some((u) => String(u).startsWith('turn')));
}

class PeerLink {
    constructor(mesh, peer) {
        this.mesh = mesh;
        this.peer = peer;                      // {identity, member_id, name}
        this.polite = mesh.self.memberId < peer.member_id;
        this.makingOffer = false;
        this.ignoreOffer = false;
        this.screenPc = null;                  // created on demand
        this.remoteStream = null;
        this.remoteScreenStream = null;
        this.failed = false;                   // gave up — shown in the UI
        this.retried = false;                  // one automatic ICE restart
        this._watchdog = null;
        this._recovery = null;
        this.pc = this._makePc(false);
        // One sampler per link: two cumulative getStats() snapshots become the
        // kbit/s, loss, jitter and RTT the network panel shows.
        this.sampler = new LinkSampler();
        this.net = null;                 // latest measured row for this peer
    }

    updatePeer(peer) {
        this.peer = { ...this.peer, ...peer };
        this.mesh._applyPeerPermissions(this);
    }

    _makePc(isScreen) {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        // Reserve the microphone and camera m-lines *now*, before any device is
        // on.  Turning the mic or camera on/off then becomes a plain
        // ``replaceTrack`` on an existing sender: no renegotiation, no offer
        // glare, no window in which one side never learns about the other's
        // track.  That window is exactly why «sometimes the camera works, and
        // the microphone never does».
        if (!isScreen) {
            this._senders = {};
            try {
                this._senders.audio = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
                this._senders.video = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
            } catch (err) {
                this._senders = {};       // very old browser: fall back to addTrack
            }
        }
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.mesh._signal(this.peer.member_id, { ice: e.candidate, screen: isScreen });
            }
        };
        pc.ontrack = (e) => {
            const stream = e.streams[0] || new MediaStream([e.track]);
            if (isScreen) {
                this.remoteScreenStream = stream;
                this.mesh._applyPeerPermissions(this);
            } else {
                this.remoteStream = stream;
                this.mesh._onRemoteMedia(this.peer, stream);
            }
        };
        pc.onnegotiationneeded = async () => {
            try {
                this.makingOffer = true;
                await pc.setLocalDescription(await pc.createOffer());
                this.mesh._signal(this.peer.member_id, { sdp: pc.localDescription, screen: isScreen });
                if (!isScreen) this.armWatchdog();
            } catch (err) {
                console.warn('[mesh] negotiation failed:', err);
            } finally {
                this.makingOffer = false;
            }
        };
        pc.oniceconnectionstatechange = () => { if (!isScreen) this._onConnectState(pc); };
        pc.onconnectionstatechange = () => {
            if (isScreen) return;
            // A closed PC is gone for good; a failed one may still recover
            // (network change, ICE restart) so it goes through _recover().
            if (pc.connectionState === 'closed') {
                this.mesh._onPeerGone(this.peer.identity);
                return;
            }
            // `encodings` only exist after negotiation, so the bitrate cap is
            // (re)applied when the link really comes up.
            if (this._isUp(pc)) this.mesh._tuneLink(this);
            this._onConnectState(pc);
        };
        return pc;
    }

    _isUp(pc) {
        return pc.connectionState === 'connected'
            || pc.iceConnectionState === 'connected'
            || pc.iceConnectionState === 'completed';
    }

    /**
     * Arm the "did this ever connect?" timer.  Only armed once we are really
     * negotiating — a silent link (nobody publishing, no data channel) is not
     * a failure, it is just idle.
     */
    armWatchdog() {
        if (this._watchdog || this._isUp(this.pc)) return;
        this._watchdog = setTimeout(() => {
            this._watchdog = null;
            if (!this._isUp(this.pc)) this._recover();
        }, CONNECT_TIMEOUT_MS);
    }

    /** Success: cancel every timer and clear any failure badge. */
    _settle() {
        clearTimeout(this._watchdog); this._watchdog = null;
        clearTimeout(this._recovery); this._recovery = null;
        this.retried = false;
        this._logPath();
        if (this.failed) {
            this.failed = false;
            this.mesh._onPeerRecovered(this.peer);
        }
    }

    /**
     * One console line per established link: **how** the two browsers reached
     * each other.  `relay` means a TURN server carried it (works everywhere),
     * `srflx`/`prflx` a direct path through NAT, `host` a same-network link.
     * This is the first thing to ask for when someone says «تصویر من به بقیه
     * نمی‌رسد» — no guessing, no browser flags.
     */
    async _logPath() {
        if (this._loggedPath) return;
        this._loggedPath = true;
        try {
            const stats = await this.pc.getStats();
            let pair = null;
            stats.forEach((row) => {
                if (row.type === 'candidate-pair' && row.state === 'succeeded') pair = row;
            });
            const local = pair && stats.get(pair.localCandidateId);
            const remote = pair && stats.get(pair.remoteCandidateId);
            const localType = (local && local.candidateType) || 'unknown';
            const remoteType = (remote && remote.candidateType) || 'unknown';
            console.info(
                `[mesh] link up with ${this.peer.name || this.peer.identity} ` +
                `local=${localType} remote=${remoteType}` +
                (localType === 'relay' || remoteType === 'relay' ? ' (TURN)' : ''),
            );
        } catch (e) {
            /* diagnostics must never break a call */
        }
    }

    _onConnectState(pc) {
        if (this._isUp(pc)) { this._settle(); return; }
        if (pc.connectionState === 'failed') { this._recover(); return; }
        if (pc.connectionState === 'disconnected') {
            // Often transient (Wi-Fi hiccup, laptop wake) — wait, then act.
            clearTimeout(this._recovery);
            this._recovery = setTimeout(() => {
                this._recovery = null;
                if (!this._isUp(this.pc)) this._recover();
            }, DISCONNECT_GRACE_MS);
        }
    }

    /**
     * Try one ICE restart (this is what recovers after a network change),
     * then give up and let the UI explain what is wrong.
     */
    _recover() {
        if (!this.retried) {
            this.retried = true;
            try { this.pc.restartIce(); } catch (e) { /* not supported */ }
            clearTimeout(this._watchdog); this._watchdog = null;
            this.armWatchdog();
            return;
        }
        clearTimeout(this._watchdog); this._watchdog = null;
        clearTimeout(this._recovery); this._recovery = null;
        if (this.failed) return;
        this.failed = true;
        console.warn(
            `[mesh] could not connect to ${this.peer.name || this.peer.identity}: ` +
            (hasTurnServer()
                ? 'ICE failed even with a TURN server configured — check that it is reachable on 443/3478/5349.'
                : 'no TURN relay configured (WEBRTC_ICE_SERVERS) — strict NATs/CGNAT cannot be traversed.'),
        );
        this.mesh._onPeerFailed(this.peer);
    }

    /** User pressed "try again" on the failed tile. */
    retryNow() {
        this.failed = false;
        this.retried = false;
        this._recover();
    }

    async handleSignal(data) {
        const isScreen = Boolean(data.screen);
        const pc = isScreen ? this._ensureScreenPc() : this.pc;
        if (data.sdp) {
            const description = data.sdp;
            const offerCollision =
                description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
            this.ignoreOffer = !this.polite && offerCollision;
            if (this.ignoreOffer) return;
            if (offerCollision) {
                // Perfect negotiation: the polite side rolls its own offer back
                // and accepts theirs.  Without this the accept throws on
                // `have-local-offer`, the promise is swallowed by the signal
                // handler, and the track that was just added is never sent —
                // one of the two peers simply never hears the other.
                await Promise.all([
                    pc.setLocalDescription({ type: 'rollback' }),
                    pc.setRemoteDescription(description),
                ]);
            } else {
                await pc.setRemoteDescription(description);
            }
            if (!isScreen) this.armWatchdog();
            if (description.type === 'offer') {
                await pc.setLocalDescription(await pc.createAnswer());
                this.mesh._signal(this.peer.member_id, { sdp: pc.localDescription, screen: isScreen });
            }
        } else if (data.ice) {
            try {
                await pc.addIceCandidate(data.ice);
            } catch (err) {
                if (!this.ignoreOffer) console.warn('[mesh] bad ICE candidate:', err);
            }
        }
    }

    _ensureScreenPc() {
        if (!this.screenPc) {
            this.screenPc = this._makePc(true);
        }
        return this.screenPc;
    }

    /**
     * Push the current local tracks to this peer.
     *
     * With the reserved transceivers this is only ``replaceTrack``: the same
     * sender is used for the whole lesson, so a device toggle costs no
     * negotiation at all.  ``null`` means «this device is off» — the m-line
     * stays, silent, which is what makes re-enabling instant.
     */
    publish(stream) {
        if (!this.pc || this.pc.signalingState === 'closed') return;
        const wanted = new Map();
        if (stream) for (const track of stream.getTracks()) wanted.set(track.kind, track);

        for (const kind of ['audio', 'video']) {
            const sender = this._senders && this._senders[kind];
            const track = wanted.get(kind) || null;
            if (sender) {
                if (sender.track !== track) sender.replaceTrack(track).catch(() => {});
                continue;
            }
            // No reserved transceiver (old browser): fall back to addTrack.
            const existing = this.pc.getSenders().find((s) => s.track && s.track.kind === kind);
            if (track && !existing) {
                try { this.pc.addTrack(track, stream); } catch (err) { /* noop */ }
            }
        }
        for (const [kind, track] of wanted) {
            if (kind === 'audio' || kind === 'video') continue;
            const existing = this.pc.getSenders().find((s) => s.track && s.track.kind === kind);
            if (!existing) { try { this.pc.addTrack(track, stream); } catch (err) { /* noop */ } }
        }
        this.mesh._tuneLink(this);
    }

    /** Backwards-compatible name used by older call sites. */
    addLocalTracks(stream) {
        this.publish(stream);
    }

    close() {
        clearTimeout(this._watchdog); this._watchdog = null;
        clearTimeout(this._recovery); this._recovery = null;
        try { this.pc.close(); } catch (e) { /* already closed */ }
        if (this.screenPc) { try { this.screenPc.close(); } catch (e) { /* noop */ } }
    }
}

class MeshMedia {
    constructor() {
        this.roomCode = '';
        this.self = { identity: '', memberId: 0, name: '' };
        this.permissions = {};
        this.signal = () => {};
        this.onStateChange = () => {};
        this.onQualityChange = () => {};

        this.links = new Map();          // identity → PeerLink
        this.localStream = null;         // camera+mic
        this.screenStream = null;        // getDisplayMedia
        this.micOn = false;
        this.cameraOn = false;
        this.activeSpeaker = null;
        this.layout = 'grid';
        this.quality = 'unknown';

        this.tilesEl = document.getElementById('tiles');
        this.emptyEl = document.getElementById('stage-empty');
        this.tiles = new Map();          // identity → tile element
        this.audioCtx = null;
        this.levels = new Map();         // identity → analyser
        this._audioEls = new Map();
        this._screenVideo = null;
        this._screenOwner = null;   // identity of the peer whose screen we view
        this._statsTimer = null;
        this._speakerTimer = null;
        this._netTimer = null;
        this.netStats = new Map();       // identity → latest measured row
        this.ownStats = null;            // worst-of aggregate for our own row
        this.onNetStats = () => {};      // room.js hook → the network panel
        this._localAnalyser = null;
        this._localLevelRaf = null;
        this.currentView = 'media';
        this._micDeviceId = null;         // remembered across acquisitions
        this._camDeviceId = null;
        this._toggling = { mic: false, camera: false };   // double-tap guard
        this._lastError = null;           // set by _acquire so callers can skip a 2nd toast
        this._deviceChangeBound = null;
    }

    async init({ roomCode, self, permissions, signal, onStateChange, onQualityChange, onNetStats, iceServers }) {
        this.roomCode = roomCode;
        this.self = self;
        this.permissions = permissions || {};
        this.signal = signal;
        this.onStateChange = onStateChange || (() => {});
        this.onQualityChange = onQualityChange || (() => {});
        this.onNetStats = onNetStats || (() => {});
        if (Array.isArray(iceServers) && iceServers.length) {
            ICE_SERVERS = iceServers;  // deployment-provided STUN/TURN list
        }
        try {
            const saved = localStorage.getItem(`room_layout_${roomCode}`);
            if (saved && ['grid', 'speaker', 'focus', 'presentation'].includes(saved)) this.layout = saved;
        } catch (e) { /* private mode */ }
        const emptyText = document.getElementById('stage-empty-text');
        if (emptyText) {
            emptyText.textContent = 'برای فعال کردن دوربین/میکروفون از دکمه‌های پایین استفاده کنید.';
        }
        // periodic real-stats quality + active-speaker evaluation
        // A throwing iteration must not take the timer (and with it every
        // level meter and the speaker focus) down for the rest of the lesson.
        this._statsTimer = setInterval(() => {
            try { this._evaluateQuality(); } catch (e) { console.warn('[mesh] stats tick failed', e); }
        }, 4000);
        this._speakerTimer = setInterval(() => {
            try { this._evaluateSpeaker(); } catch (e) { console.warn('[mesh] level tick failed', e); }
        }, 700);
        // Measured network numbers: every 2 s, per peer. Cheap (getStats is
        // local) and often enough that the panel feels live.
        this._sampleNet();
        this._netTimer = setInterval(() => {
            try { this._sampleNet(); } catch (e) { console.warn('[mesh] net tick failed', e); }
        }, 2000);
        this._watchDevices();
    }

    // ------------------------------------------------------------ roster
    /** Called by room.js whenever the roster changes. */
    syncPeers(peers) {
        const seen = new Set();
        for (const p of peers) {
            if (p.identity === this.self.identity) continue;
            seen.add(p.identity);
            if (!this.links.has(p.identity)) {
                const link = new PeerLink(this, p);
                this.links.set(p.identity, link);
                this._ensureTile(p);
                if (this.localStream) link.addLocalTracks(this.localStream);
                if (this.screenStream) this._attachScreenTo(link);
                // The reserved audio/video transceivers make the first offer
                // happen on their own (onnegotiationneeded), so the link comes
                // up before anyone turns a device on — no data-channel trick,
                // no «waiting for someone to press mic».
                this._replayPending(p.identity);
            } else {
                this.links.get(p.identity).updatePeer(p);
            }
        }
        for (const identity of Array.from(this.links.keys())) {
            if (!seen.has(identity)) this._removePeer(identity);
        }
        // More cameras → smaller frames for each of them (and vice versa).
        this._retuneAll();
    }

    _removePeer(identity) {
        const link = this.links.get(identity);
        if (link) link.close();
        this.links.delete(identity);
        const tile = this.tiles.get(identity);
        if (tile) {
            // Fade instead of a hard cut: a tile that disappears between two
            // frames reads as a glitch («صفحه پرش کرد»), a 300 ms fade reads as
            // «این نفر رفت» — and the roster row dims at the same time.
            tile.classList.add('is-left');
            setTimeout(() => tile.remove(), 320);
        }
        this.tiles.delete(identity);
        const audio = this._audioEls.get(identity);
        if (audio) { audio.srcObject = null; audio.remove(); }
        this._audioEls.delete(identity);
        disposeAnalyser(this.levels.get(identity));
        this.levels.delete(identity);
        if (this.activeSpeaker === identity) this.activeSpeaker = null;
        if (this._screenOwner === identity) this._hideScreenView();
        this._layout();
        this._retuneAll();
    }

    _onPeerGone(identity) {
        // connection died (e.g. peer tab closed without clean signal)
        if (this.links.has(identity)) this._removePeer(identity);
    }

    /**
     * Roster media_state hook from room.js: when the peer whose screen we
     * are viewing reports `screen_sharing: false` (their track close can
     * take seconds to surface), leave the screen view immediately.
     */
    onPeerMediaState(p) {
        if (!p || !p.identity || p.identity === this.self?.identity) return;
        const link = this.links.get(p.identity);
        if (link) link.updatePeer(p);
        if (p.screen_sharing === false && this._screenOwner === p.identity) {
            this._hideScreenView();
        }
    }

    /**
     * A peer link never came up.  Silence here is the worst possible answer:
     * the teacher sees an empty tile and assumes the student has no camera.
     * Say what happened and — when no relay is configured — say why.
     */
    _onPeerFailed(peer) {
        const tile = this._ensureTile(peer);
        tile.classList.add('conn-failed');
        if (tile.querySelector('.tile-conn')) return;
        const box = document.createElement('div');
        box.className = 'tile-conn';
        const title = document.createElement('p');
        title.textContent = `ارتباط با ${peer.name || 'هم‌کلاسی'} برقرار نشد`;
        const hint = document.createElement('small');
        hint.textContent = hasTurnServer()
            ? 'اتصال شبکه برقرار نشد؛ وضعیت اینترنت را بررسی کنید.'
            : 'شبکهٔ شما یا هم‌کلاسی‌تان اجازهٔ ارتباط مستقیم نمی‌دهد (NAT/فایروال). برای رفعِ دائمی به سرور TURN نیاز است.';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm';
        btn.textContent = 'تلاشِ دوباره';
        btn.addEventListener('click', (e) => { e.stopPropagation(); this.retryPeer(peer.identity); });
        box.append(title, hint, btn);
        tile.appendChild(box);
        this._reportConnFailure();
        this._layout();
    }

    _onPeerRecovered(peer) {
        const tile = this.tiles.get(peer.identity);
        if (!tile) return;
        tile.classList.remove('conn-failed');
        tile.querySelector('.tile-conn')?.remove();
        this._layout();
    }

    /** One nudge per session — the tile itself keeps explaining per peer. */
    _reportConnFailure() {
        if (this._connWarned) return;
        this._connWarned = true;
        toast(hasTurnServer()
            ? 'ارتباط تصویری با بعضی هم‌کلاسی‌ها برقرار نشد؛ اتصال شبکه را بررسی کنید.'
            : 'ارتباط تصویری با بعضی هم‌کلاسی‌ها برقرار نشد. پشت شبکهٔ شرکتی/موبایل تنظیمِ سرور TURN لازم است (راهنما در README).',
            'warning', 8000);
    }

    /**
     * The browser says the network is back (Wi-Fi switch, sleep/wake).
     *
     * Every peer connection was negotiated with the *old* local addresses, so
     * the dead ones will not heal on their own — but the grace timers may be
     * seconds away from firing.  Restarting ICE now is the cheapest recovery
     * available and costs nothing when everything is already connected.
     */
    onNetworkOnline() {
        this.links.forEach((link) => {
            if (!link.pc) return;
            const up = link._isUp(link.pc);
            if (up && link.pc.connectionState === 'connected') return;
            link.retried = false;
            link.failed = false;
            try {
                link.pc.restartIce();
            } catch (err) {
                // Not supported (older Safari): fall back to the normal path.
                return;
            }
            if (!up) {
                clearTimeout(link._recovery);
                link._recovery = null;
                link.armWatchdog();
            }
        });
    }

    /** Re-run ICE for one peer after the user asked for another attempt. */
    retryPeer(identity) {
        const link = this.links.get(identity);
        if (!link) return;
        const tile = this.tiles.get(identity);
        tile?.classList.remove('conn-failed');
        tile?.querySelector('.tile-conn')?.remove();
        link.retryNow();
    }

    // ------------------------------------------------------------ local
    /**
     * Device handling philosophy: "off" means OFF.  The track is fully
     * stopped (the browser's recording indicator goes dark and the OS
     * device is released) — not merely `enabled = false`.  Turning a
     * device back on re-acquires it with a fresh getUserMedia call.
     */
    _deviceError(err) {
        const name = err && err.name;
        const embedded = window.self !== window.top;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
            toast(embedded
                ? 'مرورگر دسترسی دوربین/میکروفون را در این پنجرهٔ توکار مسدود کرده — صفحه را در تب جدید باز کنید و اجازهٔ دسترسی بدهید.'
                : 'دسترسی دوربین/میکروفون مسدود شده — روی آیکون قفل کنار آدرس صفحه، اجازهٔ دوربین و میکروفون را فعال کنید.',
                'error', 6000);
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
            toast('دوربین یا میکروفون درخواستی پیدا نشد (شاید جدا شده باشد).', 'error');
        } else if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
            toast('دستگاه در اختیار برنامهٔ دیگری است (مثلاً یک جلسهٔ دیگر). آن برنامه را ببندید و دوباره تلاش کنید.', 'error', 6000);
        } else if (name === 'TypeError') {
            toast('مرورگر اجازهٔ دسترسی به دستگاه‌ها را نداد — صفحه باید با HTTPS یا localhost باز شود.', 'error', 6000);
        } else {
            toast(`خطای دستگاه: ${name || 'نامشخص'}`, 'error');
        }
    }

    /** Put a fresh track into the shared local stream (replacing its kind). */
    _mergeLocalTrack(track) {
        if (!this.localStream) this.localStream = new MediaStream();
        for (const old of this.localStream.getTracks()) {
            if (old.kind === track.kind) {
                this.localStream.removeTrack(old);
                if (old.readyState === 'live') old.stop();
            }
        }
        this.localStream.addTrack(track);
    }

    /** Drop a track kind from the local stream and stop the device. */
    _dropLocalTrack(kind) {
        if (!this.localStream) return;
        for (const t of this.localStream.getTracks()) {
            if (t.kind === kind) {
                this.localStream.removeTrack(t);
                t.stop();
            }
        }
        if (!this.localStream.getTracks().length) this.localStream = null;
    }

    /**
     * Sync every peer connection with the current local stream:
     * ended senders get replaceTrack (no renegotiation needed for the
     * same kind), brand-new kinds are added (triggers negotiation).
     */
    _republishLocal() {
        for (const link of this.links.values()) link.publish(this.localStream);
    }

    /** Classroom-grade audio processing — the same defaults Meet/Zoom rely on. */
    _audioConstraints(deviceId) {
        const base = {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 48000,
        };
        return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
    }

    /** Everybody we are sending to (self included). */
    _roomSize() {
        return this.links.size + 1;
    }

    /**
     * A mesh multiplies our upload by the number of peers, so the *capture*
     * has to shrink as the room grows — otherwise the third camera turns the
     * class into a slideshow.  One tier table, used by both the capture
     * constraints and the per-sender bitrate.
     */
    _qualityTier(size = this._roomSize()) {
        if (size <= 2) return { width: 1280, height: 720, fps: 30, bitrate: 1_600_000 };
        if (size <= 4) return { width: 960, height: 540, fps: 26, bitrate: 900_000 };
        if (size <= 6) return { width: 640, height: 360, fps: 22, bitrate: 520_000 };
        return { width: 480, height: 270, fps: 18, bitrate: 320_000 };
    }

    _videoConstraints(deviceId) {
        const tier = this._qualityTier();
        const base = {
            width: { ideal: tier.width },
            height: { ideal: tier.height },
            frameRate: { ideal: tier.fps, max: 30 },
            aspectRatio: { ideal: 16 / 9 },
            // Never let the browser re-frame the shot to fit a constraint:
            // `crop-and-scale` produced a slightly different crop per device,
            // so the same camera looked like two different pictures.  Scaling
            // down is still allowed (that is what the tier table is for).
            resizeMode: 'none',
        };
        return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
    }

    /**
     * Tell one peer connection how much of our upload it may use.  Browsers
     * only expose `encodings` after negotiation, so this is called again when
     * the link comes up (and whenever the room grows or shrinks).
     */
    _tuneLink(link) {
        if (!link || !link.pc) return;
        const tier = this._qualityTier();
        for (const sender of link.pc.getSenders()) {
            const track = sender.track;
            if (!track) continue;
            try {
                if (track.kind === 'video') {
                    if ('contentHint' in track) track.contentHint = 'motion';
                    const params = sender.getParameters();
                    if (!params.encodings || !params.encodings.length) continue;
                    params.encodings[0].maxBitrate = tier.bitrate;
                    params.encodings[0].maxFramerate = tier.fps;
                    params.degradationPreference = 'balanced';
                    sender.setParameters(params).catch(() => {});
                } else if (track.kind === 'audio') {
                    if ('contentHint' in track) track.contentHint = 'speech';
                    const params = sender.getParameters();
                    if (!params.encodings || !params.encodings.length) continue;
                    // Opus at ~40 kbps is transparent for speech and leaves
                    // room for everybody else's video.
                    params.encodings[0].maxBitrate = 40_000;
                    sender.setParameters(params).catch(() => {});
                }
            } catch (e) {
                // Safari/older browsers: parameters are read-only.  Capture
                // constraints still keep the stream small.
            }
        }
    }

    _retuneAll({ force = false } = {}) {
        const tier = this._qualityTier();
        // The roster re-syncs on every media toggle in the room; retuning on
        // each of those would just churn bitrate parameters, so only act when
        // the tier or the peer count really changed.
        if (!force && this._tunedTier === tier.width && this._tunedPeers === this.links.size) return;
        this._tunedTier = tier.width;
        this._tunedPeers = this.links.size;
        for (const link of this.links.values()) this._tuneLink(link);
        this._adaptCapture(tier);
    }

    /** Shrink/grow the live camera itself when the room changes size. */
    _adaptCapture(tier = this._qualityTier()) {
        const track = this.localStream && this.localStream.getVideoTracks()[0];
        if (!track || typeof track.applyConstraints !== 'function') return;
        if (this._captureTier === tier.width) return;
        this._captureTier = tier.width;
        track.applyConstraints({
            width: { ideal: tier.width },
            height: { ideal: tier.height },
            frameRate: { ideal: tier.fps, max: 30 },
        }).catch(() => { /* the camera may not support it — keep the old size */ });
    }

    async _acquire(constraints) {
        this._lastError = null;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            toast('برای دوربین/میکروفون صفحه باید با HTTPS یا localhost باز شود (روی HTTP معمولی مرورگر اجازه نمی‌دهد).', 'error', 6000);
            this._lastError = new Error('unsupported');
            return null;
        }
        try {
            return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
            // The chosen device may have vanished (unplugged / taken by another
            // app): retry once with the OS default before giving up, so a lost
            // headset never leaves the class without sound.
            if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
                const relaxed = { ...constraints };
                if (relaxed.audio && relaxed.audio.deviceId) relaxed.audio = this._audioConstraints(null);
                if (relaxed.video && relaxed.video.deviceId) relaxed.video = this._videoConstraints(null);
                if (JSON.stringify(relaxed) !== JSON.stringify(constraints)) {
                    try {
                        const stream = await navigator.mediaDevices.getUserMedia(relaxed);
                        toast('دستگاه انتخاب‌شده در دسترس نبود؛ از دستگاه پیش‌فرض استفاده شد.', 'warning');
                        return stream;
                    } catch (e) { /* report the original error below */ }
                }
            }
            this._deviceError(err);
            this._lastError = err;
            return null;
        }
    }

    async toggleMicrophone() {
        if (this._toggling.mic) return false;          // ignore rapid double taps
        if (this.permissions.can_use_microphone === false) {
            toast(this._mutedByHost
                ? 'میکروفون شما توسط مدیر بی‌صدا شده است.'
                : 'شما اجازهٔ استفاده از میکروفون را ندارید.', 'warning');
            return false;
        }
        this._toggling.mic = true;
        try {
            if (this.micOn) {
                this._stopLocalLevel();
                this._dropLocalTrack('audio');
                this.micOn = false;
                this._republishLocal();
                this._afterLocalChange();
                return true;
            }
            const stream = await this._acquire({ audio: this._audioConstraints(this._micDeviceId) });
            const track = stream && stream.getAudioTracks()[0];
            if (!track) {
                if (stream) stream.getTracks().forEach((t) => t.stop());
                // _acquire already explained *why*; don't stack a second toast.
                if (!this._lastError) toast('میکروفونی یافت نشد.', 'warning');
                return false;
            }
            this._watchLocalTrack(track, 'audio');
            this._mergeLocalTrack(track);
            this.micOn = true;
            this._republishLocal();
            this._startLocalLevel();
            this._afterLocalChange();
            return true;
        } finally {
            this._toggling.mic = false;
        }
    }

    async toggleCamera() {
        if (this._toggling.camera) return false;       // ignore rapid double taps
        if (this.permissions.can_use_camera === false) {
            toast(this._cameraOffByHost
                ? 'دوربین شما توسط مدیر غیرفعال شده است.'
                : 'شما اجازهٔ استفاده از دوربین را ندارید.', 'warning');
            return false;
        }
        this._toggling.camera = true;
        try {
            if (this.cameraOn) {
                this._dropLocalTrack('video');
                this.cameraOn = false;
                this._republishLocal();
                this._afterLocalChange();
                return true;
            }
            const stream = await this._acquire({ video: this._videoConstraints(this._camDeviceId) });
            const track = stream && stream.getVideoTracks()[0];
            if (!track) {
                if (stream) stream.getTracks().forEach((t) => t.stop());
                if (!this._lastError) toast('دوربینی یافت نشد.', 'warning');
                return false;
            }
            this._watchLocalTrack(track, 'video');
            this._mergeLocalTrack(track);
            this._captureTier = null;      // re-apply the current tier below
            this.cameraOn = true;
            this._republishLocal();
            this._retuneAll();
            this._afterLocalChange();
            return true;
        } finally {
            this._toggling.camera = false;
        }
    }

    /**
     * A device can disappear mid-class (unplugged, or claimed by another
     * app).  Without this the UI keeps claiming "mic on" while nothing is
     * being transmitted.
     */
    _watchLocalTrack(track, kind) {
        track.addEventListener('ended', () => {
            const stillOurs = Boolean(this.localStream && this.localStream.getTracks().includes(track));
            if (!stillOurs) return;            // we stopped it on purpose
            if (kind === 'audio') {
                this._stopLocalLevel();
                this._dropLocalTrack('audio');
                this.micOn = false;
            } else {
                this._dropLocalTrack('video');
                this.cameraOn = false;
            }
            this._republishLocal();
            this._afterLocalChange();
            toast(kind === 'audio'
                ? 'میکروفون قطع شد. دستگاه را وصل کنید و دوباره روی دکمهٔ میکروفون بزنید.'
                : 'دوربین قطع شد. دستگاه را وصل کنید و دوباره روی دکمهٔ دوربین بزنید.', 'warning', 5000);
        });
    }

    /** Refresh device lists and recover when the in-use device disappears. */
    _watchDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.addEventListener) return;
        this._deviceChangeBound = () => {
            if (this.onDeviceChange) this.onDeviceChange();
            // Did the device we are actively using just go away?
            const kinds = [['audio', 'mic'], ['video', 'camera']];
            for (const [kind] of kinds) {
                const track = this.localStream && this.localStream.getTracks().find((t) => t.kind === kind);
                if (track && track.readyState === 'ended') this._watchLocalTrackEnded(kind);
            }
        };
        navigator.mediaDevices.addEventListener('devicechange', this._deviceChangeBound);
    }

    _watchLocalTrackEnded(kind) {
        const track = this.localStream && this.localStream.getTracks().find((t) => t.kind === kind);
        if (track) track.dispatchEvent(new Event('ended'));
    }

    _playSafe(el) {
        if (!el) return;
        const attempt = () => {
            const p = el.play();
            if (!p || typeof p.catch !== 'function') return true;
            p.catch(() => this._armAudioUnlock(el));
            return true;
        };
        if (attempt()) return;
    }

    /**
     * Browsers refuse to start unmuted audio before the page has been touched.
     * The old code listened only for the *first* pointerdown, so a refusal that
     * arrived later (a second peer joining after the click) had no second
     * chance — the classroom looked connected and stayed silent.  This keeps
     * re-trying on every gesture and whenever the tab comes back, which is what
     * «میکروفون کار نمی‌کند» usually is.
     */
    _armAudioUnlock(el) {
        if (this._audioUnlock) return;
        const retry = () => {
            let pending = false;
            this._audioEls.forEach((audio) => {
                if (audio.paused) {
                    pending = true;
                    audio.play().catch(() => {});
                }
            });
            if (!pending) this._disarmAudioUnlock();
        };
        const onVisible = () => {
            if (document.visibilityState === 'visible') retry();
        };
        this._audioUnlock = { retry, onVisible };
        document.addEventListener('pointerdown', retry, true);
        document.addEventListener('keydown', retry, true);
        document.addEventListener('touchstart', retry, true);
        document.addEventListener('visibilitychange', onVisible);
        if (!this._audioUnlockHinted) {
            this._audioUnlockHinted = true;
            toast('برای شنیدن صدای کلاس یک بار روی صفحه ضربه بزنید.', 'info', 4000);
        }
        retry();
    }

    _disarmAudioUnlock() {
        const bound = this._audioUnlock;
        if (!bound) return;
        document.removeEventListener('pointerdown', bound.retry, true);
        document.removeEventListener('keydown', bound.retry, true);
        document.removeEventListener('touchstart', bound.retry, true);
        document.removeEventListener('visibilitychange', bound.onVisible);
        this._audioUnlock = null;
    }

    /** Re-render tile/UI/pip after any local device change. */
    _afterLocalChange() {
        if (this.localStream) this._renderLocalTile();
        else this._renderLocalTileEmpty();
        this._syncLocalUI();
        this.updatePip(this.currentView);
    }

    // ------------------------------------------------- level meters
    /**
     * One frame loop for every meter in the mesh: our own microphone (the bar
     * under the mic button + the ring) and every remote speaker's tile.
     *
     * Levels are shaped in meter.js (RMS, dB window, attack/release, a speaking
     * gate with hysteresis), and each track keeps its own tracker so a pause in
     * one voice never borrows another's decay.
     */
    _startLocalLevel() {
        this._stopLocalLevel();
        const track = this.localStream && this.localStream.getAudioTracks()[0];
        if (!track) return;
        this._localAnalyser = createAnalyser(new MediaStream([track]));
        if (!this._localAnalyser) return;
        this._localTracker = createLevelTracker(this._localAnalyser);
        this._localGate = createSpeakingGate();
        this._remoteTrackers = new Map();     // identity → { tracker, gate }
        this._stopLevelLoop = startLevelLoop((now) => this._paintLevels(now));
    }

    /** Paint our mic button and every visible remote tile (≈20 fps). */
    _paintLevels(now) {
        if (this.micOn && this._localTracker) {
            const level = this._localTracker.read();
            const speaking = this._localGate.update(level, now);
            paintMic(level, speaking);
            paintTile(this.tiles.get(this.self.identity), level, speaking);
        }
        for (const [identity, link] of this.links) {
            const stream = link.remoteStream;
            const audio = stream && stream.getAudioTracks()[0];
            const tile = this.tiles.get(identity);
            if (!audio || !audio.enabled || audio.muted || audio.readyState !== 'live') {
                this._remoteTrackers?.delete(identity);
                paintTile(tile, 0, false);
                continue;
            }
            let entry = this._remoteTrackers?.get(identity);
            if (!entry) {
                const analyser = createAnalyser(stream);
                if (!analyser) continue;
                entry = { analyser, tracker: createLevelTracker(analyser), gate: createSpeakingGate() };
                this._remoteTrackers.set(identity, entry);
            }
            const level = entry.tracker.read();
            const speaking = entry.gate.update(level, now);
            paintTile(tile, level, speaking);
        }
    }

    _stopLocalLevel() {
        if (this._stopLevelLoop) this._stopLevelLoop();
        this._stopLevelLoop = null;
        this._remoteTrackers?.forEach((entry) => disposeAnalyser(entry.analyser));
        this._remoteTrackers = null;
        disposeAnalyser(this._localAnalyser);
        this._localAnalyser = null;
        this._localTracker = null;
        this._localGate = null;
        resetMic();
        paintTile(this.tiles.get(this.self.identity), 0, false);
    }

    async toggleScreenShare() {
        if (this.permissions.can_share_screen === false) {
            toast('شما اجازهٔ اشتراک صفحه را ندارید.', 'warning');
            return false;
        }
        if (this.screenStream) {
            this.stopScreenShare();
            return true;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            toast('اشتراک صفحه در این مرورگر پشتیبانی نمی‌شود.', 'warning');
            return false;
        }
        try {
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        } catch (err) {
            if (err && err.name !== 'NotAllowedError') toast(`اشتراک صفحه ناموفق بود: ${err.name}`, 'error');
            return false;
        }
        this.screenStream.getVideoTracks()[0].addEventListener('ended', () => this.stopScreenShare());
        this._showLocalScreen();
        for (const link of this.links.values()) this._attachScreenTo(link);
        this._syncLocalUI();
        this.onStateChange({ mic_on: this.micOn, camera_on: this.cameraOn, screen_sharing: true });
        return true;
    }

    _attachScreenTo(link) {
        const pc = link._ensureScreenPc();
        const existing = pc.getSenders().map((s) => s.track).filter(Boolean);
        for (const track of this.screenStream.getTracks()) {
            if (!existing.includes(track)) pc.addTrack(track, this.screenStream);
        }
    }

    stopScreenShare() {
        if (!this.screenStream) return;
        this.screenStream.getTracks().forEach((t) => t.stop());
        this.screenStream = null;
        for (const link of this.links.values()) {
            if (link.screenPc) {
                link.screenPc.getSenders().forEach((s) => { try { s.track && s.track.stop(); } catch (e) { /* noop */ } });
                try { link.screenPc.close(); } catch (e) { /* noop */ }
                link.screenPc = null;
            }
        }
        this._hideScreenView();
        this._syncLocalUI();
        this.onStateChange({ mic_on: this.micOn, camera_on: this.cameraOn, screen_sharing: false });
    }

    async forceMute() {
        // host revoked the mic — release the device completely
        this._stopLocalLevel();
        this._dropLocalTrack('audio');
        this.micOn = false;
        this._republishLocal();
        this._afterLocalChange();
    }

    async forceCameraOff() {
        this._dropLocalTrack('video');
        this.cameraOn = false;
        this._republishLocal();
        this._afterLocalChange();
    }

    /** Host moderation reached us: cut the device AND revoke the local right
     *  to switch it back on, otherwise the button silently lies. */
    applyModerationState({ muted, camera_disabled } = {}) {
        this._mutedByHost = Boolean(muted);
        this._cameraOffByHost = Boolean(camera_disabled);
        if (muted) this.forceMute();
        if (camera_disabled) this.forceCameraOff();
        this.permissions.can_use_microphone = !muted && this.permissions.can_use_microphone !== false;
        this.permissions.can_use_camera = !camera_disabled && this.permissions.can_use_camera !== false;
        this._syncLocalUI();
    }

    /** Remember the choice; return whether it is actually in use right now. */
    async setMicDevice(deviceId) {
        if (!deviceId) return false;
        this._micDeviceId = deviceId; // remembered for the next acquisition
        if (!this.micOn || !this.localStream) return true;   // used next time
        const fresh = await this._acquire({ audio: this._audioConstraints(deviceId) });
        const newTrack = fresh && fresh.getAudioTracks()[0];
        if (!newTrack) return false;
        for (const pc of this._allPcs()) {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
            if (sender) { try { await sender.replaceTrack(newTrack); } catch (e) { /* noop */ } }
        }
        this._watchLocalTrack(newTrack, 'audio');
        this._mergeLocalTrack(newTrack);
        this._startLocalLevel(); // re-point the meter at the new track
        this._syncLocalUI();
        return true;
    }

    async setCameraDevice(deviceId) {
        if (!deviceId) return false;
        this._camDeviceId = deviceId;
        if (!this.cameraOn || !this.localStream) return true;   // used next time
        const fresh = await this._acquire({ video: this._videoConstraints(deviceId) });
        const newTrack = fresh && fresh.getVideoTracks()[0];
        if (!newTrack) return false;
        for (const pc of this._allPcs()) {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (sender) { try { await sender.replaceTrack(newTrack); } catch (e) { /* noop */ } }
        }
        this._watchLocalTrack(newTrack, 'video');
        this._mergeLocalTrack(newTrack);
        this._renderLocalTile();
        this.updatePip(this.currentView);
        return true;
    }

    async setOutputDevice(deviceId) {
        if (!deviceId) return false;
        const supported = typeof HTMLAudioElement !== 'undefined' && 'setSinkId' in HTMLAudioElement.prototype;
        if (!supported) return false;
        // Remember it: peers who join later get the choice applied too —
        // otherwise picking a speaker before anyone speaks does nothing.
        this._sinkId = deviceId;
        await this._applySinkId();
        return true;
    }

    async _applySinkId(el) {
        if (!this._sinkId) return;
        const targets = el ? [el] : [...this._audioEls.values(), document.querySelector('#screen-holder video')];
        for (const t of targets) {
            if (t && t.setSinkId) { try { await t.setSinkId(this._sinkId); } catch (e) { /* unsupported */ } }
        }
    }

    async listDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
        return navigator.mediaDevices.enumerateDevices();
    }

    _allPcs() {
        const pcs = [];
        for (const link of this.links.values()) {
            pcs.push(link.pc);
            if (link.screenPc) pcs.push(link.screenPc);
        }
        return pcs;
    }

    // ------------------------------------------------------------ remote
    handleSignal(msg) {
        // {type:'rtc_signal', from_identity, from_member_id, data}
        const link = this.links.get(msg.from_identity);
        if (!link) {
            // Roster sync may lag behind the first offer — buffer briefly and
            // replay once syncPeers creates the link (perfect negotiation
            // cannot recover otherwise: the polite side never re-offers).
            const buf = this._pendingSignals || (this._pendingSignals = []);
            if (buf.length < 100) buf.push(msg);
            return;
        }
        link.handleSignal(msg.data).catch((err) => console.warn('[mesh] signal error:', err));
    }

    _replayPending(identity) {
        if (!this._pendingSignals) return;
        const link = this.links.get(identity);
        if (!link) return;
        const keep = [];
        for (const msg of this._pendingSignals) {
            if (msg.from_identity === identity) {
                link.handleSignal(msg.data).catch((err) => console.warn('[mesh] signal error:', err));
            } else {
                keep.push(msg);
            }
        }
        this._pendingSignals = keep;
    }

    _applyPeerPermissions(link) {
        if (!link?.peer) return;
        const permissions = link.peer.permissions || {};
        // To *our* client every incoming track is simply whatever that peer is
        // sending.  This used to set `track.enabled` from a roster flag, which
        // meant a late/duplicated presence update cut the sound for a moment —
        // «صدا می‌آید، بعد نمی‌آید».  Silence is announced by the sender (the
        // track mutes itself); the roster only drives the icons below.

        const screenTrack = link.remoteScreenStream?.getVideoTracks()[0];
        const screenAllowed = permissions.can_share_screen !== false
            && link.peer.screen_sharing !== false
            && screenTrack?.readyState === 'live';
        if (screenTrack) screenTrack.enabled = screenAllowed;
        if (!screenAllowed) {
            if (link._screenAttached && this._screenOwner === link.peer.identity) this._hideScreenView();
            link._screenAttached = false;
        } else if (!link._screenAttached) {
            this._onRemoteScreen(link.peer, link.remoteScreenStream);
            link._screenAttached = true;
        }
        if (link.remoteStream) this._refreshRemoteTile(link.peer.identity);
    }

    _onRemoteMedia(peer, stream) {
        const link = this.links.get(peer.identity);
        if (link) this._applyPeerPermissions(link);
        let audio = this._audioEls.get(peer.identity);
        if (!audio) {
            audio = document.createElement('audio');
            audio.autoplay = true;
            audio.playsInline = true;
            audio.setAttribute('playsinline', '');
            // Never muted: this element *is* the only place remote sound is
            // played (the tile <video> is muted on purpose).
            audio.muted = false;
            audio.volume = 1;
            audio.dataset.identity = peer.identity;
            document.body.appendChild(audio);
            this._audioEls.set(peer.identity, audio);
        }
        this._applySinkId(audio);
        audio.srcObject = stream;
        this._playSafe(audio);
        const tile = this._ensureTile(peer);
        const video = tile.querySelector('video');
        const camTrack = stream.getVideoTracks()[0];
        if (camTrack) {
            video.srcObject = stream;
            // bind mute/unmute/ended exactly once per track (renegotiation
            // re-fires ontrack for the same track object)
            const bound = this._trackBound || (this._trackBound = new WeakSet());
            if (!bound.has(camTrack)) {
                bound.add(camTrack);
                camTrack.addEventListener('mute', () => this._refreshRemoteTile(peer.identity));
                camTrack.addEventListener('unmute', () => this._refreshRemoteTile(peer.identity));
                camTrack.addEventListener('ended', () => this._refreshRemoteTile(peer.identity));
            }
        }
        this._refreshRemoteTile(peer.identity);
        this._layout();
    }

    _onRemoteScreen(peer, stream) {
        const screenTrack = stream?.getVideoTracks()[0];
        if (!screenTrack || screenTrack.readyState !== 'live') return;
        const holder = document.getElementById('screen-holder');
        const owner = document.getElementById('screen-owner');
        holder.innerHTML = '';
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'contain';
        holder.appendChild(video);
        this._screenVideo = video;
        this._screenOwner = peer.identity;
        owner.textContent = `${peer.name || peer.identity} صفحهٔ خود را به اشتراک گذاشته است`;
        screenTrack.addEventListener('ended', () => {
            const link = this.links.get(peer.identity);
            if (link) link._screenAttached = false;
            if (this._screenOwner === peer.identity) this._hideScreenView();
        }, { once: true });
        document.querySelector('.room-controls')?.classList.add('screen-active');
        window.__switchView('screen');
    }

    _showLocalScreen() {
        const holder = document.getElementById('screen-holder');
        const owner = document.getElementById('screen-owner');
        holder.innerHTML = '';
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.srcObject = this.screenStream;
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'contain';
        holder.appendChild(video);
        this._screenVideo = video;
        owner.textContent = 'شما صفحهٔ خود را به اشتراک گذاشته‌اید';
        document.querySelector('.room-controls')?.classList.add('screen-active');
        window.__switchView('screen');
    }

    _hideScreenView() {
        const holder = document.getElementById('screen-holder');
        holder.innerHTML = '';
        this._screenVideo = null;
        this._screenOwner = null;
        document.querySelector('.room-controls')?.classList.remove('screen-active');
        const screenView = document.getElementById('view-screen');
        if (screenView && !screenView.classList.contains('hidden')) window.__switchView('media');
    }

    // ------------------------------------------------------------ tiles
    _ensureTile(peer) {
        if (this.tiles.has(peer.identity)) return this.tiles.get(peer.identity);
        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.dataset.identity = peer.identity;
        if (peer.identity === this.self.identity) tile.dataset.self = '1';
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        // Sound is rendered by the per-peer <audio> element (which is also the
        // one an output-device change re-routes).  A second, unmuted copy of
        // the same track here would double every voice.
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.autoplay = true;
        const overlay = document.createElement('div');
        overlay.className = 'tile-overlay';
        overlay.innerHTML = '<span class="tile-name"></span><span class="tile-icons"><span class="tile-net" data-quality="unknown" hidden></span><i class="t-mic" title="میکروفون"><svg class="ic"><use href="#i-mic"/></svg></i></span>'
            + '<button type="button" class="tile-fs" title="نمایش تمام‌صفحه" aria-label="نمایش تمام‌صفحه"><svg class="ic"><use href="#i-maximize"/></svg></button>';
        overlay.querySelector('.tile-fs')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const v = tile.querySelector('video');
            const t = v && v.readyState > 0 ? v : tile;
            if (document.fullscreenElement) document.exitFullscreen?.();
            else t.requestFullscreen?.().catch(() => {});
        });
        const placeholder = document.createElement('div');
        placeholder.className = 'tile-placeholder';
        // The initial lives in its own span so CSS can draw the avatar disc
        // behind it (an absolutely-positioned ::before would paint on top).
        placeholder.innerHTML = '<span class="tile-initial"></span>';
        placeholder.querySelector('.tile-initial').textContent = (peer.name || '?').charAt(0);
        const speaking = document.createElement('span');
        speaking.className = 'tile-speaking';
        speaking.textContent = 'در حال صحبت';
        speaking.setAttribute('role', 'status');
        speaking.setAttribute('aria-label', 'در حال صحبت');
        speaking.setAttribute('aria-hidden', 'true');
        // Three soft bars instead of a green strip along the bottom edge.
        const level = document.createElement('span');
        level.className = 'tile-level';
        level.setAttribute('aria-hidden', 'true');
        level.innerHTML = '<i></i><i></i><i></i>';
        tile.append(video, placeholder, overlay, speaking, level);
        overlay.querySelector('.tile-name').textContent = peer.name || peer.identity;
        this.tiles.set(peer.identity, tile);
        this.tilesEl.appendChild(tile);
        this._layout();
        return tile;
    }

    _renderLocalTile() {
        const me = { identity: this.self.identity, name: this.self.name };
        const tile = this._ensureTile(me);
        const video = tile.querySelector('video');
        video.muted = true;
        video.srcObject = this.localStream;
        const camTrack = this.localStream && this.localStream.getVideoTracks()[0];
        const camLive = Boolean(camTrack && camTrack.readyState === 'live');
        // Class, not `display`: the CSS fades the picture out so turning a
        // camera off no longer makes the whole stage flicker.
        tile.classList.toggle('cam-off', !camLive);
        tile.querySelector('.tile-placeholder').classList.toggle('hidden', camLive);
        tile.classList.toggle('is-idle', !camLive && !this.micOn);
        tile.querySelector('.tile-name').textContent = `${this.self.name} (شما)`;
        if (camLive) video.play().catch(() => {});
        this._syncLocalUI();
        this._layout();
    }

    /** Local stream fully gone (mic+camera off): show the placeholder. */
    _renderLocalTileEmpty() {
        const tile = this.tiles.get(this.self.identity);
        if (!tile) return;
        const video = tile.querySelector('video');
        video.srcObject = null;
        tile.classList.add('cam-off');
        tile.querySelector('.tile-placeholder').classList.remove('hidden');
        tile.classList.add('is-idle');
        this._layout();
    }

    _refreshRemoteTile(identity) {
        const link = this.links.get(identity);
        const tile = this.tiles.get(identity);
        if (!link || !tile) return;
        const stream = link.remoteStream;
        // For REMOTE tracks `enabled` stays true even when the sender turns
        // the device off — the receiver only learns via `muted` (the track
        // goes silent/stale).  Using `enabled` here left frozen frames on
        // screen and mic icons stuck "on"; `muted` is the real signal.
        const permissions = link.peer.permissions || {};
        const videoTrack = stream && stream.getVideoTracks()[0];
        const camLive = Boolean(
            permissions.can_use_camera !== false
            && link.peer.camera_disabled !== true
            && videoTrack && !videoTrack.muted && videoTrack.readyState === 'live'
        );
        const video = tile.querySelector('video');
        if (camLive && video.srcObject !== stream) video.srcObject = stream;
        tile.classList.toggle('cam-off', !camLive);
        tile.querySelector('.tile-placeholder').classList.toggle('hidden', camLive);
        if (camLive) video.play().catch(() => {});
        const audioTrack = stream && stream.getAudioTracks()[0];
        const micLive = Boolean(
            permissions.can_use_microphone !== false
            && link.peer.muted !== true
            && audioTrack && !audioTrack.muted && audioTrack.readyState === 'live'
        );
        tile.querySelector('.t-mic').classList.toggle('off', !micLive);
        // Same rule as the local tile: no camera and no microphone means the
        // person is not contributing picture or sound, so the stage skips them
        // (a screen share keeps the tile, since it *is* the picture).
        tile.classList.toggle('is-idle', !camLive && !micLive && !link.peer.screen_sharing);
        this._layout();
    }

    setLayout(mode) {
        if (!['grid', 'speaker', 'focus', 'presentation'].includes(mode)) return;
        this.layout = mode;
        try { localStorage.setItem(`room_layout_${this.roomCode}`, mode); } catch (e) { /* noop */ }
        this._layout();
    }

    /** Off-stage for anyone the roster reports without mic and without camera. */
    syncStagePresence(peers) {
        const live = new Map((peers || []).map(
            (p) => [p.identity, Boolean(p.mic_on) || Boolean(p.camera_on)]));
        let touched = false;
        this.tiles.forEach((tile, identity) => {
            if (this.self && identity === this.self.identity) return; // local truth is exact
            const on = live.get(identity);
            if (on === undefined) return;
            const idle = !on;
            if (tile.classList.contains('is-idle') !== idle) touched = true;
            tile.classList.toggle('is-idle', idle);
        });
        if (touched) this._layout();
    }

    _layout() {
        // Idle participants (no mic, no camera) stay out of the grid — see
        // _refreshRemoteTile. Only what is on screen shapes the grid.
        const shown = [];
        this.tiles.forEach((tile, identity) => {
            if (!tile.classList.contains('is-idle')) shown.push(identity);
        });
        const count = shown.length;
        this.tilesEl.dataset.count = String(Math.max(count, 1));
        this.tilesEl.dataset.layout = this.layout;
        let focus = null;
        if (this.layout !== 'grid') focus = this.activeSpeaker;
        if (focus && !shown.includes(focus)) focus = null;
        this.tilesEl.classList.toggle('has-focus', Boolean(focus));
        this.tiles.forEach((tile, identity) => {
            const onStage = shown.includes(identity);
            tile.classList.toggle('focus', onStage && identity === focus);
            tile.classList.toggle('mini', onStage && Boolean(focus) && identity !== focus);
            // Focus adjusts tile sizes but must not hide a live camera.
        });
        this.emptyEl.classList.toggle('hidden', count > 0);
        this._emptyReason(count);
    }

    /** Explain an empty stage instead of leaving the join placeholder up. */
    _emptyReason(count) {
        if (count > 0 || !this.emptyEl) return;
        const el = document.getElementById('stage-empty-text');
        if (!el) return;
        if (this.tiles.size > 0) {
            el.textContent = 'فعلاً کسی دوربین یا میکروفون روشن نکرده است.';
            this.emptyEl.dataset.reason = 'idle';
        }
    }

    // ------------------------------------------------- speaker + quality
    /**
     * Who should own the big tile?
     *
     * Swapping focus on every 700 ms tick made the stage «jump» all the time:
     * two people breathing alternately were enough.  A challenger now has to
     * lead for two consecutive ticks *and* be clearly louder than the current
     * speaker, and a silent speaker is only replaced after the same grace.
     */
    _pickFocus(levels, current) {
        const GATE = 0.02;
        const MARGIN = 1.35;
        let best = null;
        let bestLevel = GATE;
        for (const [identity, level] of levels) {
            if (level > bestLevel) { bestLevel = level; best = identity; }
        }
        if (!best) return null;
        if (!current || current === best) { this._focusLead = 0; return best; }
        const currentLevel = levels.get(current) || 0;
        if (bestLevel < currentLevel * MARGIN) { this._focusLead = 0; return current; }
        this._focusLead = (this._focusLead || 0) + 1;
        if (this._focusLead < 2) return current;
        this._focusLead = 0;
        return best;
    }

    _evaluateSpeaker() {
        // Read real signal levels from each remote stream. Every participant
        // above the noise gate gets a visible speaking badge; the loudest is
        // still used as the focus/PiP speaker.
        const measured = new Map();
        for (const [identity, link] of this.links) {
            const stream = link.remoteStream;
            const tile = this.tiles.get(identity);
            const audioTrack = stream && stream.getAudioTracks()[0];
            if (!audioTrack || audioTrack.muted || audioTrack.readyState !== 'live') {
                continue;
            }
            let analyser = this.levels.get(identity);
            if (!analyser) {
                analyser = createAnalyser(stream);
                if (!analyser) continue;
                this.levels.set(identity, analyser);
            }
            // Painting (levels, ring, badge) belongs to the 20 fps level loop;
            // this slower scan only picks who to focus / mirror in the PiP.
            measured.set(identity, analyserLevel(analyser));
        }
        const best = this._pickFocus(measured, this.activeSpeaker);
        if (best !== this.activeSpeaker) {
            this.activeSpeaker = best;
            this._layout();
            this.updatePip(this.currentView); // pip follows the speaker
        }
    }

    // ------------------------------------------------- picture-in-picture
    /**
     * Small floating camera for the full-stage views (whiteboard,
     * presentation, screen share) so nobody disappears while the board
     * is in use.  Shows OUR camera when it is on; otherwise the active
     * remote speaker's camera when there is one.
     */
    updatePip(view) {
        if (view) this.currentView = view;
        const pip = document.getElementById('cam-pip');
        const vid = document.getElementById('cam-pip-video');
        const label = document.getElementById('cam-pip-label');
        if (!pip || !vid) return;
        const pipViews = ['whiteboard', 'presentation', 'screen'];
        if (!pipViews.includes(this.currentView)) {
            pip.classList.add('hidden');
            vid.srcObject = null;
            return;
        }
        let stream = null;
        let name = '';
        const camTrack = this.localStream
            && this.localStream.getVideoTracks().find((t) => t.readyState === 'live');
        if (this.cameraOn && camTrack) {
            stream = this.localStream;
            name = `${this.self.name} (شما)`;
        } else {
            const link = this.activeSpeaker && this.links.get(this.activeSpeaker);
            const rs = link && link.remoteStream;
            // skip muted/stale tracks — a frozen frame is worse than no PiP
            const rt = rs && rs.getVideoTracks().find((t) => t.readyState === 'live' && !t.muted);
            if (rt) {
                stream = rs;
                name = (link.peer && link.peer.name) || '';
            }
        }
        // Always silent: the tile's <audio> element already plays every remote
        // voice, and our own mic must never be echoed back to us.
        vid.muted = true;
        pip.classList.toggle('is-local', Boolean(stream && stream === this.localStream));
        if (!stream) {
            pip.classList.add('hidden');
            vid.srcObject = null;
            return;
        }
        if (vid.srcObject !== stream) vid.srcObject = stream;
        if (label) label.textContent = name;
        pip.classList.remove('hidden');
        this._playSafe(vid);
    }

    async _evaluateQuality() {
        // worst peer link quality from REAL RTCStatsReport values
        if (!this.links.size) return;
        let worst = 'excellent';
        for (const link of this.links.values()) {
            try {
                const stats = await link.pc.getStats();
                let lost = 0, received = 0, rtt = null;
                stats.forEach((report) => {
                    if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.kind === 'video')) {
                        lost += report.packetsLost || 0;
                        received += report.packetsReceived || 0;
                    }
                    if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
                        rtt = report.currentRoundTripTime;
                    }
                });
                let q = 'excellent';
                if (received > 50 && lost / (received + lost) > 0.05) q = 'poor';
                else if (received > 50 && lost / (received + lost) > 0.015) q = 'good';
                if (rtt !== null) {
                    if (rtt > 0.4) q = 'poor';
                    else if (rtt > 0.15 && q === 'excellent') q = 'good';
                }
                if (q === 'poor' || (q === 'good' && worst === 'excellent')) worst = q;
            } catch (e) { /* stats unsupported */ }
        }
        if (worst !== this.quality) {
            this.quality = worst;
            this.onQualityChange(worst, null);
        }
    }

    // ------------------------------------------------------- network stats
    /**
     * One pass over every peer connection: what each link is really carrying.
     *
     * The numbers describe *what we receive* from each person, so they cannot be
     * gamed by anything the other side claims — a weak upload shows up as loss,
     * jitter and a frozen picture on our side of the wire.
     */
    async _sampleNet() {
        if (!this.links.size) {
            if (this.netStats.size) {
                this.netStats.clear();
                this.onNetStats({ self: null, peers: [] });
            }
            return;
        }
        const rows = [];
        for (const [identity, link] of this.links) {
            try {
                const report = await link.pc.getStats();
                const metrics = link.sampler.update(report, Date.now());
                const quality = link.sampler.settle(metrics);
                const row = {
                    identity,
                    name: link.peer.name || identity,
                    memberId: link.peer.member_id,
                    quality,
                    ...metrics,
                };
                link.net = row;
                this.netStats.set(identity, row);
                rows.push(row);
            } catch (err) {
                /* getStats is not available everywhere; the badge stays empty */
            }
        }
        this.ownStats = combineOwnership(rows);
        this._paintNetBadges();
        this.onNetStats({ self: this.ownStats, peers: rows });
    }

    _paintNetBadges() {
        const labels = { poor: 'ضعیف', fair: 'متوسط', good: 'خوب', unknown: '—' };
        for (const [identity, tile] of this.tiles) {
            const badge = tile.querySelector('.tile-net');
            if (!badge) continue;
            const row = this.netStats.get(identity);
            if (!row || row.quality === 'unknown' || identity === this.self.identity) {
                badge.hidden = true;
                badge.dataset.quality = 'unknown';
                continue;
            }
            badge.hidden = false;
            badge.dataset.quality = row.quality;
            badge.textContent = labels[row.quality] || '';
            const bits = [];
            if (row.inKbps) bits.push(`دریافت ${formatRate(row.inKbps)}`);
            if (row.outKbps) bits.push(`ارسال ${formatRate(row.outKbps)}`);
            if (row.rttMs != null) bits.push(`تأخیر ${Math.round(row.rttMs)}ms`);
            if (row.lossPct != null) bits.push(`افت بسته ${row.lossPct.toFixed(1)}%`);
            if (row.path) bits.push(row.path === 'relay' ? 'مسیر: رله' : 'مسیر: مستقیم');
            badge.title = bits.join(' · ');
        }
    }

    _syncLocalUI() {
        const micBtn = document.getElementById('btn-mic');
        const camBtn = document.getElementById('btn-camera');
        const screenBtn = document.getElementById('btn-screen');
        if (micBtn) {
            micBtn.classList.toggle('active', this.micOn);
            micBtn.classList.toggle('off', this.permissions.can_use_microphone === false);
            micBtn.setAttribute('aria-pressed', String(this.micOn));
        }
        if (camBtn) {
            camBtn.classList.toggle('active', this.cameraOn);
            camBtn.setAttribute('aria-pressed', String(this.cameraOn));
        }
        if (screenBtn) {
            screenBtn.classList.toggle('active', Boolean(this.screenStream));
            screenBtn.classList.toggle('off', this.permissions.can_share_screen === false);
        }
        // local tile mic icon
        const myTile = this.tiles.get(this.self.identity);
        if (myTile) {
            myTile.querySelector('.t-mic')?.classList.toggle('off', !this.micOn);
            const camTrack = this.localStream && this.localStream.getVideoTracks()[0];
            const camLive = Boolean(camTrack && camTrack.readyState === 'live');
            myTile.classList.toggle('is-idle', !camLive && !this.micOn);
            this._layout();
        }
        this.onStateChange({ mic_on: this.micOn, camera_on: this.cameraOn, screen_sharing: Boolean(this.screenStream) });
    }

    _signal(toMemberId, data) {
        this.signal({ action: 'rtc_signal', to_member_id: toMemberId, data });
    }

    /** Release everything: devices, timers, listeners, peer connections. */
    dispose() {
        if (this._statsTimer) clearInterval(this._statsTimer);
        if (this._speakerTimer) clearInterval(this._speakerTimer);
        if (this._netTimer) clearInterval(this._netTimer);
        this._statsTimer = this._speakerTimer = this._netTimer = null;
        this._disarmAudioUnlock();
        if (this._deviceChangeBound && navigator.mediaDevices?.removeEventListener) {
            navigator.mediaDevices.removeEventListener('devicechange', this._deviceChangeBound);
            this._deviceChangeBound = null;
        }
        this._stopLocalLevel();
        if (this.localStream) {
            this.localStream.getTracks().forEach((t) => t.stop());
            this.localStream = null;
        }
        if (this.screenStream) this.stopScreenShare();
        for (const identity of Array.from(this.links.keys())) this._removePeer(identity);
    }
}

export { MeshMedia };
