/**
 * wb/transport.js — the whiteboard socket.
 *
 * Responsibilities kept deliberately small: keep the connection alive, hand
 * every frame to the caller, and never lose a drawing because the network
 * blinked.
 *
 * * **Reconnect** uses exponential backoff with jitter and asks for the
 *   operations it missed (``?since=<seq>``), so a 30 s tunnel outage costs one
 *   small tail frame instead of a full replay.
 * * **Outbox**: operations created while offline are queued and flushed on
 *   reconnect (ephemeral pointers are dropped — they are worthless later).
 * * **Presence** is a roster with a TTL, refreshed by the peer's cursor
 *   traffic and by our own periodic ``presence`` heartbeats.
 */
const MAX_OUTBOX = 240;
const PRESENCE_TTL = 45000;
const PING_INTERVAL = 20000;
const PONG_TIMEOUT = 9000;

export class BoardSocket {
    constructor({ roomCode, identity, hooks = {} }) {
        this.roomCode = roomCode;
        this.identity = identity;
        this.hooks = hooks;
        this.ws = null;
        this.status = 'offline';
        this.rtt = null;
        this.retryDelay = 1000;
        this.retryTimer = null;
        this.pingTimer = null;
        this.pongTimer = null;
        this.presenceTimer = null;
        this.lastSeq = 0;
        this.lastMessageAt = 0;
        this.outbox = [];
        this.presence = new Map();
        this.closed = false;
        this.attempt = 0;
    }

    url() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const params = new URLSearchParams();
        if (this.lastSeq > 0) params.set('since', String(this.lastSeq));
        const query = params.toString();
        return `${proto}://${location.host}/ws/classroom/${this.roomCode}/whiteboard/${query ? `?${query}` : ''}`;
    }

    connect() {
        if (this.closed) return;
        // Never run two sockets at once: a reconnect timer can fire while a
        // connection is already open or still handshaking (a flaky tunnel
        // makes that common).  A second socket would leak a connection, keep a
        // ghost participant in the roster, and let the *old* socket's close
        // event report "offline" while the board is actually connected.
        if (this.ws && (this.ws.readyState === WebSocket.OPEN
            || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        this._setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
        let socket;
        try {
            socket = new WebSocket(this.url());
        } catch (err) {
            this._scheduleReconnect();
            return;
        }
        this.ws = socket;

        socket.onopen = () => {
            this.attempt = 0;
            this.retryDelay = 1000;
            this._setStatus('online');
            this._flushOutbox();
            this._startHeartbeat();
        };

        socket.onmessage = (event) => {
            if (socket !== this.ws) return; // a socket we already replaced
            this.lastMessageAt = Date.now();
            let data;
            try {
                data = JSON.parse(event.data);
            } catch (err) {
                return;
            }
            this._dispatch(data);
        };

        socket.onclose = (event) => {
            if (socket !== this.ws) return; // a stale socket dying quietly
            this._stopHeartbeat();
            if (event && (event.code === 4401 || event.code === 4403)) {
                this.closed = true;
                this._setStatus('closed', { code: event.code });
                this.hooks.onClosed?.(event.code);
                return;
            }
            this._setStatus('offline');
            this._scheduleReconnect();
        };

        socket.onerror = () => { /* onclose carries the outcome */ };
    }

    close() {
        this.closed = true;
        this._stopHeartbeat();
        clearTimeout(this.retryTimer);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
        this.ws = null;
        this._setStatus('closed');
    }

    _scheduleReconnect() {
        clearTimeout(this.retryTimer);
        const delay = Math.min(this.retryDelay, 15000) * (0.85 + Math.random() * 0.3);
        this.attempt += 1;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this._isOpen()) return; // came back on its own
            this.retryDelay = Math.min(this.retryDelay * 1.8, 15000);
            this.connect();
        }, delay);
    }

    _setStatus(status, extra = {}) {
        if (this.status === status && !extra.code) return;
        this.status = status;
        this.hooks.onStatus?.(status, extra);
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL);
        this.presenceTimer = setInterval(() => {
            this.prunePresence();
            this.send({ action: 'presence' });
        }, 25000);
        this.ping();
    }

    _stopHeartbeat() {
        clearInterval(this.pingTimer);
        clearInterval(this.presenceTimer);
        clearTimeout(this.pongTimer);
        this.pingTimer = null;
        this.presenceTimer = null;
    }

    ping() {
        if (!this._isOpen()) return;
        this._pendingPingAt = Date.now();
        this.send({ action: 'ping', t: this._pendingPingAt });
        clearTimeout(this.pongTimer);
        this.pongTimer = setTimeout(() => {
            // No traffic at all for a full timeout: the socket is a zombie.
            if (Date.now() - this.lastMessageAt > PONG_TIMEOUT && this._isOpen()) {
                try {
                    this.ws.close();
                } catch (err) { /* already gone */ }
            }
        }, PONG_TIMEOUT + 1000);
    }

    _isOpen() {
        return Boolean(this.ws) && this.ws.readyState === WebSocket.OPEN;
    }

    send(payload) {
        if (this._isOpen()) {
            this.ws.send(JSON.stringify(payload));
            return true;
        }
        return false;
    }

    /* ------------------------------------------------------------------ */
    /* outgoing operations                                                */
    /* ------------------------------------------------------------------ */

    /** Persisted operation(s) — queued while offline. */
    sendOp(op) {
        return this.sendOps([op]);
    }

    sendOps(ops) {
        if (!ops || !ops.length) return false;
        if (this._isOpen()) {
            if (ops.length === 1) this.send({ action: 'op', op: ops[0] });
            else this.send({ action: 'ops', ops });
            return true;
        }
        for (const op of ops) {
            this.outbox.push(op);
            if (this.outbox.length > MAX_OUTBOX) this.outbox.shift();
        }
        return false;
    }

    /** Pointers, laser and in-progress strokes: never queued, never stored. */
    sendEphemeral(op) {
        if (!this._isOpen()) return false;
        this.send({ action: 'op', op: { ...op, live: op.live || undefined } });
        return true;
    }

    requestResync(since = this.lastSeq) {
        if (!this._isOpen()) {
            this.lastSeq = 0; // next connect does a full replay
            return false;
        }
        this.send({ action: 'resync', since });
        return true;
    }

    publishSnapshot(ops, seq) {
        if (!this._isOpen()) return false;
        this.send({ action: 'snapshot', seq, ops });
        return true;
    }

    _flushOutbox() {
        if (!this.outbox.length) return;
        const pending = this.outbox;
        this.outbox = [];
        // one frame per 24 operations keeps each message well inside the
        // server's frame budget while still draining quickly
        for (let i = 0; i < pending.length; i += 24) {
            this.send({ action: 'ops', ops: pending.slice(i, i + 24) });
        }
    }

    /* ------------------------------------------------------------------ */
    /* incoming                                                           */
    /* ------------------------------------------------------------------ */

    _dispatch(data) {
        switch (data.type) {
            case 'whiteboard_history': {
                this.lastSeq = Number(data.seq || 0);
                this.hooks.onSync?.(data);
                break;
            }
            case 'whiteboard_operation': {
                if (!data.ephemeral) {
                    const seq = Number(data.seq || 0);
                    if (seq && seq > this.lastSeq) this.lastSeq = seq;
                }
                this.hooks.onOperation?.(data);
                break;
            }
            case 'presence': {
                this._applyPresence(data);
                break;
            }
            case 'error': {
                this.hooks.onError?.(data);
                break;
            }
            case 'snapshot_stored':
            case 'snapshot_rejected': {
                this.hooks.onSnapshotResult?.(data);
                break;
            }
            case 'pong': {
                if (Number.isFinite(data.t)) this.rtt = Math.max(0, Date.now() - data.t);
                break;
            }
            default: {
                // classroom notifications (mute, permission change, removal…)
                this.hooks.onNotification?.(data);
            }
        }
        if (data.you || data.board) this.hooks.onBoardMeta?.(data);
    }

    _applyPresence(data) {
        const participant = data.participant;
        if (!participant || !participant.identity) return;
        if (participant.identity === this.identity) return;
        if (data.action === 'leave') {
            if (this.presence.delete(participant.identity)) this.hooks.onPresence?.(this.roster());
            return;
        }
        this.presence.set(participant.identity, { ...participant, lastSeen: Date.now() });
        this.hooks.onPresence?.(this.roster());
    }

    /** Any ephemeral traffic refreshes a peer's TTL. */
    touchPresence(identity) {
        const entry = this.presence.get(identity);
        if (entry) entry.lastSeen = Date.now();
    }

    prunePresence() {
        const now = Date.now();
        let changed = false;
        for (const [identity, entry] of this.presence) {
            if (now - entry.lastSeen > PRESENCE_TTL) {
                this.presence.delete(identity);
                changed = true;
            }
        }
        if (changed) this.hooks.onPresence?.(this.roster());
    }

    roster() {
        return [...this.presence.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fa'));
    }

    /** Live pointers, newest first, excluding ourselves. */
    cursorList({ max = 24 } = {}) {
        return this.roster()
            .filter((entry) => entry.cursor)
            .slice(0, max)
            .map((entry) => ({ ...entry.cursor, identity: entry.identity, name: entry.name, color: entry.color }));
    }
}
