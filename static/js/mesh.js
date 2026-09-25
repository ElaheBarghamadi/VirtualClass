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

const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

class PeerLink {
    constructor(mesh, peer) {
        this.mesh = mesh;
        this.peer = peer;                      // {identity, member_id, name}
        this.polite = mesh.self.memberId < peer.member_id;
        this.makingOffer = false;
        this.ignoreOffer = false;
        this.pc = this._makePc(false);
        this.screenPc = null;                  // created on demand
        this.remoteStream = null;
        this.remoteScreenStream = null;
    }

    _makePc(isScreen) {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this.mesh._signal(this.peer.member_id, { ice: e.candidate, screen: isScreen });
            }
        };
        pc.ontrack = (e) => {
            const stream = e.streams[0] || new MediaStream([e.track]);
            if (isScreen) {
                this.remoteScreenStream = stream;
                this.mesh._onRemoteScreen(this.peer, stream);
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
            } catch (err) {
                console.warn('[mesh] negotiation failed:', err);
            } finally {
                this.makingOffer = false;
            }
        };
        pc.onconnectionstatechange = () => {
            if (['failed', 'closed'].includes(pc.connectionState) && !isScreen) {
                this.mesh._onPeerGone(this.peer.identity);
            }
        };
        return pc;
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
            await pc.setRemoteDescription(description);
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

    addLocalTracks(stream) {
        if (!stream) return;
        const existing = new Set(this.pc.getSenders().map((s) => s.track && s.track.kind));
        for (const track of stream.getTracks()) {
            if (!existing.has(track.kind)) this.pc.addTrack(track, stream);
        }
    }

    close() {
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
        this.levels = new Map();         // identity → current audio level
        this._audioEls = new Map();
        this._screenVideo = null;
        this._statsTimer = null;
        this._speakerTimer = null;
    }

    async init({ roomCode, self, permissions, signal, onStateChange, onQualityChange }) {
        this.roomCode = roomCode;
        this.self = self;
        this.permissions = permissions || {};
        this.signal = signal;
        this.onStateChange = onStateChange || (() => {});
        this.onQualityChange = onQualityChange || (() => {});
        try {
            const saved = localStorage.getItem(`room_layout_${roomCode}`);
            if (saved && ['grid', 'speaker', 'focus', 'presentation'].includes(saved)) this.layout = saved;
        } catch (e) { /* private mode */ }
        const emptyText = document.getElementById('stage-empty-text');
        if (emptyText) {
            emptyText.textContent = 'برای فعال کردن دوربین/میکروفون از دکمه‌های پایین استفاده کنید.';
        }
        // periodic real-stats quality + active-speaker evaluation
        this._statsTimer = setInterval(() => this._evaluateQuality(), 4000);
        this._speakerTimer = setInterval(() => this._evaluateSpeaker(), 700);
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
                this._replayPending(p.identity);
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
        this.levels.delete(identity);
        this._layout();
    }

    _onPeerGone(identity) {
        // connection died (e.g. peer tab closed without clean signal)
        if (this.links.has(identity)) this._removePeer(identity);
    }

    // ------------------------------------------------------------ local
    async _ensureLocalStream() {
        const constraints = {
            audio: this.permissions.can_use_microphone !== false,
            video: this.permissions.can_use_camera !== false,
        };
        if (!constraints.audio && !constraints.video) return null;
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (err) {
            const name = err && err.name;
            if (name === 'NotAllowedError') toast('دسترسی به دوربین/میکروفون توسط مرورگر مسدود شده است.', 'error');
            else if (name === 'NotFoundError') toast('دوربین یا میکروفونی پیدا نشد.', 'error');
            else toast(`خطای دستگاه: ${name || 'نامشخص'}`, 'error');
            return null;
        }
        this._renderLocalTile();
        return this.localStream;
    }

    async toggleMicrophone() {
        if (this.permissions.can_use_microphone === false) {
            toast('شما اجازهٔ استفاده از میکروفون را ندارید.', 'warning');
            return false;
        }
        if (!this.localStream) {
            if (!(await this._ensureLocalStream())) return false;
        }
        const track = this.localStream && this.localStream.getAudioTracks()[0];
        if (!track) { toast('میکروفونی یافت نشد.', 'warning'); return false; }
        if (this.micOn) {
            track.enabled = false;
            this.micOn = false;
        } else {
            // make sure every peer connection carries this track
            for (const link of this.links.values()) link.addLocalTracks(this.localStream);
            track.enabled = true;
            this.micOn = true;
        }
        this._syncLocalUI();
        return true;
    }

    async toggleCamera() {
        if (this.permissions.can_use_camera === false) {
            toast('شما اجازهٔ استفاده از دوربین را ندارید.', 'warning');
            return false;
        }
        if (!this.localStream) {
            if (!(await this._ensureLocalStream())) return false;
        }
        const track = this.localStream && this.localStream.getVideoTracks()[0];
        if (!track) { toast('دوربینی یافت نشد.', 'warning'); return false; }
        if (this.cameraOn) {
            track.enabled = false;
            this.cameraOn = false;
        } else {
            for (const link of this.links.values()) link.addLocalTracks(this.localStream);
            track.enabled = true;
            this.cameraOn = true;
        }
        this._syncLocalUI();
        return true;
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
        const track = this.localStream && this.localStream.getAudioTracks()[0];
        if (track) track.enabled = false;
        this.micOn = false;
        this._syncLocalUI();
    }

    async forceCameraOff() {
        const track = this.localStream && this.localStream.getVideoTracks()[0];
        if (track) track.enabled = false;
        this.cameraOn = false;
        this._syncLocalUI();
    }

    async setMicDevice(deviceId) {
        if (!this.localStream) return;
        const fresh = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
        const newTrack = fresh.getAudioTracks()[0];
        for (const pc of this._allPcs()) {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
            if (sender) await sender.replaceTrack(newTrack);
        }
        this.localStream.getAudioTracks().forEach((t) => t.stop());
        this.localStream.removeTrack(this.localStream.getAudioTracks()[0]);
        this.localStream.addTrack(newTrack);
        newTrack.enabled = this.micOn;
    }

    async setCameraDevice(deviceId) {
        if (!this.localStream) return;
        const fresh = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
        const newTrack = fresh.getVideoTracks()[0];
        for (const pc of this._allPcs()) {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (sender) await sender.replaceTrack(newTrack);
        }
        this.localStream.getVideoTracks().forEach((t) => t.stop());
        this.localStream.removeTrack(this.localStream.getVideoTracks()[0]);
        this.localStream.addTrack(newTrack);
        newTrack.enabled = this.cameraOn;
        this._renderLocalTile();
    }

    async setOutputDevice(deviceId) {
        for (const el of this._audioEls.values()) {
            if (el.setSinkId) { try { await el.setSinkId(deviceId); } catch (e) { /* unsupported */ } }
        }
        const sv = document.querySelector('#screen-holder video');
        if (sv && sv.setSinkId) { try { await sv.setSinkId(deviceId); } catch (e) { /* unsupported */ } }
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

    _onRemoteMedia(peer, stream) {
        let audio = this._audioEls.get(peer.identity);
        if (!audio) {
            audio = document.createElement('audio');
            audio.autoplay = true;
            document.body.appendChild(audio);
            this._audioEls.set(peer.identity, audio);
        }
        audio.srcObject = stream;
        audio.play().catch(() => {});
        const tile = this._ensureTile(peer);
        const video = tile.querySelector('video');
        const camTrack = stream.getVideoTracks()[0];
        if (camTrack) {
            video.srcObject = stream;
            video.style.display = '';
            tile.querySelector('.tile-placeholder').classList.add('hidden');
            camTrack.addEventListener('mute', () => this._refreshRemoteTile(peer.identity));
            camTrack.addEventListener('unmute', () => this._refreshRemoteTile(peer.identity));
        }
        this._refreshRemoteTile(peer.identity);
        this._layout();
    }

    _onRemoteScreen(peer, stream) {
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
        owner.textContent = `${peer.name || peer.identity} صفحهٔ خود را به اشتراک گذاشته است`;
        stream.getVideoTracks()[0].addEventListener('ended', () => this._hideScreenView());
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
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
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
        tile.append(video, placeholder, overlay);
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
        video.style.display = camTrack && camTrack.enabled ? '' : 'none';
        tile.querySelector('.tile-placeholder').classList.toggle('hidden', Boolean(camTrack && camTrack.enabled));
        tile.querySelector('.tile-name').textContent = `${this.self.name} (شما)`;
        this._syncLocalUI();
        this._layout();
    }

    _refreshRemoteTile(identity) {
        const link = this.links.get(identity);
        const tile = this.tiles.get(identity);
        if (!link || !tile) return;
        const stream = link.remoteStream;
        const videoTrack = stream && stream.getVideoTracks()[0];
        const camLive = Boolean(videoTrack && videoTrack.enabled && videoTrack.readyState === 'live');
        const video = tile.querySelector('video');
        if (camLive && video.srcObject !== stream) video.srcObject = stream;
        video.style.display = camLive ? '' : 'none';
        tile.querySelector('.tile-placeholder').classList.toggle('hidden', camLive);
        const audioTrack = stream && stream.getAudioTracks()[0];
        tile.querySelector('.t-mic').classList.toggle('off', !(audioTrack && audioTrack.enabled));
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
        const hideStrips = this.layout === 'focus';
        this.tiles.forEach((tile, identity) => {
            tile.classList.toggle('focus', identity === focus);
            tile.classList.toggle('mini', Boolean(focus) && identity !== focus);
            tile.classList.toggle('strip-hidden', hideStrips && identity !== focus);
        });
        this.emptyEl.classList.toggle('hidden', count > 0);
    }

    // ------------------------------------------------- speaker + quality
    _evaluateSpeaker() {
        // real signal levels from an AnalyserNode per remote audio stream
        let best = null;
        let bestLevel = 0.02; // noise gate
        for (const [identity, link] of this.links) {
            const stream = link.remoteStream;
            const audioTrack = stream && stream.getAudioTracks()[0];
            if (!audioTrack || !audioTrack.enabled) continue;
            let analyser = this.levels.get(identity);
            try {
                if (!analyser) {
                    this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
                    const src = this.audioCtx.createMediaStreamSource(stream);
                    analyser = this.audioCtx.createAnalyser();
                    analyser.fftSize = 512;
                    src.connect(analyser);
                    analyser._buf = new Uint8Array(analyser.frequencyBinCount);
                    this.levels.set(identity, analyser);
                }
                analyser.getByteTimeDomainData(analyser._buf);
                let peak = 0;
                for (let i = 0; i < analyser._buf.length; i++) peak = Math.max(peak, Math.abs(analyser._buf[i] - 128));
                if (peak > bestLevel) { bestLevel = peak; best = identity; }
            } catch (e) { /* context blocked */ }
        }
        if (best !== this.activeSpeaker) {
            this.activeSpeaker = best;
            this.tiles.forEach((tile, identity) => {
                tile.classList.toggle('speaking', identity === best);
            });
            this._layout();
        }
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

    _signal(toMemberId, data) {
        this.signal({ action: 'rtc_signal', to_member_id: toMemberId, data });
    }
}

export { MeshMedia };
