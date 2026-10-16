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
import {
    QUALITY, audioPlanFor, planFor, qualityOf, transportAdvice, worstQuality,
} from './net/policy.js';
import { analyserLevel, createAnalyser, disposeAnalyser } from './meter.js';

// Deployment-configurable (WEBRTC_ICE_SERVERS → data-ice-servers on the
// room root → Media.init).  Default is public Google STUN, which has no
// TURN relay — strict NATs need a coturn entry to connect reliably.
const DEFAULT_ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
let ICE_SERVERS = DEFAULT_ICE_SERVERS;

// Must match `RTC_SIGNAL_MAX_BYTES` in classrooms/consumers.py: sending an
// envelope the server will refuse only wastes the renegotiation that a camera
// needs, so it is caught client-side and explained to the user instead.
const SIGNAL_MAX_BYTES = 96 * 1024;

// How long we give a peer link to come up before declaring it unreachable,
// and how patient we are with a transient network drop before restarting ICE.
const CONNECT_TIMEOUT_MS = 10000;
// An offer that is still unanswered after this long is re-sent (a relayed
// envelope can be lost: the room socket may have dropped between the hops).
const OFFER_RESEND_MS = 6000;
const OFFER_RESEND_MAX = 3;
const DISCONNECT_GRACE_MS = 3000;
// How long a rebuilt/recovered link is left alone before we touch it again.
const REBUILD_COOLDOWN_MS = 10000;

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
        this.poorStreak = 0;
        this.disconnectedAt = null;
        this.iceRestarted = false;
        this.lastStats = null;
        this.mesh = mesh;
        this.peer = peer;                      // {identity, member_id, name}
        this.polite = mesh.self.memberId < peer.member_id;
        this.makingOffer = false;
        this.ignoreOffer = false;
        this.screenPc = null;                  // created on demand
        // One MediaStream per peer that we add every received track to.  It is
        // never replaced: the <audio> element and the tile's <video> both point
        // at it, so a camera appearing (or a screen ending) can never steal the
        // other player's source.
        this.remoteStream = null;
        this.remoteScreenStream = null;
        this.failed = false;                   // gave up — shown in the UI
        this.retried = false;                  // one automatic ICE restart
        this._watchdog = null;
        this._recovery = null;
        // signalling bookkeeping — the numbers `diag()` reports and the
        // "did this ever arrive?" debugging that used to be guesswork
        this._candidatesQueued = 0;            // arrived before any remote SDP
        this._candidatesSent = 0;
        this._candidatesReceived = 0;
        this._candidatesFailed = 0;
        this._offersSent = 0;
        this._offersAnswered = 0;
        this._negotiationDeferred = false;     // need an offer once we are stable
        this._negotiating = false;
        this._lastNegotiationAt = 0;
        this._lastSignalAt = 0;
        this._lastError = null;
        this.pc = this._makePc(false);
    }

    updatePeer(peer) {
        this.peer = { ...this.peer, ...peer };
        this.mesh._applyPeerPermissions(this);
    }

    /** This peer's stable media stream (created on first received track). */
    _streamFor(isScreen) {
        const key = isScreen ? 'remoteScreenStream' : 'remoteStream';
        if (!this[key]) this[key] = new MediaStream();
        return this[key];
    }

    _makePc(isScreen) {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this._candidatesSent += 1;
                this.mesh._signal(this.peer.member_id, { ice: e.candidate, screen: isScreen });
            }
        };
        pc.ontrack = (e) => {
            // A track can arrive in a stream we already know (the sender added a
            // second kind to the same MediaStream) or in a brand-new one after
            // the sender re-acquired its local stream.  Either way every track
            // lands in OUR stream for this peer, so nothing is ever replaced.
            const stream = this._streamFor(isScreen);
            this.mesh._attachRemoteTrack(this, e.track, isScreen, e.streams && e.streams[0]);
            if (isScreen) {
                this.mesh._applyPeerPermissions(this);
            } else {
                this.mesh._onRemoteMedia(this.peer, stream);
            }
        };
        pc.onnegotiationneeded = () => { this.negotiate(isScreen); };
        pc.oniceconnectionstatechange = () => { if (!isScreen) this._onConnectState(pc); };
        pc.onconnectionstatechange = () => {
            if (isScreen) return;
            // A closed PC is gone for good; a failed one may still recover
            // (network change, ICE restart) so it goes through _recover().
            if (pc.connectionState === 'closed') {
                this.mesh._onPeerGone(this.peer.identity);
                return;
            }
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
        if (this.failed) {
            this.failed = false;
            this.mesh._onPeerRecovered(this.peer);
        }
    }

    _onConnectState(pc) {
        if (this._isUp(pc)) {
            this.disconnectedAt = null;
            this.iceRestarted = false;
            this.poorStreak = 0;
            this._settle();
            return;
        }
        if (pc.connectionState === 'failed') { this._recover(); return; }
        if (pc.connectionState === 'disconnected') {
            if (!this.disconnectedAt) this.disconnectedAt = Date.now();
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
            // `restartIce()` normally fires negotiationneeded; when it does not
            // (nothing else to negotiate) the offer has to be made here or the
            // restart never reaches the peer.
            if (this.pc.signalingState === 'stable') this.negotiate(false);
            return;
        }
        clearTimeout(this._watchdog); this._watchdog = null;
        clearTimeout(this._recovery); this._recovery = null;
        if (this.failed) return;
        this.failed = true;
        this.mesh._onPeerFailed(this.peer);
    }

    /** User pressed "try again" on the failed tile. */
    retryNow() {
        this.failed = false;
        this.retried = false;
        this._recover();
    }

    /**
     * Create and send an offer for one of our connections.
     *
     * `onnegotiationneeded` covers most cases, but not all of them: after the
     * polite side rolls its own offer back to accept the peer's, the browser
     * does not always fire it again — and that is exactly how a camera that was
     * switched on mid-class ends up never being negotiated.  So every path that
     * changes our tracks calls this, and it defers until the connection is
     * stable again.
     */
    async negotiate(isScreen = false) {
        const pc = isScreen ? this.screenPc : this.pc;
        if (!pc || pc.connectionState === 'closed') return false;
        if (this._negotiating || pc.signalingState !== 'stable') {
            if (!isScreen) this._negotiationDeferred = true;
            return false;
        }
        this._negotiating = true;
        this.makingOffer = true;                  // perfect-negotiation flag
        try {
            await pc.setLocalDescription(await pc.createOffer());
            if (pc.connectionState === 'closed') return false;
            this._offersSent += 1;
            this._lastNegotiationAt = Date.now();
            this.mesh._signal(this.peer.member_id, { sdp: pc.localDescription, screen: isScreen });
            if (!isScreen) this.armWatchdog();
            return true;
        } catch (err) {
            this._lastError = String((err && err.message) || err);
            console.warn('[mesh] negotiation failed:', err);
            return false;
        } finally {
            this._negotiating = false;
            this.makingOffer = false;
        }
    }

    /** Our tracks changed while we could not offer: offer now that we can. */
    _flushDeferredNegotiation() {
        if (!this._negotiationDeferred) return;
        if (this.pc.signalingState !== 'stable') return;
        this._negotiationDeferred = false;
        this.negotiate(false);
    }

    /**
     * A description arrived.  Applying it needs care in two places:
     *
     * * a remote offer can collide with our own — the impolite side ignores it
     *   (the polite side rolls back and answers), and after a rollback we must
     *   re-offer ourselves or our own new track (a camera!) is never sent;
     * * any ICE candidate that arrived *before* this description was rejected
     *   by the browser (`InvalidStateError`) — it is queued here and replayed
     *   the moment the remote description exists, instead of being lost.
     */
    async handleSignal(data) {
        const isScreen = Boolean(data.screen);
        const pc = isScreen ? this._ensureScreenPc() : this.pc;
        this._lastSignalAt = Date.now();
        if (data.sdp) {
            const description = data.sdp;
            const offerCollision =
                description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
            this.ignoreOffer = !this.polite && offerCollision;
            if (this.ignoreOffer) {
                // The polite peer will roll back and answer us.  Keep their
                // offer though: if our own offer never gets answered (a lost
                // envelope), this is the only way back to a negotiated link.
                this._ignoredOffer = { description, isScreen };
                return;
            }
            if (offerCollision && description.type === 'offer') {
                // We are polite and we had an offer in flight: applying this one
                // rolls ours back, so our own new tracks need a fresh offer.
                this._negotiationDeferred = true;
            }
            try {
                await pc.setRemoteDescription(description);
            } catch (err) {
                this._lastError = String((err && err.message) || err);
                console.warn('[mesh] setRemoteDescription failed:', err);
                this._negotiationDeferred = true;
                return;
            }
            await this._flushPendingCandidates(pc);
            this._offerResends = 0;
            this._ignoredOffer = null;
            if (!isScreen) this.armWatchdog();
            if (description.type === 'offer') {
                try {
                    await pc.setLocalDescription(await pc.createAnswer());
                } catch (err) {
                    this._lastError = String((err && err.message) || err);
                    console.warn('[mesh] creating an answer failed:', err);
                    return;
                }
                this._offersAnswered += 1;
                this.mesh._signal(this.peer.member_id, { sdp: pc.localDescription, screen: isScreen });
            }
            if (!isScreen) this._flushDeferredNegotiation();
        } else if (data.ice) {
            this._candidatesReceived += 1;
            await this._addCandidate(pc, data.ice);
        }
    }

    /** `addIceCandidate`, with the "no remote description yet" hole plugged. */
    async _addCandidate(pc, candidate) {
        if (!candidate) return;
        if (!pc.remoteDescription) {
            this._candidatesQueued += 1;
            this._pendingCandidates || (this._pendingCandidates = {});
            const key = pc === this.screenPc ? 'screen' : 'media';
            (this._pendingCandidates[key] || (this._pendingCandidates[key] = [])).push(candidate);
            return;
        }
        try {
            await pc.addIceCandidate(candidate);
        } catch (err) {
            this._candidatesFailed += 1;
            this._lastError = String((err && err.message) || err);
            if (!this.ignoreOffer) console.warn('[mesh] bad ICE candidate:', err);
        }
    }

    /** Replay the candidates that arrived too early (never drop signalling). */
    async _flushPendingCandidates(pc) {
        const key = pc === this.screenPc ? 'screen' : 'media';
        const queued = this._pendingCandidates && this._pendingCandidates[key];
        if (!queued || !queued.length) return;
        this._pendingCandidates[key] = [];
        for (const candidate of queued) {
            try {
                await pc.addIceCandidate(candidate);
            } catch (err) {
                this._candidatesFailed += 1;
                this._lastError = String((err && err.message) || err);
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
     * Make sure every local track is being sent on this connection.
     *
     * Live tracks that already have a sender of the same kind are swapped in
     * with `replaceTrack` (no renegotiation needed); a brand-new kind goes in
     * with `addTrack`, which reuses a free transceiver and triggers negotiation.
     * `_addedAt` arms a safety net (`_ensureOfferedSince`) so a track that never
     * produced an offer is offered anyway.
     */
    addLocalTracks(stream) {
        if (!stream) return false;
        let added = false;
        for (const track of stream.getTracks()) {
            if (track.readyState !== 'live') continue;
            const senders = this.pc.getSenders();
            if (senders.some((s) => s.track === track)) continue;         // already sending it
            const sameKind = senders.find((s) => s.track && s.track.kind === track.kind);
            if (sameKind) {
                sameKind.replaceTrack(track).catch(() => {});
                added = true;
                continue;
            }
            try {
                this.pc.addTrack(track, stream);
                added = true;
            } catch (err) {
                this._lastError = String((err && err.message) || err);
            }
        }
        if (added) this._addedAt = Date.now();
        return added;
    }

    /**
     * Our offer was ignored by the peer and theirs was ignored by us: with one
     * lost envelope nothing would ever be negotiated again.  Roll our offer
     * back and take theirs instead — the polite side is waiting for exactly
     * that answer.
     */
    async _resolveIgnoredOffer() {
        const held = this._ignoredOffer;
        if (!held || this.pc.signalingState !== 'have-local-offer') return false;
        this._ignoredOffer = null;
        try {
            await this.pc.setLocalDescription({ type: 'rollback' });
        } catch (err) {
            this._lastError = String((err && err.message) || err);
            return false;
        }
        this._offerResends = 0;
        this._lastNegotiationAt = 0;            // our tracks still need an offer
        this._addedAt = this._addedAt || Date.now();
        await this.handleSignal({ sdp: held.description, screen: held.isScreen });
        return true;
    }

    /**
     * The periodic safety net, called from the stats tick.  Two things need it:
     * a track change that never produced an offer, and an offer that was never
     * answered (the envelope was lost, or the socket dropped between the two
     * peers).  Both would otherwise leave a camera negotiated on one side only.
     */
    _ensureOfferedSince() {
        const offerAge = this._lastNegotiationAt ? Date.now() - this._lastNegotiationAt : 0;
        const waitingForAnswer = this.pc.signalingState === 'have-local-offer' && this._lastNegotiationAt;
        if (waitingForAnswer && offerAge > OFFER_RESEND_MS && this._ignoredOffer) {
            this._resolveIgnoredOffer().catch(() => {});
            return;
        }
        if (waitingForAnswer && offerAge > OFFER_RESEND_MS && (this._offerResends || 0) < OFFER_RESEND_MAX) {
            // Our (current) offer is older than a lost envelope should be —
            // send the very same description again instead of giving up.
            this._offerResends = (this._offerResends || 0) + 1;
            this._lastNegotiationAt = Date.now();
            this.mesh._signal(this.peer.member_id, { sdp: this.pc.localDescription, screen: false });
            return;
        }
        if (this._addedAt && this._lastNegotiationAt < this._addedAt) {
            if (this.pc.signalingState !== 'stable' || this._negotiating) {
                this._negotiationDeferred = true;
                return;
            }
            this.negotiate(false);
            return;
        }
        this._flushDeferredNegotiation();
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
        this._rebuiltAt = new Map();     // identity → when it was last rebuilt
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
        this._localAnalyser = null;
        this._localLevelRaf = null;
        this._localSpeakingUntil = 0;
        this.currentView = 'media';
        this._micDeviceId = null;         // remembered across acquisitions
        this._camDeviceId = null;
        this._toggling = { mic: false, camera: false };   // double-tap guard
        this._lastError = null;           // set by _acquire so callers can skip a 2nd toast
        this._deviceChangeBound = null;
    }

    async init({ roomCode, self, permissions, signal, onStateChange, onQualityChange, iceServers }) {
        this.roomCode = roomCode;
        this.self = self;
        this.permissions = permissions || {};
        this.signal = signal;
        this.onStateChange = onStateChange || (() => {});
        this.onQualityChange = onQualityChange || (() => {});
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
        this._statsTimer = setInterval(() => this._tick(), 4000);
        this._speakerTimer = setInterval(() => this._evaluateSpeaker(), 700);
        // Cheap self-healing sweep: a camera that arrived late, a mute/unmute
        // event that was missed, or a track that never produced an offer all
        // fix themselves within a second instead of needing a reconnect.
        this._tileTimer = setInterval(() => this._refreshTiles(), 1000);
        this._watchDevices();
        this._visibilityBound = () => {
            if (document.visibilityState === 'visible') this._refreshTiles();
        };
        document.addEventListener('visibilitychange', this._visibilityBound);
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
                // the higher member id initiates; the polite side just answers
                if (this.self.memberId > p.member_id) {
                    if (!this.localStream) {
                        // an (unused) data channel triggers onnegotiationneeded
                        try { link.pc.createDataChannel('mesh-init'); } catch (e) { /* noop */ }
                    }
                }
                this._replayPending(p.identity).catch(() => {});
            } else {
                this.links.get(p.identity).updatePeer(p);
            }
        }
        for (const identity of Array.from(this.links.keys())) {
            if (!seen.has(identity)) this._removePeer(identity);
        }
    }

    _removePeer(identity) {
        const link = this.links.get(identity);
        if (link) link.close();
        this.links.delete(identity);
        const tile = this.tiles.get(identity);
        if (tile) tile.remove();
        this.tiles.delete(identity);
        const audio = this._audioEls.get(identity);
        if (audio) { audio.srcObject = null; audio.remove(); }
        this._audioEls.delete(identity);
        disposeAnalyser(this.levels.get(identity));
        this.levels.delete(identity);
        if (this.activeSpeaker === identity) this.activeSpeaker = null;
        if (this._screenOwner === identity) this._hideScreenView();
        this._layout();
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
        // Numbers beat adjectives: a screenshot of this is a bug report.
        try { console.warn('[mesh] peer diagnostics', this.diag()); } catch (err) { /* console only */ }
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
        for (const link of this.links.values()) {
            for (const sender of link.pc.getSenders()) {
                const kind = sender.track && sender.track.kind;
                if (!kind || sender.track.readyState !== 'ended') continue;
                const fresh = this.localStream
                    && this.localStream.getTracks().find((t) => t.kind === kind && t.readyState === 'live');
                sender.replaceTrack(fresh || null).catch(() => {});
            }
            link.addLocalTracks(this.localStream);
        }
    }

    /** Classroom-grade audio processing — the same defaults Meet/Zoom rely on. */
    _audioConstraints(deviceId) {
        const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
    }

    _videoConstraints(deviceId) {
        const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
        return deviceId ? { ...base, deviceId: { exact: deviceId } } : base;
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
            this.cameraOn = true;
            this._republishLocal();
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
        const p = el.play();
        if (p && typeof p.catch === 'function') {
            p.catch(() => {
                // Autoplay policy: retry on the first real user gesture.  One
                // rescue per element is enough — the periodic tile sweep calls
                // this often enough that stacking listeners would leak.
                if (el.__playArmed) return;
                el.__playArmed = true;
                const retry = () => {
                    el.__playArmed = false;
                    el.play().catch(() => {});
                    document.removeEventListener('pointerdown', retry);
                    document.removeEventListener('keydown', retry);
                };
                document.addEventListener('pointerdown', retry, { once: true });
                document.addEventListener('keydown', retry, { once: true });
            });
        }
    }

    /** Re-render tile/UI/pip after any local device change. */
    _afterLocalChange() {
        if (this.localStream) this._renderLocalTile();
        else this._renderLocalTileEmpty();
        this._syncLocalUI();
        this.updatePip(this.currentView);
    }

    // ------------------------------------------------- local mic meter
    /** Live volume bar on the mic button + our tile, from REAL samples. */
    _startLocalLevel() {
        this._stopLocalLevel();
        const track = this.localStream && this.localStream.getAudioTracks()[0];
        if (!track) return;
        this._localAnalyser = createAnalyser(new MediaStream([track]));
        if (!this._localAnalyser) return;
        const tick = () => {
            if (!this.micOn) return;
            const level = analyserLevel(this._localAnalyser);
            const btn = document.getElementById('btn-mic');
            if (btn) btn.style.setProperty('--mic-level', level.toFixed(3));
            const tile = this.tiles.get(this.self.identity);
            if (tile) {
                tile.style.setProperty('--lvl', level.toFixed(3));
                const now = performance.now();
                if (level > 0.03) this._localSpeakingUntil = now + 750;
                const speaking = now < this._localSpeakingUntil;
                tile.classList.toggle('speaking', speaking);
                tile.querySelector('.tile-speaking')?.setAttribute('aria-hidden', String(!speaking));
            }
            this._localLevelRaf = requestAnimationFrame(tick);
        };
        this._localLevelRaf = requestAnimationFrame(tick);
    }

    _stopLocalLevel() {
        if (this._localLevelRaf) cancelAnimationFrame(this._localLevelRaf);
        this._localLevelRaf = null;
        disposeAnalyser(this._localAnalyser);
        this._localAnalyser = null;
        this._localSpeakingUntil = 0;
        const btn = document.getElementById('btn-mic');
        if (btn) btn.style.setProperty('--mic-level', '0');
        const tile = this.tiles.get(this.self.identity);
        if (tile) {
            tile.style.setProperty('--lvl', '0');
            tile.classList.remove('speaking');
            tile.querySelector('.tile-speaking')?.setAttribute('aria-hidden', 'true');
        }
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

    /**
     * Replay buffered envelopes for a peer in the order they arrived.
     *
     * Awaiting each one matters: `setRemoteDescription` is applied
     * asynchronously, and a candidate handed to `addIceCandidate` before that
     * finishes is rejected by the browser (it is queued on the link instead,
     * but keeping the order makes the whole path deterministic).
     */
    async _replayPending(identity) {
        if (!this._pendingSignals) return;
        const link = this.links.get(identity);
        if (!link) return;
        const mine = this._pendingSignals.filter((msg) => msg.from_identity === identity);
        this._pendingSignals = this._pendingSignals.filter((msg) => msg.from_identity !== identity);
        for (const msg of mine) {
            // eslint-disable-next-line no-await-in-loop
            try {
                await link.handleSignal(msg.data);
            } catch (err) {
                console.warn('[mesh] signal error:', err);
            }
        }
    }

    /**
     * Is this peer allowed to have a live camera as far as the *server's* rules
     * go?  Mirrors `classrooms/permissions.py`: a moderator's camera flag never
     * applies to the OWNER, and stale/unknown data must never hide a picture
     * that is really arriving (the track's own `muted` says that).
     */
    _cameraAllowed(link) {
        const peer = (link && link.peer) || {};
        const permissions = peer.permissions || {};
        if (permissions.can_use_camera === false) return false;
        if (peer.camera_disabled === true && peer.role && peer.role !== 'OWNER') return false;
        return true;
    }

    _micAllowed(link) {
        const peer = (link && link.peer) || {};
        const permissions = peer.permissions || {};
        return permissions.can_use_microphone !== false;
    }

    /**
     * Park one received track in the peer's stream and keep the UI in step.
     * Called for every `ontrack`, whenever we learn about a track that appeared
     * later in an already-known stream, and from the periodic sweep — so a
     * camera that arrives after the connection is set up can never be missed.
     */
    _attachRemoteTrack(link, track, isScreen) {
        if (!link || !track) return;
        const stream = link._streamFor(isScreen);
        if (!stream.getTracks().includes(track)) stream.addTrack(track);
        const bound = this._trackBound || (this._trackBound = new WeakSet());
        if (!bound.has(track)) {
            bound.add(track);
            const refresh = () => {
                this._applyPeerPermissions(link);      // sets enabled + refreshes
                this._refreshRemoteTile(link.peer.identity);
            };
            track.addEventListener('mute', refresh);
            track.addEventListener('unmute', refresh);
            track.addEventListener('ended', () => {
                try { stream.removeTrack(track); } catch (err) { /* already gone */ }
                refresh();
            });
        }
    }

    _applyPeerPermissions(link) {
        if (!link?.peer) return;
        const cameraAllowed = this._cameraAllowed(link);
        const micAllowed = this._micAllowed(link);
        link.remoteStream?.getAudioTracks().forEach((track) => { track.enabled = micAllowed; });
        link.remoteStream?.getVideoTracks().forEach((track) => { track.enabled = cameraAllowed; });

        const screenPermissions = link.peer.permissions || {};
        const screenTrack = link.remoteScreenStream?.getVideoTracks()[0];
        const screenAllowed = screenPermissions.can_share_screen !== false
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

    /** A media track arrived from `peer` (its stream is kept, never replaced). */
    _onRemoteMedia(peer, stream) {
        const link = this.links.get(peer.identity);
        if (!link) return;
        const mediaStream = link.remoteStream || stream;
        this._applyPeerPermissions(link);
        let audio = this._audioEls.get(peer.identity);
        if (!audio) {
            audio = document.createElement('audio');
            audio.autoplay = true;
            document.body.appendChild(audio);
            this._audioEls.set(peer.identity, audio);
        }
        if (audio.srcObject !== mediaStream) {
            audio.srcObject = mediaStream;
            this._applySinkId(audio);
            this._playSafe(audio);
        }
        const tile = this._ensureTile(peer);
        const video = tile.querySelector('video');
        if (video && video.srcObject !== mediaStream) video.srcObject = mediaStream;
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
        const overlay = document.createElement('div');
        overlay.className = 'tile-overlay';
        overlay.innerHTML = '<span class="tile-name"></span><span class="tile-icons"><i class="t-mic" title="میکروفون">🎤</i></span>'
            + '<button type="button" class="tile-fs" title="نمایش تمام‌صفحه" aria-label="نمایش تمام‌صفحه">⛶</button>';
        overlay.querySelector('.tile-fs')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const v = tile.querySelector('video');
            const t = v && v.readyState > 0 ? v : tile;
            if (document.fullscreenElement) document.exitFullscreen?.();
            else t.requestFullscreen?.().catch(() => {});
        });
        const placeholder = document.createElement('div');
        placeholder.className = 'tile-placeholder';
        placeholder.textContent = (peer.name || '?').charAt(0);
        const speaking = document.createElement('span');
        speaking.className = 'tile-speaking';
        speaking.textContent = 'در حال صحبت';
        speaking.setAttribute('role', 'status');
        speaking.setAttribute('aria-label', 'در حال صحبت');
        speaking.setAttribute('aria-hidden', 'true');
        const level = document.createElement('i');
        level.className = 'tile-level';
        level.setAttribute('aria-hidden', 'true');
        // Why a tile is empty is information, not decoration ("camera on but
        // no picture yet" / "this network needs a TURN relay").
        const hint = document.createElement('small');
        hint.className = 'tile-hint hidden';
        hint.setAttribute('aria-live', 'polite');
        tile.append(video, placeholder, overlay, speaking, level, hint);
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
        video.style.display = camLive ? '' : 'none';
        tile.querySelector('.tile-placeholder').classList.toggle('hidden', camLive);
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
        video.style.display = 'none';
        tile.querySelector('.tile-placeholder').classList.remove('hidden');
        this._layout();
    }

    /**
     * Decide what this peer's tile shows, from *media truth* first.
     *
     * For a REMOTE track `enabled` stays true even when the sender switches the
     * device off, so liveness comes from `muted` (the receiver sees RTP stop).
     * Permissions only ever *hide* media, they never reveal it — and where the
     * two disagree (a stale moderator flag on an owner, a roster row we have
     * not heard from yet) the arriving picture wins, because "the camera is on
     * but nobody can see me" is the failure that actually breaks a class.
     *
     * Called on every `ontrack`, every mute/unmute, every roster update and
     * from the periodic sweep, so a missed event self-corrects within a second.
     */
    _refreshRemoteTile(identity) {
        const link = this.links.get(identity);
        const tile = this.tiles.get(identity);
        if (!link || !tile) return;
        const stream = link.remoteStream;
        const videoTrack = stream && stream.getVideoTracks().find((t) => t.readyState === 'live');
        const camLive = Boolean(
            this._cameraAllowed(link)
            && videoTrack && !videoTrack.muted && videoTrack.enabled !== false
        );
        const video = tile.querySelector('video');
        if (video.srcObject !== stream) video.srcObject = stream || null;
        video.style.display = camLive ? '' : 'none';
        tile.querySelector('.tile-placeholder').classList.toggle('hidden', camLive);
        if (camLive && video.paused) this._playSafe(video);
        const audioTrack = stream && stream.getAudioTracks().find((t) => t.readyState === 'live');
        const micLive = Boolean(
            this._micAllowed(link)
            && audioTrack && !audioTrack.muted && audioTrack.enabled !== false
        );
        tile.querySelector('.t-mic')?.classList.toggle('off', !micLive);
        this._updateTileHint(link, tile, { camLive, videoTrack });
    }

    /**
     * The line under a peer's tile that says what is (not) happening.
     *
     * Silence is the worst answer here: a teacher whose camera is on and whose
     * class sees nothing needs to know whether their picture never left the
     * room, never arrived, or was deliberately hidden — and a classmate whose
     * camera is on needs to see that we are waiting for their picture instead
     * of a name on a grey square.
     */
    _updateTileHint(link, tile, { camLive, videoTrack }) {
        const hint = tile.querySelector('.tile-hint');
        if (!hint) return;
        let text = '';
        let tone = '';
        if (!camLive && link.peer.camera_on === true) {
            if (videoTrack) {
                text = 'دوربین روشن است اما تصویر هنوز نرسیده…';
                tone = 'waiting';
            } else if (!link._isUp(link.pc)) {
                text = 'در حال برقراری ارتباط تصویری…';
                tone = 'waiting';
            } else {
                text = hasTurnServer()
                    ? 'تصویر این هم‌کلاسی از شبکه نرسید.'
                    : 'تصویر این هم‌کلاسی نرسید — شبکه‌های سخت به سرور TURN نیاز دارند.';
                tone = 'warn';
            }
        }
        hint.textContent = text;
        hint.classList.toggle('hidden', !text);
        hint.classList.toggle('warn', tone === 'warn');
        hint.classList.toggle('waiting', tone === 'waiting');
        tile.classList.toggle('cam-pending', tone === 'waiting');
    }

    /** Cheap sweep: re-evaluate every remote tile from the media objects. */
    _refreshTiles() {
        this.links.forEach((link, identity) => this._refreshRemoteTile(identity));
        this._renderLocalTileIfNeeded();
    }

    _renderLocalTileIfNeeded() {
        if (!this.localStream) return;
        const tile = this.tiles.get(this.self.identity);
        if (!tile) return;
        const track = this.localStream.getVideoTracks().find((t) => t.readyState === 'live');
        const camLive = Boolean(track);
        const video = tile.querySelector('video');
        if (video && video.srcObject !== this.localStream) video.srcObject = this.localStream;
        if (video) video.style.display = camLive ? '' : 'none';
    }

    setLayout(mode) {
        if (!['grid', 'speaker', 'focus', 'presentation'].includes(mode)) return;
        this.layout = mode;
        try { localStorage.setItem(`room_layout_${this.roomCode}`, mode); } catch (e) { /* noop */ }
        this._layout();
    }

    _layout() {
        const count = this.tiles.size;
        this.tilesEl.dataset.count = String(count);
        this.tilesEl.dataset.layout = this.layout;
        let focus = null;
        if (this.layout !== 'grid') focus = this.activeSpeaker;
        this.tilesEl.classList.toggle('has-focus', Boolean(focus));
        this.tiles.forEach((tile, identity) => {
            tile.classList.toggle('focus', identity === focus);
            tile.classList.toggle('mini', Boolean(focus) && identity !== focus);
            // Focus adjusts tile sizes but must not hide a live camera.
        });
        this.emptyEl.classList.toggle('hidden', count > 0);
    }

    // ------------------------------------------------- speaker + quality
    _evaluateSpeaker() {
        // Read real signal levels from each remote stream. Every participant
        // above the noise gate gets a visible speaking badge; the loudest is
        // still used as the focus/PiP speaker.
        let best = null;
        let bestLevel = 0.02; // noise gate for choosing the focus speaker
        for (const [identity, link] of this.links) {
            const stream = link.remoteStream;
            const tile = this.tiles.get(identity);
            const audioTrack = stream && stream.getAudioTracks()[0];
            if (!audioTrack || !audioTrack.enabled || audioTrack.muted || audioTrack.readyState !== 'live') {
                if (tile) {
                    tile.style.setProperty('--lvl', '0');
                    tile._speakingUntil = 0;
                    tile.classList.remove('speaking');
                    tile.querySelector('.tile-speaking')?.setAttribute('aria-hidden', 'true');
                }
                continue;
            }
            let analyser = this.levels.get(identity);
            if (!analyser) {
                analyser = createAnalyser(stream);
                if (!analyser) continue;
                this.levels.set(identity, analyser);
            }
            const level = analyserLevel(analyser);
            if (tile) {
                tile.style.setProperty('--lvl', level.toFixed(3));
                const now = performance.now();
                if (level > 0.03) tile._speakingUntil = now + 900;
                const speaking = now < (tile._speakingUntil || 0);
                tile.classList.toggle('speaking', speaking);
                tile.querySelector('.tile-speaking')?.setAttribute('aria-hidden', String(!speaking));
            }
            if (level > bestLevel) { bestLevel = level; best = identity; }
        }
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

    /** Everything that has to be re-checked on a timer. */
    async _tick() {
        for (const link of this.links.values()) link._ensureOfferedSince();
        await this._evaluateQuality();
    }

    async _evaluateQuality() {
        // worst peer link quality from REAL RTCStatsReport values
        if (!this.links.size) return;
        let worst = 'excellent';
        for (const link of this.links.values()) {
            try {
                const stats = await link.pc.getStats();
                let lost = 0, received = 0, rtt = null, jitter = null;
                stats.forEach((report) => {
                    if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.kind === 'video')) {
                        lost += report.packetsLost || 0;
                        received += report.packetsReceived || 0;
                        if (report.jitter != null && (jitter === null || report.jitter > jitter)) {
                            jitter = report.jitter;
                        }
                    }
                    if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
                        rtt = report.currentRoundTripTime;
                    }
                });
                const quality = qualityOf({ received, lost, rtt, jitter });
                link.poorStreak = quality === QUALITY.POOR ? (link.poorStreak || 0) + 1 : 0;
                if (quality === QUALITY.POOR) link.score = (link.score || 0) + 3;
                else if (quality === QUALITY.GOOD) link.score = (link.score || 0) + 1;
                else link.score = 0;
                link.lastStats = { received, lost, rtt, jitter, quality };
                worst = worstQuality(worst, quality);
            } catch (e) { /* stats unsupported */ }
        }
        // Reconnect the links that stopped recovering, and adapt what we send
        // to what the network can carry.  Nothing is applied before the first
        // real measurement: a healthy link keeps the browser's own defaults.
        this._recoverStalledLinks();
        const measured = this.quality !== 'unknown';
        if (measured) this._applyQualityPlan(worst);
        if (worst !== this.quality) {
            this.quality = worst;
            this.onQualityChange(worst, null);
        }
    }

    /**
     * Starved links: ask for less instead of dropping the call.
     *
     * ``setParameters`` is the only lever that changes what a *running* stream
     * costs; without it a camera keeps pushing its original bitrate into a
     * congested uplink and everybody's video degrades for everyone.
     */
    _applyQualityPlan(quality = this.quality) {
        const level = quality === 'unknown' ? QUALITY.EXCELLENT : quality;
        const peerCount = this.links.size;
        let changed = false;
        for (const link of this.links.values()) {
            const camera = planFor({ quality: level, peerCount, isScreen: false });
            const screen = planFor({ quality: level, peerCount, isScreen: true });
            const audio = audioPlanFor({ quality: level });
            changed = this._applySenderPlan(link.pc, { ...camera, audio }) || changed;
            if (link.screenPc) {
                changed = this._applySenderPlan(link.screenPc, { ...screen, audio }) || changed;
            }
        }
        if (changed) this._plan = { quality: level, peerCount };
    }

    /** Push a plan to every video sender of one connection (idempotent). */
    _applySenderPlan(pc, plan) {
        if (!pc || !pc.getSenders) return false;
        // the key is the *applied* values only: informational fields (the
        // quality label, the room size) must not cause a redundant call
        const key = [
            plan.maxBitrate, plan.maxFramerate, plan.scaleResolutionDownBy, plan.degradationPreference,
        ].join('|');
        let changed = false;
        for (const sender of pc.getSenders()) {
            const track = sender.track;
            if (!track || track.kind !== 'video') continue;
            if (sender.__planKey === key) continue;
            sender.__planKey = key;
            changed = true;
            let parameters;
            try {
                parameters = sender.getParameters() || {};
            } catch (err) {
                continue;
            }
            if (!parameters.encodings || !parameters.encodings.length) parameters.encodings = [{}];
            for (const encoding of parameters.encodings) {
                encoding.maxBitrate = plan.maxBitrate;
                encoding.maxFramerate = plan.maxFramerate;
                encoding.scaleResolutionDownBy = plan.scaleResolutionDownBy;
            }
            parameters.degradationPreference = plan.degradationPreference;
            try {
                const result = sender.setParameters(parameters);
                if (result && typeof result.catch === 'function') result.catch(() => {});
            } catch (err) { /* not supported in this browser */ }
        }
        return changed;
    }

    /**
     * A link that reported ``failed``/``disconnected`` and did not come back
     * gets one ICE restart, then is rebuilt from scratch.
     */
    _recoverStalledLinks() {
        for (const link of this.links.values()) {
            const pc = link.pc;
            if (!pc || pc.connectionState === 'closed') continue;
            const iceState = pc.iceConnectionState || pc.connectionState;
            const disconnectedMs = link.disconnectedAt ? Date.now() - link.disconnectedAt : 0;
            const advice = transportAdvice({
                iceState,
                poorStreak: link.poorStreak || 0,
                disconnectedMs,
                alreadyRestarted: Boolean(link.iceRestarted),
            });
            if (advice === 'restart-ice') {
                link.iceRestarted = true;
                try { pc.restartIce(); } catch (err) { /* older browsers */ }
                continue;
            }
            if (advice === 'recreate') {
                // Only the initiating side rebuilds; the other side keeps
                // restarting ICE.  If both ends tore the link down at the same
                // moment they would keep offering at each other and never settle.
                const identity = link.peer && link.peer.identity;
                const mineToRebuild = this.self.memberId > (link.peer.member_id || 0);
                const lastRebuild = this._rebuiltAt.get(identity) || 0;
                if (mineToRebuild && Date.now() - lastRebuild > REBUILD_COOLDOWN_MS) {
                    this._replaceLink(link);
                } else if (!mineToRebuild) {
                    // keep trying: a fresh ICE round often recovers a link that
                    // looks dead from the other side of the class
                    link.iceRestarted = false;
                    if (Date.now() - (link.lastRestartAt || 0) > REBUILD_COOLDOWN_MS) {
                        link.lastRestartAt = Date.now();
                        try { pc.restartIce(); } catch (err) { /* older browsers */ }
                    }
                }
            }
        }
    }

    /** Rebuild one peer link (same participant, fresh connection). */
    _replaceLink(link) {
        const identity = link.peer && link.peer.identity;
        if (!identity) return;
        this._rebuiltAt.set(identity, Date.now());
        const peer = link.peer;
        this._removePeer(identity);
        if (peer) this.syncPeers([...this.links.values()].map((l) => l.peer).concat([peer]));
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
        if (myTile) myTile.querySelector('.t-mic')?.classList.toggle('off', !this.micOn);
        this.onStateChange({ mic_on: this.micOn, camera_on: this.cameraOn, screen_sharing: Boolean(this.screenStream) });
    }

    /**
     * Relay one signalling envelope through the room socket.
     *
     * The server refuses envelopes above a hard cap, and an offer that is too
     * big (a screen share with every codec in it) would otherwise vanish
     * silently — so it is measured here first and reported to the user, with
     * the numbers kept for `diag()`.
     */
    _signal(toMemberId, data) {
        const envelope = { action: 'rtc_signal', to_member_id: toMemberId, data };
        let bytes = 0;
        try {
            bytes = JSON.stringify(envelope).length;
        } catch (err) {
            return;                                   // unserialisable: drop
        }
        if (bytes > SIGNAL_MAX_BYTES) {
            this._lastError = `signal-too-large:${bytes}`;
            this._signalRejected = (this._signalRejected || 0) + 1;
            console.warn(`[mesh] signalling envelope of ${bytes} bytes exceeds the server cap; not sent`);
            toast('بستهٔ سیگنالینگ رسانه بزرگ‌تر از حد مجاز سرور است و فرستاده نشد. صفحه را دوباره به اشتراک بگذارید یا تعداد دستگاه‌ها را کم کنید.', 'error', 8000);
            return;
        }
        this.signal(envelope);
    }

    /**
     * Everything a "nobody can see my camera" report needs, in one object.
     *
     * Run `__media.diag()` in the browser console (or look at the warning the
     * room prints when a link fails).  It answers the four questions that
     * actually decide the outcome: what we are sending, whether an offer that
     * carries it left the browser, whether candidates survived the trip, and
     * whether the peer's track is arriving live or muted.
     */
    diag() {
        const describeTrack = (track) => (track ? {
            kind: track.kind,
            readyState: track.readyState,
            muted: track.muted,
            enabled: track.enabled,
        } : null);
        return {
            engine: 'mesh',
            room: this.roomCode,
            self: this.self.identity,
            quality: this.quality,
            media: {
                micOn: this.micOn,
                cameraOn: this.cameraOn,
                screenSharing: Boolean(this.screenStream),
                localTracks: (this.localStream ? this.localStream.getTracks() : []).map(describeTrack),
                screenTracks: (this.screenStream ? this.screenStream.getTracks() : []).map(describeTrack),
            },
            signallingErrors: this._signalRejected || 0,
            ice: {
                servers: ICE_SERVERS.map((s) => ({ urls: [].concat(s.urls || []), hasCredentials: Boolean(s.username) })),
                turnConfigured: hasTurnServer(),
                note: hasTurnServer() ? '' : 'بدون TURN، شبکه‌های سخت (شرکتی/موبایل) نمی‌توانند مستقیم وصل شوند.',
            },
            peers: Array.from(this.links.values()).map((link) => ({
                identity: link.peer.identity,
                name: link.peer.name,
                memberId: link.peer.member_id,
                polite: link.polite,
                connection: link.pc.connectionState,
                ice: link.pc.iceConnectionState,
                signaling: link.pc.signalingState,
                failed: Boolean(link.failed),
                senders: link.pc.getSenders().map((s) => describeTrack(s.track)),
                signalling: {
                    candidatesSent: link._candidatesSent,
                    candidatesQueued: link._candidatesQueued,
                    candidatesReceived: link._candidatesReceived,
                    candidatesFailed: link._candidatesFailed,
                    offersSent: link._offersSent,
                    offersAnswered: link._offersAnswered,
                    offersResent: link._offerResends || 0,
                    deferredNegotiation: Boolean(link._negotiationDeferred),
                    holdingIgnoredOffer: Boolean(link._ignoredOffer),
                },
                roster: {
                    mediaCameraOn: link.peer.camera_on,
                    mediaMicOn: link.peer.mic_on,
                    cameraDisabled: link.peer.camera_disabled,
                    role: link.peer.role,
                    cameraAllowed: this._cameraAllowed(link),
                    micAllowed: this._micAllowed(link),
                },
                received: {
                    audio: describeTrack(link.remoteStream && link.remoteStream.getAudioTracks()[0]),
                    video: describeTrack(link.remoteStream && link.remoteStream.getVideoTracks()[0]),
                    screen: describeTrack(link.remoteScreenStream && link.remoteScreenStream.getVideoTracks()[0]),
                },
                tile: (() => {
                    const tile = this.tiles.get(link.peer.identity);
                    const video = tile && tile.querySelector('video');
                    return {
                        videoShown: Boolean(video && video.style.display !== 'none'),
                        hint: (tile && tile.querySelector('.tile-hint')?.textContent) || '',
                    };
                })(),
                lastSignalAgeMs: link._lastSignalAt ? Date.now() - link._lastSignalAt : null,
                lastError: link._lastError,
            })),
        };
    }

    /** Release everything: devices, timers, listeners, peer connections. */
    dispose() {
        if (this._statsTimer) clearInterval(this._statsTimer);
        if (this._speakerTimer) clearInterval(this._speakerTimer);
        if (this._tileTimer) clearInterval(this._tileTimer);
        this._statsTimer = this._speakerTimer = this._tileTimer = null;
        if (this._visibilityBound) {
            document.removeEventListener('visibilitychange', this._visibilityBound);
            this._visibilityBound = null;
        }
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
