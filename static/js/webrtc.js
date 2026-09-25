/**
 * webrtc.js — architecture placeholder for the future media phase.
 *
 * Django stays responsible for auth, roles, permissions and WebRTC
 * *signaling* (over the classroom WebSocket).  Peer-to-peer media
 * (camera, microphone, screen share) will be transported by WebRTC —
 * never through Django WebSockets.
 *
 * Planned API surface (implemented in a later phase):
 *   init({ permissions })      — validate granted capabilities
 *   startLocalPreview()        — getUserMedia preview in the stage
 *   toggleMicrophone() / toggleCamera()
 *   startScreenShare() / stopScreenShare()
 *   selectDevice({ audioInput, videoInput, audioOutput })
 *   handleSignal(message)      — offer/answer/ICE relayed via WebSocket
 */
class WebRTCManagerImpl {
    init({ permissions } = {}) {
        this.permissions = permissions || {};
        this.localStream = null;
        this.peers = new Map();
        // Intentionally inert in this phase — no media is captured.
    }

    can(feature) {
        // Mirrors the server-side permission flags for UI affordances only.
        // The authoritative check always happens on the server.
        return Boolean(this.permissions[feature]);
    }
}

export const WebRTCManager = new WebRTCManagerImpl();
