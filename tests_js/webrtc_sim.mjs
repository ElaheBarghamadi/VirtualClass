/**
 * webrtc_sim.mjs — a small, browser-faithful WebRTC simulation.
 *
 * The bug that matters most in a classroom ("the camera turns on but the rest
 * of the class never sees the picture") needs *two* peers to appear at all, and
 * a real browser cannot run in CI.  This module implements just enough of the
 * WebRTC API — with the rules our code has to obey — so `mesh.js` can be driven
 * end to end by two in-process clients:
 *
 * * ``addIceCandidate`` **throws** ``InvalidStateError`` while there is no
 *   remote description (every real browser does this; the caller must queue).
 * * ``addTrack`` reuses a transceiver whose sender track is ``null`` (spec), so
 *   toggling a camera twice must not add a second video m-line.
 * * a received track starts ``muted = true`` and only unmutes when media really
 *   flows, then mutes again when the sender stops — exactly the signal
 *   ``mesh.js`` uses to decide whether a camera has a picture.
 * * remote streams are keyed by msid: adding a second track to the same local
 *   stream appends to the *same* remote MediaStream object, while publishing
 *   from a fresh MediaStream produces a second remote stream object.
 * * offers can collide: either side may offer, and the polite side rolls back.
 *
 * Everything is microtask-based, so a full negotiation settles in a few awaits.
 */

let nextMid = 0;

class EventTargetish {
    constructor() { this._listeners = new Map(); }

    addEventListener(type, handler, options = {}) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push({ handler, once: Boolean(options && options.once) });
    }

    removeEventListener(type, handler) {
        const list = this._listeners.get(type) || [];
        this._listeners.set(type, list.filter((entry) => entry.handler !== handler));
    }

    dispatch(type, detail) {
        for (const entry of [...(this._listeners.get(type) || [])]) {
            if (entry.once) this.removeEventListener(type, entry.handler);
            entry.handler(detail);
        }
        const inline = this[`on${type}`];
        if (typeof inline === 'function') inline(detail);
    }
}

export class SimTrack extends EventTargetish {
    constructor(kind, label = '') {
        super();
        this.kind = kind;
        this.label = label;
        this.id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
        this.readyState = 'live';
        this.enabled = true;
        this.muted = false;
    }

    stop() {
        if (this.readyState === 'ended') return;
        this.readyState = 'ended';
        this.dispatch('ended');
    }

    /** Simulation only: flip `muted` the way a browser does on RTP loss/recovery. */
    setMuted(value) {
        if (this.muted === value) return;
        this.muted = value;
        this.dispatch(value ? 'mute' : 'unmute');
    }
}

export class SimMediaStream extends EventTargetish {
    constructor(tracks = []) {
        super();
        this.id = `stream-${Math.random().toString(36).slice(2, 8)}`;
        this.tracks = [...tracks];
    }

    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }

    addTrack(track) {
        if (this.tracks.includes(track)) return;
        this.tracks.push(track);
        this.dispatch('addtrack', { track });
    }

    removeTrack(track) {
        this.tracks = this.tracks.filter((t) => t !== track);
        this.dispatch('removetrack', { track });
    }
}

class SimSender {
    constructor(transceiver) {
        this._transceiver = transceiver;
        this.track = null;
        this.replaceTrackCalls = 0;
        this.parameters = { encodings: [{}], degradationPreference: 'balanced' };
    }

    getParameters() { return JSON.parse(JSON.stringify(this.parameters)); }

    setParameters(parameters) {
        this.parameters = parameters;
        return Promise.resolve();
    }

    replaceTrack(track) {
        this.replaceTrackCalls += 1;
        this.track = track || null;                 // same m-line, no renegotiation
        this._transceiver.pc._mediaChanged();
        return Promise.resolve();
    }
}

class SimTransceiver {
    constructor(pc, kind, direction) {
        this.pc = pc;
        this.kind = kind;
        this.mid = `m${nextMid += 1}`;
        this.direction = direction;                 // sendrecv | sendonly | recvonly
        this.sender = new SimSender(this);
        this.receiver = { track: null, streams: [] };
        this._announced = false;
    }
}

export class SimPeerConnection extends EventTargetish {
    static instances = [];
    /** Candidates rejected because no remote description existed yet. */
    static droppedCandidates = 0;

    constructor(config = {}) {
        super();
        this.config = config;
        this.localDescription = null;
        this.remoteDescription = null;
        this.signalingState = 'stable';
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.iceGatheringState = 'new';
        this.transceivers = [];
        this._remote = new Map();          // mid → {kind, direction, streamId, live}
        this._remoteStreams = new Map();   // msid → SimMediaStream (receiver side)
        this._pendingCandidates = [];
        this._remoteCandidates = [];
        this._negotiationQueued = false;
        this._iceRestarts = 0;
        /** Set by the test: how to reach the other side + which media it sends. */
        this.transport = null;
        SimPeerConnection.instances.push(this);
    }

    /* ---------------------------------------------------------------- */
    /* tracks, transceivers, negotiation                                */
    /* ---------------------------------------------------------------- */
    addTrack(track, stream) {
        // Spec: reuse a transceiver whose sender track is null and kind matches.
        let transceiver = this.transceivers.find((t) => t.kind === track.kind && t.sender.track === null);
        if (!transceiver) {
            transceiver = new SimTransceiver(this, track.kind, 'sendrecv');
            this.transceivers.push(transceiver);
        }
        if (transceiver.direction === 'recvonly') transceiver.direction = 'sendrecv';
        transceiver.sender.track = track;
        transceiver.streamId = stream ? stream.id : transceiver.streamId;
        this._negotiationNeeded();
        this._mediaChanged();
        return transceiver.sender;
    }

    getSenders() { return this.transceivers.map((t) => t.sender); }
    getTransceivers() { return [...this.transceivers]; }
    getReceivers() { return this.transceivers.map((t) => t.receiver); }

    createDataChannel() {
        this._dataChannel = true;
        this._negotiationNeeded();
        return { label: 'sim' };
    }

    _negotiationNeeded() {
        if (this._negotiationQueued || this.connectionState === 'closed') return;
        this._negotiationQueued = true;
        Promise.resolve().then(() => {
            this._negotiationQueued = false;
            if (this.connectionState === 'closed') return;
            this.dispatch('negotiationneeded', {});
        });
    }

    /**
     * Only ``type`` and ``sdp`` travel over the wire — exactly like a real
     * browser, where the m-lines live in the SDP text.  Anything the receiver
     * needs to rebuild the session is encoded there.
     */
    _description(type) {
        const session = {
            transceivers: this.transceivers.map((t) => ({
                mid: t.mid,
                kind: t.kind,
                direction: t.direction,
                streamId: t.streamId,
                live: Boolean(t.sender.track && t.sender.track.readyState === 'live'),
            })),
        };
        return { type, sdp: `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n${JSON.stringify(session)}` };
    }

    /** Read back the m-lines from an SDP produced by `_description`. */
    static _session(description) {
        const text = String((description && description.sdp) || '');
        const start = text.indexOf('{');
        if (start === -1) return { transceivers: [] };
        try {
            return JSON.parse(text.slice(start)) || { transceivers: [] };
        } catch (err) {
            return { transceivers: [] };
        }
    }

    createOffer() {
        this.signalingState = 'have-local-offer';
        return Promise.resolve(this._description('offer'));
    }

    createAnswer() { return Promise.resolve(this._description('answer')); }

    async setLocalDescription(description) {
        if (description && description.type === 'rollback') {
            // Discard a local offer that was never answered (perfect
            // negotiation uses this to accept the peer's offer instead).
            this.localDescription = null;
            this.signalingState = 'stable';
            return;
        }
        this.localDescription = { type: description.type, sdp: description.sdp };
        this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
        this._gather();
        this._pump();
    }

    async setRemoteDescription(description) {
        // Browsers apply a description asynchronously: `addIceCandidate`
        // called before this settles throws InvalidStateError.
        await new Promise((resolve) => setTimeout(resolve, 0));
        this.remoteDescription = { type: description.type, sdp: description.sdp };
        for (const remote of SimPeerConnection._session(description).transceivers) {
            let local = this.transceivers.find((t) => t.mid === remote.mid);
            if (!local) {
                local = new SimTransceiver(this, remote.kind, 'recvonly');
                local.mid = remote.mid;
                this.transceivers.push(local);
            }
            this._remote.set(local.mid, remote);
        }
        this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
        const pending = this._pendingCandidates;
        this._pendingCandidates = [];
        for (const candidate of pending) await this.addIceCandidate(candidate);
        this._announceRemoteTracks();
        this._pump();
    }

    /* ---------------------------------------------------------------- */
    /* ICE                                                              */
    /* ---------------------------------------------------------------- */
    _gather() {
        if (this.iceGatheringState === 'complete' && this._gatheredFor === this.transceivers.length) return;
        this.iceGatheringState = 'gathering';
        this._gatheredFor = this.transceivers.length;
        const generation = this._iceRestarts + 1;
        const mids = this.transceivers.map((t) => t.mid);
        // Gathering is asynchronous: the description always leaves the machine
        // before the first candidate does.
        setTimeout(() => {
            if (this.connectionState === 'closed') return;
            for (const mid of mids) {
                for (const [n, type] of [[1, 'host'], [2, 'srflx']]) {
                    this.dispatch('icecandidate', {
                        candidate: {
                            candidate: `candidate:${n} ${generation} udp 1 1.1.1.${n} ${40000 + n} typ ${type}`,
                            sdpMid: mid, sdpMLineIndex: 0,
                        },
                    });
                }
            }
            this.dispatch('icecandidate', { candidate: null });
            this.iceGatheringState = 'complete';
            this._maybeConnect();
        }, 0);
    }

    async addIceCandidate(candidate) {
        if (!candidate || !candidate.candidate) return;        // end-of-candidates
        if (!this.remoteDescription) {
            // Real browsers throw and DROP the candidate.  Anyone who forgets
            // to queue loses the only path the two peers could have used.
            SimPeerConnection.droppedCandidates += 1;
            const error = new Error('The remote description was null');
            error.name = 'InvalidStateError';
            throw error;
        }
        this._remoteCandidates.push(candidate);
        this._maybeConnect();
    }

    restartIce() {
        this._iceRestarts += 1;
        this.iceGatheringState = 'new';
        this._negotiationNeeded();
    }

    _maybeConnect() {
        if (this.connectionState === 'closed') return;
        const peer = this.transport ? this.transport.peer(this) : null;
        const ready = Boolean(
            peer && peer.localDescription && peer.remoteDescription
            && (this._remoteCandidates.length || peer.iceGatheringState === 'complete'),
        );
        if (this.localDescription && this.remoteDescription && ready) {
            if (this.connectionState !== 'connected') {
                this.connectionState = 'connected';
                this.iceConnectionState = 'connected';
                this.dispatch('iceconnectionstatechange', {});
                this.dispatch('connectionstatechange', {});
            }
            this._pump();
        } else if (this.connectionState === 'new' && this.localDescription) {
            this.connectionState = 'connecting';
            this.iceConnectionState = 'checking';
        }
    }

    /* ---------------------------------------------------------------- */
    /* received media                                                   */
    /* ---------------------------------------------------------------- */
    /** Create receiver tracks once per remote transceiver, exactly like Chrome. */
    _announceRemoteTracks() {
        for (const transceiver of this.transceivers) {
            if (transceiver._announced || !transceiver.mid) continue;
            const remote = this._remote.get(transceiver.mid);
            if (!remote) continue;
            // A track is created when the remote end says it will send media.
            if (remote.direction !== 'sendrecv' && remote.direction !== 'sendonly') continue;
            transceiver._announced = true;
            const track = new SimTrack(transceiver.kind, `${this.constructor.name}:${transceiver.mid}`);
            track.muted = true;
            transceiver.receiver.track = track;
            let stream = null;
            if (remote.streamId) {
                stream = this._remoteStreams.get(remote.streamId);
                if (!stream) {
                    stream = new SimMediaStream();
                    this._remoteStreams.set(remote.streamId, stream);
                }
                stream.addTrack(track);
            }
            transceiver.receiver.streams = stream ? [stream] : [];
            this.dispatch('track', {
                track,
                streams: transceiver.receiver.streams,
                transceiver,
            });
        }
    }

    /** Which of our tracks are flowing right now?  Driven by the peer's senders. */
    _mediaChanged() { this._pump(); }

    /**
     * Recompute which received tracks are flowing.  A sender stopping a track
     * (camera off) mutes the *peer's* receiver track, so both sides are pumped
     * whenever either side's media changes.
     */
    _pump() {
        if (!this.transport) return;
        this._applyFlows();
        const peer = this.transport.peer(this);
        if (peer && peer.transport) peer._applyFlows();
    }

    _applyFlows() {
        for (const transceiver of this.transceivers) {
            const track = transceiver.receiver.track;
            if (!track || track.readyState === 'ended') continue;
            track.setMuted(!this.transport.flowing(this, transceiver.mid));
        }
    }

    async getStats() { return { forEach() { /* no rows in the simulation */ } }; }

    close() {
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
        this.signalingState = 'closed';
        this.dispatch('connectionstatechange', {});
    }

    /** Scripted failure, used by the recovery tests. */
    fail() {
        this.connectionState = 'failed';
        this.iceConnectionState = 'failed';
        this.dispatch('connectionstatechange', {});
        this.dispatch('iceconnectionstatechange', {});
    }
}

/** Reset the counters between scenarios. */
export function resetSim() {
    SimPeerConnection.instances.length = 0;
    SimPeerConnection.droppedCandidates = 0;
    nextMid = 0;
}
