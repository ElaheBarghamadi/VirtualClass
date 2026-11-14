/**
 * media.js — classroom media transport.
 *
 * Two interchangeable engines behind one API:
 *  1. LiveKit SFU  — used when the server is configured (recommended for
 *     larger rooms; Django issues short-lived scoped tokens).
 *  2. P2P mesh     — optional fallback, unsuitable for enforced revocation
 *     with zero external infrastructure (see mesh.js; Django only relays
 *     signalling envelopes, never media).
 *
 * Media never passes through Django WebSockets in either mode.
 */
import { toast } from './toast.js';
import { MeshMedia } from './mesh.js';
import { loadVendor } from './vendor.js';
import {
    createAnalyser, createLevelTracker, createSpeakingGate, disposeAnalyser,
    paintMic, paintTile, resetMic, startLevelLoop,
} from './meter.js';

/** Camera capture shared by both engines: 16:9, 720p, 30 fps. */
const CAMERA_CAPTURE = { resolution: { width: 1280, height: 720, frameRate: 30 }, aspectRatio: 16 / 9 };

/**
 * The LiveKit client (~423 KB) is fetched only when this deployment actually
 * uses an SFU.  A mesh-only room — which is what a server without
 * MEDIA_SERVER_URL runs — never downloads it at all.
 */
function livekit() {
    const L = window.LivekitClient;
    if (!L) throw new Error('LiveKit client is not loaded');
    return L;
}

/**
 * How long mic/camera announcements are coalesced before going to the server.
 *
 * One toggle made the engine emit its state two or three times (publish event,
 * UI sync, roster echo).  Each announcement is a server-side DB read plus a
 * broadcast to *every* participant, so a class of twelve tapping their buttons
 * multiplied into a small flood.  Keeping the last state for a blink and
 * sending it once is invisible on screen and much lighter on the socket.
 */
const MEDIA_STATE_COALESCE_MS = 90;

/** Fullscreen a tile's video (falls back to the tile itself). */
function toggleTileFullscreen(tile) {
    const video = tile.querySelector('video');
    const target = video && video.readyState > 0 ? video : tile;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else target.requestFullscreen?.().catch(() => {});
}

class LivekitMedia {
    constructor() {
        this.room = null;
        this.localParticipant = null;
        this.tilesEl = document.getElementById('tiles');
        this.emptyEl = document.getElementById('stage-empty');
        this.tiles = new Map();          // identity → tile element
        this.pinnedIdentity = null;
        this.activeSpeaker = null;
        this.enabled = false;
        this.roomCode = '';
        this.currentIdentity = null;
        this.permissions = {};
        this.micOn = false;
        this.cameraOn = false;
        this.layout = 'grid';            // grid | speaker | focus | presentation
        this.quality = 'unknown';        // from LiveKit's real stats
        this.onStateChange = () => {};   // room.js hook → presence media_state
        this.onQualityChange = () => {}; // room.js hook → connection pill
        this.currentView = 'media';
        this._pipTrack = null;
        this._localAnalyser = null;
        this._localLevelRaf = null;
        this._localSpeakingUntil = 0;
        this.peerInfo = new Map();
        this._remotePermissionState = new WeakMap();
        this._screenShareOwner = null;
        this._retryDelay = 1000;
        this._retryTimer = null;
        this._retryAttempts = 0;
        this._closing = false;
        // Same intent-queue idea as the mesh engine: a second tap must land,
        // not be thrown away (see toggleMicrophone).
        this._wantMic = null;
        this._wantCamera = null;
        this._micBusy = false;
        this._cameraBusy = false;
        this._levelTrack = null;      // the track the analyser currently reads
        this._screenBusy = false;     // getDisplayMedia is in flight
    }

    async init(opts) {
        this.roomCode = opts.roomCode;
        this.currentIdentity = opts.currentIdentity;
        this.permissions = opts.permissions;
        this.onStateChange = opts.onStateChange || (() => {});
        this.onQualityChange = opts.onQualityChange || (() => {});
        // LiveKit keeps its own stats behind the SFU; the mesh measures every
        // peer locally.  The interface is the same so the panel is engine-agnostic.
        this.onNetStats = opts.onNetStats || (() => {});
        this.netStats = new Map();
        this.ownStats = null;
        const saved = localStorage.getItem(`room_layout_${opts.roomCode}`);
        if (saved && ['grid', 'speaker', 'focus', 'presentation'].includes(saved)) this.layout = saved;
        this.enabled = true;
        await this.connect();
    }

    async connect() {
        // The SFU client (~423 KB) is fetched on demand.  Asking for a token
        // first would waste one on a library we may never get, so this happens
        // before the fetch — and its failure is marked, so Media.init() can
        // fall back to a peer-to-peer room instead of a dead stage.
        try {
            await loadVendor('livekit');
        } catch (err) {
            const wrapped = new Error('livekit client unavailable');
            wrapped.vendorMissing = true;
            wrapped.cause = err;
            throw wrapped;
        }
        try {
            const res = await fetch(`/class/${this.roomCode}/media-token/`, {
                headers: { 'X-Requested-With': 'fetch' },
            });
            if (!res.ok) throw new Error(`token ${res.status}`);
            const { token, url } = await res.json();

            this.room = new (livekit().Room)({
                adaptiveStream: true,
                dynacast: true,
                publishDefaults: { simulcast: true },
            });
            this._wireEvents();
            await this.room.connect(url, token);
            this._retryDelay = 1000;
            this._retryAttempts = 0;
            this.localParticipant = this.room.localParticipant;
            document.getElementById('stage-empty-text').textContent =
                'برای فعال کردن دوربین/میکروفون از دکمه‌های پایین استفاده کنید.';
        } catch (err) {
            console.warn('[media] connect failed:', err);
            if (this.emptyEl) {
                document.getElementById('stage-empty-text').textContent =
                    'اتصال به سرور رسانه ناموفق بود — گفتگو و تخته فعال‌اند.';
            }
        }
    }

    _wireEvents() {
        const R = livekit().RoomEvent;
        this.room
            .on(R.ParticipantConnected, (p) => this._addTile(p))
            .on(R.ParticipantDisconnected, (p) => this._removeTile(p.identity))
            .on(R.TrackSubscribed, (track, pub, p) => this._attachTrack(p, track))
            .on(R.TrackUnsubscribed, (track, pub, p) => this._detachTrack(p, track))
            .on(R.TrackMuted, (track) => this._refreshTrackState(this._ownerOf(track)))
            .on(R.TrackUnmuted, (track, pub) => this._refreshTrackState(this._ownerOf(track)))
            .on(R.ActiveSpeakersChanged, (speakers) => this._setActiveSpeakers(speakers))
            .on(R.LocalTrackPublished, () => this._syncLocalUI())
            .on(R.LocalTrackUnpublished, () => this._syncLocalUI())
            .on(R.ConnectionQualityChanged, (quality, participant) => {
                // Real quality computed by LiveKit from WebRTC stats
                // (RTT, packet loss, bandwidth) — never a fake level.
                const isLocal = participant === this.room.localParticipant;
                if (isLocal) {
                    this.quality = String(quality || 'unknown');
                    this.onQualityChange(this.quality, null);
                } else if (participant) {
                    this.onQualityChange(String(quality || 'unknown'), participant.identity);
                }
            })
            .on(R.SignalReconnecting, () => this.onQualityChange('reconnecting', null))
            .on(R.SignalConnected, () => this.onQualityChange(this.quality, null))
            .on(R.Disconnected, () => this._scheduleReconnect())
            .on(R.MediaDevicesError, (e) => toast(`خطای دستگاه رسانه: ${e.message || ''}`, 'error'));
    }

    /** A device needs both the server grant and a clear moderator state. */
    _canUseMic() {
        return this.permissions.can_use_microphone !== false && this._mutedByHost !== true;
    }

    _canUseCam() {
        return this.permissions.can_use_camera !== false && this._cameraOffByHost !== true;
    }

    /** Recompute micOn/cameraOn from the publications (the source of truth). */
    _refreshLocalState() {
        if (!this.room || !this.localParticipant) return;
        this._refreshTrackState(this.localParticipant);
    }

    /** Persist + apply a stage layout. */
    setLayout(mode) {
        if (!['grid', 'speaker', 'focus', 'presentation'].includes(mode)) return;
        this.layout = mode;
        try { localStorage.setItem(`room_layout_${this.roomCode}`, mode); } catch (e) { /* private mode */ }
        this._layout();
    }

    _ownerOf(track) {
        // Resolve participant from a publication/track when possible.
        if (!this.room) return null;
        for (const p of [this.room.localParticipant, ...Array.from(this.room.remoteParticipants.values())]) {
            for (const pub of p.getTrackPublications().values()) {
                if (pub.track === track) return p;
            }
        }
        return null;
    }

    /** Apply live roster permissions to already subscribed remote tracks. */
    syncPeers(peers) {
        this.peerInfo = new Map((peers || []).filter((p) => p?.identity).map((p) => [p.identity, p]));
        if (!this.room) return;
        this.room.remoteParticipants.forEach((participant) => {
            this._syncRemotePermissions(participant);
            // Hands go up mid-lesson, so the badge follows the roster, not the track.
            const tile = this.tiles.get(participant.identity);
            tile?.querySelector('.t-hand')?.classList.toggle('on', Boolean(this.peerInfo.get(participant.identity)?.hand_raised));
        });
    }

    _remoteTrackAllowed(participant, track) {
        if (!participant || participant.identity === this.currentIdentity) return true;
        const peer = this.peerInfo.get(participant.identity);
        if (!peer) return true;
        const permissions = peer.permissions || {};
        const source = track?.source;
        const S = livekit().Track.Source;
        if (source === S.Microphone) {
            return permissions.can_use_microphone !== false && peer.muted !== true;
        }
        if (source === S.Camera) {
            return permissions.can_use_camera !== false && peer.camera_disabled !== true;
        }
        if (source === S.ScreenShare) {
            return permissions.can_share_screen !== false && peer.screen_sharing !== false;
        }
        return true;
    }

    _syncRemotePermissions(participant) {
        participant.getTrackPublications().forEach((publication) => {
            const track = publication.track;
            if (!track) return;
            const allowed = this._remoteTrackAllowed(participant, track);
            const previous = this._remotePermissionState.get(track);
            if (previous === allowed) return;
            if (track.mediaStreamTrack) track.mediaStreamTrack.enabled = allowed;
            this._remotePermissionState.set(track, allowed);
            if (!allowed) {
                track.detach();
                if (track.source === livekit().Track.Source.ScreenShare) {
                    this._hideScreenShare(participant.identity);
                }
                this._refreshTrackState(participant);
            } else if (previous === false) {
                // The track stayed subscribed while hidden; reattach it when
                // the owner grants the capability again.
                this._attachTrack(participant, track);
            }
        });
    }

    // -------------------------------------------------------------- tiles
    _tileFor(participant) {
        const identity = participant.identity;
        if (this.tiles.has(identity)) return this.tiles.get(identity);

        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.dataset.identity = identity;
        tile.tabIndex = 0;
        tile.setAttribute('role', 'button');
        tile.title = 'کلیک: پین کردن';

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        const isLocal = this.localParticipant && identity === this.localParticipant.identity;
        video.muted = isLocal;

        const overlay = document.createElement('div');
        overlay.className = 'tile-overlay';
        overlay.innerHTML = `
            <span class="tile-name"></span>
            <span class="tile-icons"><i class="t-mic" title="میکروفون"><svg class="ic"><use href="#i-mic"/></svg></i><i class="t-hand" title="دست بالا"><svg class="ic"><use href="#i-hand"/></svg></i></span>
            <button type="button" class="tile-fs" title="نمایش تمام‌صفحه" aria-label="نمایش تمام‌صفحه"><svg class="ic"><use href="#i-maximize"/></svg></button>`;

        const placeholder = document.createElement('div');
        placeholder.className = 'tile-placeholder';
        // The initial lives in its own span so CSS can draw the avatar disc
        // behind it (an absolutely-positioned ::before would paint on top).
        placeholder.innerHTML = '<span class="tile-initial"></span>';
        placeholder.querySelector('.tile-initial').textContent = (participant.name || participant.identity || '?').charAt(0);

        const speaking = document.createElement('span');
        speaking.className = 'tile-speaking';
        speaking.textContent = 'در حال صحبت';
        speaking.setAttribute('role', 'status');
        speaking.setAttribute('aria-label', 'در حال صحبت');
        speaking.setAttribute('aria-hidden', 'true');
        const level = document.createElement('span');
        level.className = 'tile-level';
        level.setAttribute('aria-hidden', 'true');
        level.innerHTML = '<i></i><i></i><i></i>';

        tile.append(video, placeholder, overlay, speaking, level);
        tile.addEventListener('click', () => this.togglePin(identity));
        tile.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.togglePin(identity); });
        overlay.querySelector('.tile-fs')?.addEventListener('click', (e) => {
            e.stopPropagation(); // don't trigger pin
            toggleTileFullscreen(tile);
        });

        this.tiles.set(identity, tile);
        if (isLocal) this.tilesEl.prepend(tile);
        else this.tilesEl.appendChild(tile);
        this._updateTileInfo(participant, tile);
        this._layout();
        return tile;
    }

    _updateTileInfo(participant, tile) {
        const name = participant.name || participant.identity;
        const isLocal = this.localParticipant && participant.identity === this.localParticipant.identity;
        tile.querySelector('.tile-name').textContent = isLocal ? `${name} (شما)` : name;
    }

    _addTile(participant) {
        const tile = this._tileFor(participant);
        // Attach any tracks already published.
        participant.getTrackPublications().forEach((pub) => {
            if (pub.track) this._attachTrack(participant, pub.track);
        });
        this._refreshTrackState(participant);
        return tile;
    }

    _removeTile(identity) {
        if (this._screenShareOwner === identity) this._hideScreenShare(identity);
        const tile = this.tiles.get(identity);
        if (tile) tile.remove();
        this.tiles.delete(identity);
        if (this.pinnedIdentity === identity) this.pinnedIdentity = null;
        this._layout();
    }

    _attachTrack(participant, track) {
        const allowed = this._remoteTrackAllowed(participant, track);
        this._remotePermissionState.set(track, allowed);
        if (!allowed) {
            if (track.mediaStreamTrack) track.mediaStreamTrack.enabled = false;
            track.detach();
            if (track.source === livekit().Track.Source.ScreenShare) {
                this._hideScreenShare(participant.identity);
            }
            this._refreshTrackState(participant);
            return;
        }
        if (track.mediaStreamTrack) track.mediaStreamTrack.enabled = true;
        const tile = this._tileFor(participant);
        const video = tile.querySelector('video');
        if (track.kind === 'video') {
            track.attach(video);
            video.style.display = '';
            tile.querySelector('.tile-placeholder').classList.add('hidden');
            if (track.source === livekit().Track.Source.ScreenShare) {
                this._showScreenShare(participant, video);
            }
        } else if (track.kind === 'audio') {
            track.attach(); // audio element managed internally
        }
        this._refreshTrackState(participant);
    }

    _detachTrack(participant, track) {
        if (!participant) return;
        track.detach();
        this._refreshTrackState(participant);
        if (track.source === livekit().Track.Source.ScreenShare) {
            this._hideScreenShare(participant.identity);
        }
    }

    _refreshTrackState(participant) {
        if (!participant) return;
        const tile = this.tiles.get(participant.identity);
        if (!tile) return;
        const micPub = participant.getTrackPublication(livekit().Track.Source.Microphone);
        const camPub = participant.getTrackPublication(livekit().Track.Source.Camera);
        const micOn = Boolean(
            micPub && micPub.track && !micPub.isMuted
            && this._remoteTrackAllowed(participant, micPub.track)
        );
        const camOn = Boolean(
            camPub && camPub.track && !camPub.isMuted
            && this._remoteTrackAllowed(participant, camPub.track)
        );
        tile.querySelector('.t-mic').classList.toggle('off', !micOn);
        tile.querySelector('.t-hand')?.classList.toggle(
            'on', Boolean(this.peerInfo.get(participant.identity)?.hand_raised),
        );
        tile.querySelector('video').style.display = camOn ? '' : 'none';
        tile.querySelector('.tile-placeholder').classList.toggle('hidden', camOn);
        // A participant with neither microphone nor camera on contributes
        // nothing to the stage. A wall of grey avatars is exactly what made
        // the room look broken, so idle people leave the grid — the tile and
        // its live tracks stay in the DOM, so video resumes instantly.
        tile.classList.toggle('is-idle', !micOn && !camOn);
        this._layout();
        if (this.localParticipant && participant.identity === this.localParticipant.identity) {
            this.micOn = micOn;
            this.cameraOn = camOn;
            this._syncLocalUI();
            this.onStateChange({ mic_on: micOn, camera_on: camOn });
        }
    }

    /**
     * LiveKit reports its own active-speaker list; paint it with the same
     * stability rules as the mesh engine.
     *
     * * a speaker stays "speaking" for a short hold after the last frame that
     *   reported them, so the ring and the badge do not blink between words;
     * * our own tile is left alone — the local analyser loop owns it, and two
     *   painters arguing over one tile is exactly the flicker this replaces.
     */
    _setActiveSpeakers(participants = []) {
        const speakers = new Set((participants || []).map((p) => p?.identity).filter(Boolean));
        this.activeSpeaker = participants?.[0]?.identity || null;
        const now = performance.now();
        this._speakingUntil = this._speakingUntil || new Map();
        this.tiles.forEach((tile, identity) => {
            if (identity === this.currentIdentity) return;
            if (speakers.has(identity)) this._speakingUntil.set(identity, now + 700);
            const speaking = now < (this._speakingUntil.get(identity) || 0);
            const participant = this.room?.remoteParticipants?.get(identity);
            const reported = Number(participant?.audioLevel) || 0;
            paintTile(tile, speaking ? Math.max(0.22, Math.min(1, reported)) : 0, speaking);
        });
        this._layout();
        this.updatePip(this.currentView); // pip follows the speaker
    }

    // ------------------------------------------------- picture-in-picture
    /** Floating camera for full-stage views — see mesh.js updatePip. */
    updatePip(view) {
        if (view) this.currentView = view;
        const pip = document.getElementById('cam-pip');
        const vid = document.getElementById('cam-pip-video');
        const label = document.getElementById('cam-pip-label');
        if (!pip || !vid) return;
        const pipViews = ['whiteboard', 'presentation', 'screen'];
        if (!pipViews.includes(this.currentView) || !this.room) {
            pip.classList.add('hidden');
            vid.srcObject = null;
            this._pipTrack = null;
            return;
        }
        let track = null;
        let name = '';
        const myPub = this.localParticipant
            && this.localParticipant.getTrackPublication(livekit().Track.Source.Camera);
        if (this.cameraOn && myPub && myPub.track) {
            track = myPub.track.mediaStreamTrack;
            name = `${this.localParticipant.name || ''} (شما)`;
            vid.muted = true;
        } else if (this.activeSpeaker && this.activeSpeaker !== (this.localParticipant && this.localParticipant.identity)) {
            const p = this.room.remoteParticipants.get(this.activeSpeaker);
            const pub = p && p.getTrackPublication(livekit().Track.Source.Camera);
            if (pub && pub.track) {
                track = pub.track.mediaStreamTrack;
                name = p.name || '';
                vid.muted = false;
            }
        }
        if (!track) {
            pip.classList.add('hidden');
            vid.srcObject = null;
            this._pipTrack = null;
            return;
        }
        if (this._pipTrack !== track) {
            vid.srcObject = new MediaStream([track]);
            this._pipTrack = track;
        }
        if (label) label.textContent = name;
        pip.classList.remove('hidden');
        vid.play().catch(() => {});
    }

    // ------------------------------------------------- local mic meter
    /**
     * Meter our own microphone from real samples.
     *
     * The shaping (RMS → dB → envelope → quantisation) and the speaking gate
     * live in meter.js so the LiveKit engine and the mesh engine behave
     * identically; this method only owns the analyser and the frame loop.
     */
    _startLocalLevel() {
        const pub = this.localParticipant
            && this.localParticipant.getTrackPublication(livekit().Track.Source.Microphone);
        const track = pub && pub.track && pub.track.mediaStreamTrack;
        if (!track) return;
        // Already metering this exact track: tearing the analyser down and
        // building a new one on every roster event made the meter jump back to
        // zero for a frame — a visible flicker for no reason.
        if (this._levelTrack === track && this._stopLevelLoop) return;
        this._stopLocalLevel();
        this._localAnalyser = createAnalyser(new MediaStream([track]));
        if (!this._localAnalyser) return;
        const tracker = createLevelTracker(this._localAnalyser);
        const gate = createSpeakingGate();
        this._localTracker = tracker;
        this._localGate = gate;
        this._levelTrack = track;
        this._stopLevelLoop = startLevelLoop((now) => {
            if (!this.micOn) return;
            const level = tracker.read();
            const speaking = gate.update(level, now);
            paintMic(level, speaking);
            const identity = this.localParticipant && this.localParticipant.identity;
            if (identity) paintTile(this.tiles.get(identity), level, speaking);
        });
    }

    _stopLocalLevel() {
        if (this._stopLevelLoop) this._stopLevelLoop();
        this._stopLevelLoop = null;
        disposeAnalyser(this._localAnalyser);
        this._localAnalyser = null;
        this._localTracker = null;
        this._localGate = null;
        this._levelTrack = null;
        resetMic();
        const identity = this.localParticipant && this.localParticipant.identity;
        if (identity) paintTile(this.tiles.get(identity), 0, false);
    }

    togglePin(identity) {
        this.pinnedIdentity = this.pinnedIdentity === identity ? null : identity;
        this._layout();
    }

    /** Off-stage for anyone the roster reports without mic and without camera. */
    syncStagePresence(peers) {
        const live = new Map((peers || []).map(
            (p) => [p.identity, Boolean(p.mic_on) || Boolean(p.camera_on)]));
        let touched = false;
        this.tiles.forEach((tile, identity) => {
            const on = live.get(identity);
            if (on === undefined) return;          // not in the roster yet
            const idle = !on;
            if (tile.classList.contains('is-idle') !== idle) touched = true;
            tile.classList.toggle('is-idle', idle);
        });
        if (touched) this._layout();
    }

    _layout() {
        // Only tiles that are actually on stage count towards the grid: idle
        // participants (mic off *and* camera off) are .is-idle and hidden.
        const shown = [];
        this.tiles.forEach((tile, identity) => {
            if (!tile.classList.contains('is-idle')) shown.push(identity);
        });
        const count = shown.length;
        this.tilesEl.dataset.count = String(Math.max(count, 1));
        this.tilesEl.dataset.layout = this.layout;

        // Which participant dominates the stage in each mode:
        // grid → none; speaker/focus/presentation → pinned or active speaker.
        let focus = null;
        if (this.layout === 'grid') {
            focus = this.pinnedIdentity || null; // explicit pin still honoured
        } else {
            focus = this.pinnedIdentity || this.activeSpeaker || null;
        }
        if (focus && !shown.includes(focus)) focus = null;

        this.tilesEl.classList.toggle('has-focus', Boolean(focus));
        this.tiles.forEach((tile, identity) => {
            const onStage = shown.includes(identity);
            tile.classList.toggle('focus', onStage && identity === focus);
            tile.classList.toggle('mini', onStage && Boolean(focus) && identity !== focus);
            // Focus changes tile sizes only; it never hides a participant's
            // live camera. Visibility is controlled by media permissions.
        });
        this.emptyEl.classList.toggle('hidden', count > 0);
        this._emptyReason(count);
    }

    /** Explain an empty stage instead of showing a bare placeholder. */
    _emptyReason(count) {
        if (count > 0 || !this.emptyEl) return;
        const el = document.getElementById('stage-empty-text');
        if (!el) return;
        if (this.tiles.size > 0) {
            el.textContent = 'فعلاً کسی دوربین یا میکروفون روشن نکرده است.';
            this.emptyEl.dataset.reason = 'idle';
        }
    }

    // ------------------------------------------------------- screen share
    _showScreenShare(participant, video) {
        const holder = document.getElementById('screen-holder');
        const owner = document.getElementById('screen-owner');
        this._screenShareOwner = participant.identity;
        holder.innerHTML = '';
        video.classList.add('screen-video');
        holder.appendChild(video);
        owner.textContent = `${participant.name || participant.identity} صفحه خود را به اشتراک گذاشته است`;
        document.querySelector('.room-controls')?.classList.add('screen-active');
        this._switchView('screen');
    }

    _hideScreenShare(identity = null) {
        if (identity && this._screenShareOwner !== identity) return;
        const holder = document.getElementById('screen-holder');
        if (holder.firstChild) {
            // Move the video back to its tile.
            const video = holder.firstChild;
            holder.innerHTML = '';
            const tile = this.tiles.get(video.closest?.('.tile')?.dataset?.identity);
            if (tile) tile.querySelector('video').replaceWith(video);
        }
        document.querySelector('.room-controls')?.classList.remove('screen-active');
        this._screenShareOwner = null;
        if (document.getElementById('view-screen').classList.contains('hidden') === false) {
            this._switchView('media');
        }
    }

    _switchView(view) {
        for (const id of ['media', 'screen', 'whiteboard', 'presentation']) {
            document.getElementById(`view-${id}`).classList.toggle('hidden', id !== view);
        }
        this.currentView = view;
    }

    // ------------------------------------------------------- local controls
    /**
     * Turning a device on is asynchronous; a second tap while the first is
     * still in flight used to be swallowed, leaving the button in a state the
     * user did not ask for.  Keep the *last* intent and drain it in order.
     */
    async toggleMicrophone() {
        if (!this.enabled || !this.room) {
            toast('سرور رسانه پیکربندی نشده است — صدا/تصویر در دسترس نیست.', 'warning');
            return false;
        }
        if (!this._canUseMic()) {
            toast(this._mutedByHost
                ? 'میکروفون شما توسط مدیر بی‌صدا شده است.'
                : 'شما اجازهٔ استفاده از میکروفون را ندارید.', 'warning');
            return false;
        }
        // Aim at the pending intent, not at `micOn` (which is still the old
        // value while the previous toggle is in flight, so a second tap would
        // otherwise repeat «on» instead of asking for «off»).
        const target = this._wantMic !== null ? this._wantMic : this.micOn;
        this._wantMic = !target;
        return this._drainMic();
    }

    async _drainMic() {
        if (this._micBusy) return true;    // the running loop picks the intent up
        this._micBusy = true;
        try {
            while (this._wantMic !== null && this._wantMic !== this.micOn) {
                const desired = this._wantMic;
                this._wantMic = null;
                if (!this.room?.localParticipant) break;
                await this.room.localParticipant.setMicrophoneEnabled(desired);
                this._refreshLocalState();
            }
        } catch (err) {
            console.warn('[media] microphone toggle failed:', err);
            toast('تغییر وضعیت میکروفون اعمال نشد.', 'error');
        } finally {
            this._micBusy = false;
        }
        this._syncLocalUI();
        return true;
    }

    async toggleCamera() {
        if (!this.enabled || !this.room) {
            toast('سرور رسانه پیکربندی نشده است — صدا/تصویر در دسترس نیست.', 'warning');
            return false;
        }
        if (!this._canUseCam()) {
            toast(this._cameraOffByHost
                ? 'دوربین شما توسط مدیر غیرفعال شده است.'
                : 'شما اجازهٔ استفاده از دوربین را ندارید.', 'warning');
            return false;
        }
        const target = this._wantCamera !== null ? this._wantCamera : this.cameraOn;
        this._wantCamera = !target;
        return this._drainCamera();
    }

    async _drainCamera() {
        if (this._cameraBusy) return true;
        this._cameraBusy = true;
        try {
            while (this._wantCamera !== null && this._wantCamera !== this.cameraOn) {
                const desired = this._wantCamera;
                this._wantCamera = null;
                if (!this.room?.localParticipant) break;
                // Ask for a 16:9 capture on every device.  Without this, a
                // phone and a laptop hand back frames with different aspect
                // ratios and the same room looks like two different shots.
                await this.room.localParticipant.setCameraEnabled(
                    desired,
                    desired ? CAMERA_CAPTURE : undefined,
                );
                this._refreshLocalState();
            }
        } catch (err) {
            console.warn('[media] camera toggle failed:', err);
            toast('تغییر وضعیت دوربین اعمال نشد.', 'error');
        } finally {
            this._cameraBusy = false;
        }
        if (this.cameraOn) this._addTile(this.room.localParticipant);
        this._syncLocalUI();
        return true;
    }

    async switchCamera() {
        if (!this.enabled || !this.room) return;
        const pub = this.room.localParticipant.getTrackPublication(livekit().Track.Source.Camera);
        if (pub?.track) {
            await pub.track.switchActiveDevice('videoinput');
        }
    }

    async toggleScreenShare() {
        if (!this.enabled || !this.room) {
            toast('سرور رسانه پیکربندی نشده است — اشتراک صفحه در دسترس نیست.', 'warning');
            return false;
        }
        if (!this.permissions.can_share_screen) {
            toast('شما اجازهٔ اشتراک صفحه را ندارید.', 'warning');
            return false;
        }
        // The picker is modal: a second tap while it is open cannot mean
        // anything, so it is ignored instead of queuing a second dialog.
        if (this._screenBusy) return true;
        this._screenBusy = true;
        try {
            const pub = this.room.localParticipant.getTrackPublication(livekit().Track.Source.ScreenShare);
            if (pub?.track) await this.room.localParticipant.setScreenShareEnabled(false);
            else await this.room.localParticipant.setScreenShareEnabled(true);
        } catch (err) {
            console.warn('[media] screen share toggle failed:', err);
        } finally {
            this._screenBusy = false;
            this._syncLocalUI();
        }
        return true;
    }

    /** Stop an active screen share (used when the host revokes the right). */
    async stopScreenShare() {
        if (!this.enabled || !this.room) return;
        const pub = this.room.localParticipant.getTrackPublication(livekit().Track.Source.ScreenShare);
        if (pub?.track) await this.room.localParticipant.setScreenShareEnabled(false);
    }

    async setMicDevice(deviceId) {
        if (this.room) await this.room.switchActiveDevice('audioinput', deviceId);
    }

    async setCameraDevice(deviceId) {
        if (this.room) await this.room.switchActiveDevice('videoinput', deviceId);
    }

    async setOutputDevice(deviceId) {
        // Supported only in some browsers; fails silently elsewhere.
        if (!deviceId) return false;
        const supported = typeof HTMLAudioElement !== 'undefined' && 'setSinkId' in HTMLAudioElement.prototype;
        if (!supported) return false;
        this._sinkId = deviceId;   // applied to audio elements created later too
        const audios = document.querySelectorAll('audio');
        for (const a of audios) {
            if (a.setSinkId) { try { await a.setSinkId(deviceId); } catch (e) { /* unsupported */ } }
        }
        return true;
    }

    /** Enforced when the host mutes us: the SFU token no longer allows it
     *  on rejoin, and we cut the track immediately for responsiveness. */
    async forceMute() {
        this._wantMic = null;                 // a pending «on» must not win
        if (this.enabled && this.room && this.micOn) {
            try { await this.room.localParticipant.setMicrophoneEnabled(false); } catch (e) { /* gone */ }
            this._refreshLocalState();
        }
        this._syncLocalUI();
    }

    async forceCameraOff() {
        this._wantCamera = null;
        if (this.enabled && this.room && this.cameraOn) {
            try { await this.room.localParticipant.setCameraEnabled(false); } catch (e) { /* gone */ }
            this._refreshLocalState();
        }
        this._syncLocalUI();
    }

    _syncLocalUI() {
        const micBtn = document.getElementById('btn-mic');
        const camBtn = document.getElementById('btn-camera');
        if (micBtn) {
            micBtn.classList.toggle('active', this.micOn);
            micBtn.classList.toggle('off', !this._canUseMic());
            micBtn.setAttribute('aria-pressed', String(this.micOn));
        }
        if (camBtn) {
            camBtn.classList.toggle('active', this.cameraOn);
            camBtn.classList.toggle('off', !this._canUseCam());
            camBtn.setAttribute('aria-pressed', String(this.cameraOn));
        }
        // Keep the live mic meter on the *current* track.  The old guard tested
        // a flag nothing ever assigned, so every UI sync rebuilt the analyser
        // and the meter visibly dropped to zero.
        const micPub = this.localParticipant
            && this.localParticipant.getTrackPublication(livekit().Track.Source.Microphone);
        const micTrack = micPub && micPub.track && micPub.track.mediaStreamTrack;
        if (this.micOn && micTrack) this._startLocalLevel();
        else if (this._levelTrack) this._stopLocalLevel();
    }

    /** Called by room.js when the roster reports our forced states. */
    applyModerationState({ muted, camera_disabled } = {}) {
        // The moderator's decision is kept apart from the server's grant: the
        // old code wrote `permissions.can_use_*` here, which made a later
        // re-grant invisible until a reload (the same object is the room's
        // PERMISSIONS map).  `_canUseMic()` combines both.
        this._mutedByHost = Boolean(muted);
        this._cameraOffByHost = Boolean(camera_disabled);
        if (muted) this.forceMute();
        if (camera_disabled) this.forceCameraOff();
        this._syncLocalUI();
    }

    async listDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return [];
        return navigator.mediaDevices.enumerateDevices();
    }

    /**
     * A media token expires on purpose (it is the only thing that carries the
     * publish grants), so a long lesson can outlive it.  Re-fetching a token
     * and rejoining also picks up any permission change the host made while we
     * were connected.
     */
    _scheduleReconnect() {
        if (this._closing || !this.enabled) return;
        clearTimeout(this._retryTimer);
        // Say it once.  A lesson that is offline for ten minutes used to show
        // ten identical toasts, one per backoff step.
        if (!this._retryAttempts) {
            toast('اتصال رسانه قطع شد؛ در حال تلاش مجدد…', 'warning');
        }
        this._retryAttempts += 1;
        this._retryTimer = setTimeout(async () => {
            if (this._closing || !this.enabled) return;
            const wasMic = this.micOn;
            const wasCamera = this.cameraOn;
            try {
                await this.connect();
                // Restore what the participant had on, if the new token allows it.
                if (this.room && wasMic && !this.micOn) await this.toggleMicrophone();
                if (this.room && wasCamera && !this.cameraOn) await this.toggleCamera();
            } catch (err) {
                console.warn('[media] reconnect failed', err);
            }
            this._retryDelay = Math.min(this._retryDelay * 2, 15000);
            if (!this.room || this.room.state !== livekit().ConnectionState.Connected) {
                this._retryTimer = setTimeout(() => this._scheduleReconnect(), this._retryDelay);
            }
        }, this._retryDelay);
    }

    disconnect() {
        this._closing = true;
        this.enabled = false;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        this._stopLocalLevel();
        this._pipTrack = null;
        const pip = document.getElementById('cam-pip-video');
        if (pip) pip.srcObject = null;
        try { this.room?.disconnect(); } catch (e) { /* already gone */ }
        this.room = null;
        this.localParticipant = null;
    }
}

const livekitMedia = new LivekitMedia();

/**
 * Facade: picks the engine once at init and forwards the room.js API.
 */
class MediaFacade {
    constructor() {
        this.impl = null;
        this.engine = 'none';
        this._onState = () => {};
        this._lastStateKey = null;     // last state the server has been told
        this._pendingState = null;
        this._stateTimer = null;
        this._flushBound = false;
    }

    get quality() { return this.impl ? this.impl.quality : 'unknown'; }
    get layout() { return this.impl ? this.impl.layout : 'grid'; }
    /** Per-peer measured network rows (mesh) or an empty map (SFU). */
    get netStats() { return (this.impl && this.impl.netStats) || new Map(); }
    /** Our own aggregated row (worst of all links). */
    get ownStats() { return (this.impl && this.impl.ownStats) || null; }

    /**
     * Every engine announces its state through here, so dedupe and coalescing
     * are one rule instead of two copies (mesh and LiveKit both use it).
     */
    _emitState(state) {
        const next = {
            mic_on: Boolean(state && state.mic_on),
            camera_on: Boolean(state && state.camera_on),
            screen_sharing: Boolean(state && state.screen_sharing),
        };
        const key = `${next.mic_on}|${next.camera_on}|${next.screen_sharing}`;
        if (key === this._lastStateKey) return;   // nothing actually changed
        this._lastStateKey = key;
        this._pendingState = next;
        if (this._stateTimer) return;             // already scheduled
        this._stateTimer = setTimeout(() => this._flushState(), MEDIA_STATE_COALESCE_MS);
    }

    _flushState() {
        if (this._stateTimer) { clearTimeout(this._stateTimer); this._stateTimer = null; }
        const state = this._pendingState;
        this._pendingState = null;
        if (!state) return;
        try { this._onState(state); } catch (err) { console.warn('[media] state emit failed', err); }
    }

    async init(opts) {
        this._onState = opts.onStateChange || (() => {});
        this._lastStateKey = null;
        if (!this._flushBound && typeof document !== 'undefined') {
            // A background tab must not sit on the last state: flush before the
            // phone locks or the tab is frozen, otherwise peers keep showing a
            // microphone that is already off.
            this._flushBound = true;
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) this._flushState();
            });
            window.addEventListener('pagehide', () => this._flushState());
        }
        const engineOpts = { ...opts, onStateChange: (state) => this._emitState(state) };
        // The engine is chosen from the server's configuration alone; whether
        // the client library has arrived yet is not its business any more.
        if (opts.mediaEnabled && opts.mediaUrl) {
            this.engine = 'livekit';
            this.impl = livekitMedia;
        } else if (opts.meshEnabled) {
            this.engine = 'mesh';
            this.impl = new MeshMedia();
        } else {
            this.engine = 'none';
            this.impl = null;
            console.warn('[media] unavailable: LiveKit client/config missing and mesh disabled');
            return;
        }
        try {
            await this.impl.init(engineOpts);
        } catch (err) {
            console.warn(`[media:${this.engine}] init failed:`, err);
            // The payment for a lazy library is that it can fail to arrive.  A
            // peer-to-peer room is a degraded lesson; an empty stage is a lost
            // one — so fall back when the mesh is allowed here.
            if (this.engine === 'livekit' && err && err.vendorMissing && opts.meshEnabled) {
                console.warn('[media] falling back to the peer-to-peer engine');
                this.engine = 'mesh';
                this.impl = new MeshMedia();
                try {
                    await this.impl.init(engineOpts);
                } catch (meshErr) {
                    console.warn('[media:mesh] init failed:', meshErr);
                    this.engine = 'none';
                    this.impl = null;
                }
            }
        }
    }

    /**
     * Re-announce the local mic/camera/screen state to the roster.
     *
     * The server ties media state to the socket, so a reconnect starts from
     * "nothing known" — without this every peer sees the participant as
     * silent until they touch a device button again.
     */
    pushMediaState() {
        if (!this.impl) return false;
        // Forced: after a socket reconnect the server has no memory of us, so
        // an identical state still has to be announced (once).
        this._lastStateKey = null;
        this._pendingState = {
            mic_on: Boolean(this.impl.micOn),
            camera_on: Boolean(this.impl.cameraOn),
            screen_sharing: Boolean(this.impl.screenStream),
        };
        this._flushState();
        return true;
    }

    /** Keep roster-driven permission gates current in either media engine. */
    syncPeers(peers) { if (this.impl && this.impl.syncPeers) this.impl.syncPeers(peers); }
    handleSignal(msg) { if (this.impl && this.impl.handleSignal) this.impl.handleSignal(msg); }

    setLayout(mode) { if (this.impl) this.impl.setLayout(mode); }
    updatePip(view) { if (this.impl && this.impl.updatePip) this.impl.updatePip(view); }
    async toggleMicrophone() { return this.impl ? this.impl.toggleMicrophone() : false; }
    async toggleCamera() { return this.impl ? this.impl.toggleCamera() : false; }
    async toggleScreenShare() { return this.impl ? this.impl.toggleScreenShare() : false; }
    async forceMute() { return this.impl && this.impl.forceMute(); }
    async forceCameraOff() { return this.impl && this.impl.forceCameraOff(); }
    /** Forced stop (host revoked can_share_screen) — bypasses the grant check. */
    async stopScreenShare() { return this.impl && this.impl.stopScreenShare && this.impl.stopScreenShare(); }
    /** Roster says who currently has a live mic or camera — see syncStagePresence. */
    syncStagePresence(peers) { if (this.impl && this.impl.syncStagePresence) this.impl.syncStagePresence(peers); }
    /** Roster media_state hook (mesh: hide a stopped remote screen view). */
    notifyPeerState(p) { if (this.impl && this.impl.onPeerMediaState) this.impl.onPeerMediaState(p); }
    applyModerationState(state) { if (this.impl && this.impl.applyModerationState) this.impl.applyModerationState(state); }
    dispose() {
        this._flushState();
        this._lastStateKey = null;
        if (this.impl && this.impl.dispose) this.impl.dispose();
    }
    onDeviceChange(fn) { if (this.impl) this.impl.onDeviceChange = fn; }
    retryPeer(identity) { if (this.impl && this.impl.retryPeer) this.impl.retryPeer(identity); }
    /** Network came back: let the media engine restart dead peer links. */
    onNetworkOnline() { if (this.impl && this.impl.onNetworkOnline) this.impl.onNetworkOnline(); }
    async setMicDevice(id) { return this.impl && this.impl.setMicDevice(id); }
    async setCameraDevice(id) { return this.impl && this.impl.setCameraDevice(id); }
    async setOutputDevice(id) { return this.impl && this.impl.setOutputDevice(id); }
    async listDevices() { return this.impl ? this.impl.listDevices() : []; }
}

export const Media = new MediaFacade();
