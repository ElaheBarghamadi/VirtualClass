/**
 * media.js — classroom media transport.
 *
 * Two interchangeable engines behind one API:
 *  1. LiveKit SFU  — used when the server is configured (recommended for
 *     larger rooms; Django issues short-lived scoped tokens).
 *  2. P2P mesh     — automatic fallback so mic/camera/screen keep working
 *     with zero external infrastructure (see mesh.js; Django only relays
 *     signalling envelopes, never media).
 *
 * Media never passes through Django WebSockets in either mode.
 */
import { toast } from './toast.js';
import { MeshMedia } from './mesh.js';
import { analyserLevel, createAnalyser, disposeAnalyser } from './meter.js';

const LivekitClient = window.LivekitClient;

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
        this._pipView = null;
        this._pipClosed = false;
        this._pipTrack = null;
        this._localAnalyser = null;
        this._localLevelRaf = null;
    }

    async init(opts) {
        this.roomCode = opts.roomCode;
        this.currentIdentity = opts.currentIdentity;
        this.permissions = opts.permissions;
        this.onStateChange = opts.onStateChange || (() => {});
        this.onQualityChange = opts.onQualityChange || (() => {});
        const saved = localStorage.getItem(`room_layout_${opts.roomCode}`);
        if (saved && ['grid', 'speaker', 'focus', 'presentation'].includes(saved)) this.layout = saved;
        this.enabled = true;
        await this.connect();
    }

    async connect() {
        try {
            const res = await fetch(`/class/${this.roomCode}/media-token/`, {
                headers: { 'X-Requested-With': 'fetch' },
            });
            if (!res.ok) throw new Error(`token ${res.status}`);
            const { token, url } = await res.json();

            this.room = new LivekitClient.Room({
                adaptiveStream: true,
                dynacast: true,
                publishDefaults: { simulcast: true },
            });
            this._wireEvents();
            await this.room.connect(url, token);
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
        const R = LivekitClient.RoomEvent;
        this.room
            .on(R.ParticipantConnected, (p) => this._addTile(p))
            .on(R.ParticipantDisconnected, (p) => this._removeTile(p.identity))
            .on(R.TrackSubscribed, (track, pub, p) => this._attachTrack(p, track))
            .on(R.TrackUnsubscribed, (track, pub, p) => this._detachTrack(p, track))
            .on(R.TrackMuted, (track, pub) => this._refreshTrackState(pub?.source && this._ownerOf(track)))
            .on(R.TrackUnmuted, (track, pub) => this._refreshTrackState(this._ownerOf(track)))
            .on(R.ActiveSpeakersChanged, (speakers) => this._setActiveSpeaker(speakers[0]))
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
            .on(R.Disconnected, () => toast('اتصال رسانه قطع شد؛ در حال تلاش مجدد…', 'warning'))
            .on(R.MediaDevicesError, (e) => toast(`خطای دستگاه رسانه: ${e.message || ''}`, 'error'));
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
            <span class="tile-icons"><i class="t-mic" title="میکروفون">🎤</i><i class="t-hand" title="دست بالا">✋</i></span>
            <button type="button" class="tile-fs" title="نمایش تمام‌صفحه" aria-label="نمایش تمام‌صفحه">⛶</button>`;

        const placeholder = document.createElement('div');
        placeholder.className = 'tile-placeholder';
        placeholder.textContent = (participant.name || participant.identity || '?').charAt(0);

        tile.append(video, placeholder, overlay);
        tile.addEventListener('click', () => this.togglePin(identity));
        tile.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.togglePin(identity); });
        overlay.querySelector('.tile-fs')?.addEventListener('click', (e) => {
            e.stopPropagation(); // don't trigger pin
            toggleTileFullscreen(tile);
        });

        this.tiles.set(identity, tile);
        this.tilesEl.appendChild(tile);
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
        const tile = this.tiles.get(identity);
        if (tile) tile.remove();
        this.tiles.delete(identity);
        if (this.pinnedIdentity === identity) this.pinnedIdentity = null;
        this._layout();
    }

    _attachTrack(participant, track) {
        const tile = this._tileFor(participant);
        const video = tile.querySelector('video');
        if (track.kind === 'video') {
            track.attach(video);
            video.style.display = '';
            tile.querySelector('.tile-placeholder').classList.add('hidden');
            if (track.source === LivekitClient.Track.Source.ScreenShare) {
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
        if (track.source === LivekitClient.Track.Source.ScreenShare) {
            this._hideScreenShare();
        }
    }

    _refreshTrackState(participant) {
        if (!participant) return;
        const tile = this.tiles.get(participant.identity);
        if (!tile) return;
        const micPub = participant.getTrackPublication(LivekitClient.Track.Source.Microphone);
        const camPub = participant.getTrackPublication(LivekitClient.Track.Source.Camera);
        const micOn = Boolean(micPub && micPub.track && !micPub.isMuted);
        const camOn = Boolean(camPub && camPub.track && !camPub.isMuted);
        tile.querySelector('.t-mic').classList.toggle('off', !micOn);
        tile.querySelector('video').style.display = camOn ? '' : 'none';
        tile.querySelector('.tile-placeholder').classList.toggle('hidden', camOn);
        if (this.localParticipant && participant.identity === this.localParticipant.identity) {
            this.micOn = micOn;
            this.cameraOn = camOn;
            this._syncLocalUI();
            this.onStateChange({ mic_on: micOn, camera_on: camOn });
        }
    }

    _setActiveSpeaker(participant) {
        this.activeSpeaker = participant ? participant.identity : null;
        this.tiles.forEach((tile, identity) => {
            tile.classList.toggle('speaking', identity === this.activeSpeaker);
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
        if (this.currentView !== this._pipView) {
            this._pipView = this.currentView;
            this._pipClosed = false;
        }
        const pipViews = ['whiteboard', 'presentation', 'screen'];
        if (!pipViews.includes(this.currentView) || this._pipClosed || !this.room) {
            pip.classList.add('hidden');
            vid.srcObject = null;
            this._pipTrack = null;
            return;
        }
        let track = null;
        let name = '';
        const myPub = this.localParticipant
            && this.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
        if (this.cameraOn && myPub && myPub.track) {
            track = myPub.track.mediaStreamTrack;
            name = `${this.localParticipant.name || ''} (شما)`;
            vid.muted = true;
        } else if (this.activeSpeaker && this.activeSpeaker !== (this.localParticipant && this.localParticipant.identity)) {
            const p = this.room.remoteParticipants.get(this.activeSpeaker);
            const pub = p && p.getTrackPublication(LivekitClient.Track.Source.Camera);
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

    closePip() {
        this._pipClosed = true;
        this.updatePip(this.currentView);
    }

    // ------------------------------------------------- local mic meter
    _startLocalLevel() {
        this._stopLocalLevel();
        const pub = this.localParticipant
            && this.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
        const track = pub && pub.track && pub.track.mediaStreamTrack;
        if (!track) return;
        this._localAnalyser = createAnalyser(new MediaStream([track]));
        if (!this._localAnalyser) return;
        const tick = () => {
            if (!this.micOn) return;
            const level = analyserLevel(this._localAnalyser);
            const btn = document.getElementById('btn-mic');
            if (btn) btn.style.setProperty('--mic-level', level.toFixed(3));
            const tile = this.localParticipant && this.tiles.get(this.localParticipant.identity);
            if (tile) {
                tile.style.setProperty('--lvl', level.toFixed(3));
                tile.classList.toggle('speaking', level > 0.06);
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
        const btn = document.getElementById('btn-mic');
        if (btn) btn.style.setProperty('--mic-level', '0');
    }

    togglePin(identity) {
        this.pinnedIdentity = this.pinnedIdentity === identity ? null : identity;
        this._layout();
    }

    _layout() {
        const count = this.tiles.size;
        this.tilesEl.dataset.count = String(count);
        this.tilesEl.dataset.layout = this.layout;

        // Which participant dominates the stage in each mode:
        // grid → none; speaker/focus/presentation → pinned or active speaker.
        let focus = null;
        if (this.layout === 'grid') {
            focus = this.pinnedIdentity || null; // explicit pin still honoured
        } else {
            focus = this.pinnedIdentity || this.activeSpeaker || null;
        }

        this.tilesEl.classList.toggle('has-focus', Boolean(focus));
        const hideStrips = this.layout === 'focus';
        this.tiles.forEach((tile, identity) => {
            tile.classList.toggle('focus', identity === focus);
            tile.classList.toggle('mini', Boolean(focus) && identity !== focus);
            tile.classList.toggle('strip-hidden', hideStrips && identity !== focus);
        });
        this.emptyEl.classList.toggle('hidden', count > 0);
    }

    // ------------------------------------------------------- screen share
    _showScreenShare(participant, video) {
        const holder = document.getElementById('screen-holder');
        const owner = document.getElementById('screen-owner');
        holder.innerHTML = '';
        video.classList.add('screen-video');
        holder.appendChild(video);
        owner.textContent = `${participant.name || participant.identity} صفحه خود را به اشتراک گذاشته است`;
        document.querySelector('.room-controls')?.classList.add('screen-active');
        this._switchView('screen');
    }

    _hideScreenShare() {
        const holder = document.getElementById('screen-holder');
        if (holder.firstChild) {
            // Move the video back to its tile.
            const video = holder.firstChild;
            holder.innerHTML = '';
            const tile = this.tiles.get(video.closest?.('.tile')?.dataset?.identity);
            if (tile) tile.querySelector('video').replaceWith(video);
        }
        document.querySelector('.room-controls')?.classList.remove('screen-active');
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
    async toggleMicrophone() {
        if (!this.enabled || !this.room) {
            toast('سرور رسانه پیکربندی نشده است — صدا/تصویر در دسترس نیست.', 'warning');
            return false;
        }
        if (!this.permissions.can_use_microphone) {
            toast('شما اجازهٔ استفاده از میکروفون را ندارید.', 'warning');
            return false;
        }
        await this.room.localParticipant.setMicrophoneEnabled(!this.micOn);
        this._syncLocalUI();
        return true;
    }

    async toggleCamera() {
        if (!this.enabled || !this.room) {
            toast('سرور رسانه پیکربندی نشده است — صدا/تصویر در دسترس نیست.', 'warning');
            return false;
        }
        if (!this.permissions.can_use_camera) {
            toast('شما اجازهٔ استفاده از دوربین را ندارید.', 'warning');
            return false;
        }
        await this.room.localParticipant.setCameraEnabled(!this.cameraOn);
        if (this.cameraOn) this._addTile(this.room.localParticipant);
        this._syncLocalUI();
        return true;
    }

    async switchCamera() {
        if (!this.enabled || !this.room) return;
        const pub = this.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
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
        const pub = this.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
        if (pub?.track) {
            await this.room.localParticipant.setScreenShareEnabled(false);
        } else {
            await this.room.localParticipant.setScreenShareEnabled(true);
        }
        return true;
    }

    async setMicDevice(deviceId) {
        if (this.room) await this.room.switchActiveDevice('audioinput', deviceId);
    }

    async setCameraDevice(deviceId) {
        if (this.room) await this.room.switchActiveDevice('videoinput', deviceId);
    }

    async setOutputDevice(deviceId) {
        // Supported only in some browsers; fails silently elsewhere.
        const audios = document.querySelectorAll('audio');
        for (const a of audios) {
            if (a.setSinkId) { try { await a.setSinkId(deviceId); } catch (e) { /* unsupported */ } }
        }
    }

    /** Enforced when the host mutes us: the SFU token no longer allows it
     *  on rejoin, and we cut the track immediately for responsiveness. */
    async forceMute() {
        if (this.enabled && this.room && this.micOn) {
            await this.room.localParticipant.setMicrophoneEnabled(false);
        }
        this._syncLocalUI();
    }

    async forceCameraOff() {
        if (this.enabled && this.room && this.cameraOn) {
            await this.room.localParticipant.setCameraEnabled(false);
        }
        this._syncLocalUI();
    }

    _syncLocalUI() {
        const micBtn = document.getElementById('btn-mic');
        const camBtn = document.getElementById('btn-camera');
        if (micBtn) {
            micBtn.classList.toggle('active', this.micOn);
            micBtn.classList.toggle('off', this.permissions.can_use_microphone === false);
            micBtn.setAttribute('aria-pressed', String(this.micOn));
        }
        if (camBtn) {
            camBtn.classList.toggle('active', this.cameraOn);
            camBtn.setAttribute('aria-pressed', String(this.cameraOn));
        }
        // keep the live mic meter in sync with the real publish state
        if (this.micOn && !this._localLevelRaf) this._startLocalLevel();
        if (!this.micOn) this._stopLocalLevel();
    }

    /** Called by room.js when the roster reports our forced states. */
    applyModerationState({ muted, camera_disabled }) {
        if (muted && this.micOn) this.forceMute();
        if (camera_disabled && this.cameraOn) this.forceCameraOff();
        this.permissions.can_use_microphone = !muted && this.permissions.can_use_microphone !== false;
        this._syncLocalUI();
    }

    async listDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return [];
        return navigator.mediaDevices.enumerateDevices();
    }

    disconnect() {
        if (this.room) this.room.disconnect();
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
    }

    get quality() { return this.impl ? this.impl.quality : 'unknown'; }
    get layout() { return this.impl ? this.impl.layout : 'grid'; }

    async init(opts) {
        if (opts.mediaEnabled && opts.mediaUrl && LivekitClient) {
            this.engine = 'livekit';
            this.impl = livekitMedia;
        } else {
            this.engine = 'mesh';
            this.impl = new MeshMedia();
        }
        try {
            await this.impl.init(opts);
        } catch (err) {
            console.warn(`[media:${this.engine}] init failed:`, err);
        }
    }

    /** Mesh needs the presence roster + signalling transport; LiveKit ignores. */
    syncPeers(peers) { if (this.impl && this.impl.syncPeers) this.impl.syncPeers(peers); }
    handleSignal(msg) { if (this.impl && this.impl.handleSignal) this.impl.handleSignal(msg); }

    setLayout(mode) { if (this.impl) this.impl.setLayout(mode); }
    updatePip(view) { if (this.impl && this.impl.updatePip) this.impl.updatePip(view); }
    closePip() { if (this.impl && this.impl.closePip) this.impl.closePip(); }
    async toggleMicrophone() { return this.impl ? this.impl.toggleMicrophone() : false; }
    async toggleCamera() { return this.impl ? this.impl.toggleCamera() : false; }
    async toggleScreenShare() { return this.impl ? this.impl.toggleScreenShare() : false; }
    async forceMute() { return this.impl && this.impl.forceMute(); }
    async forceCameraOff() { return this.impl && this.impl.forceCameraOff(); }
    async setMicDevice(id) { return this.impl && this.impl.setMicDevice(id); }
    async setCameraDevice(id) { return this.impl && this.impl.setCameraDevice(id); }
    async setOutputDevice(id) { return this.impl && this.impl.setOutputDevice(id); }
    async listDevices() { return this.impl ? this.impl.listDevices() : []; }
}

export const Media = new MediaFacade();
