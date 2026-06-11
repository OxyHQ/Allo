/**
 * Peer-to-Peer Messaging via WebRTC data channels.
 *
 * - One reusable RTCPeerConnection + ordered/reliable DataChannel per peer user.
 * - Signaling is forwarded by the backend's `/messaging` namespace (see
 *   `packages/backend/src/utils/p2pSignaling.ts`). This module owns its own
 *   Socket.IO connection (mirroring `useCallSignaling`'s pattern) so the
 *   real-time messaging socket and the calls signaling socket remain untouched.
 * - Payloads on the wire are the same Signal-encrypted envelope used by the
 *   relay path. P2P does *not* introduce a new crypto layer; it only changes
 *   the transport.
 * - Caller-side `sendMessage` returns `true` only when the message has been
 *   pushed onto an already-open data channel. Otherwise it returns `false`
 *   and the caller falls back to the HTTP relay (the eventual handshake
 *   completion is opportunistic and will benefit later messages).
 */

import { webrtc } from './webrtc';
import { getIceServers } from './webrtc/iceConfig';
import type { Socket } from 'socket.io-client';

// Backpressure: drop to relay if the DC outbound buffer climbs above 16 MiB.
// Browsers/native typically support ~16 MiB SCTP buffers before degrading.
const DC_BUFFER_HIGH_WATERMARK = 16 * 1024 * 1024;

// Hard cap on handshake time before we tear down and let the caller relay.
const HANDSHAKE_TIMEOUT_MS = 15_000;

// Max idle time before we proactively close (kept conservative; an active
// peer will refresh `lastSeen` on every send/receive).
const IDLE_TTL_MS = 10 * 60_000;

/**
 * Prefix that marks a `sessionId` as a device-to-device HISTORY TRANSFER session
 * (Fase 1C) rather than a normal user-to-user messaging session. The two share
 * the same `p2p:*` signaling events, so the prefix lets each set of handlers
 * ignore the other's traffic without ambiguity.
 */
const TRANSFER_SESSION_PREFIX = 'xfer:';

/**
 * Backpressure watermark for the history-transfer data channel. Lower than the
 * messaging watermark because transfer writes a continuous stream of ~64 KiB
 * frames and we want to pause well before the SCTP buffer saturates. When
 * `bufferedAmount` exceeds this, the sender waits for it to drain.
 */
const TRANSFER_DC_BUFFER_HIGH_WATERMARK = 1 * 1024 * 1024;

/** Poll interval while waiting for the transfer DC buffer to drain below the watermark. */
const TRANSFER_DRAIN_POLL_MS = 25;

/** Hard cap on a single transfer handshake before giving up. */
const TRANSFER_HANDSHAKE_TIMEOUT_MS = 30_000;

export interface P2POfferEvent {
  from: string;
  /** Sender's device id, echoed by the server for device-addressed sessions. */
  fromDeviceId?: number;
  sdp: RTCSessionDescriptionInit;
  sessionId: string;
}

export interface P2PAnswerEvent {
  from: string;
  fromDeviceId?: number;
  sdp: RTCSessionDescriptionInit;
  sessionId: string;
}

export interface P2PIceEvent {
  from: string;
  fromDeviceId?: number;
  candidate: RTCIceCandidateInit | null;
  sessionId: string;
}

export interface P2PCloseEvent {
  from: string;
  fromDeviceId?: number;
  sessionId: string;
}

/**
 * Wire format for data-channel messages. Mirrors the relay payload so the
 * receiver can hand it to the same processing pipeline (Signal decrypt →
 * messagesStore.addMessage).
 *
 * `text` is only present when the sender could not encrypt (e.g. recipient
 * has no published prekey bundle). The relay path already supports this
 * fallback, so we preserve it for parity.
 */
export interface P2PMessageEnvelope {
  type: 'msg';
  clientMessageId: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: number;
  timestamp: string;
  messageType?: 'text' | 'media' | 'file' | 'audio' | 'location' | 'contact' | 'poll';
  fontSize?: number;
  isEncrypted: boolean;
  ciphertext?: string;
  text?: string;
}

interface PeerSession {
  peerUserId: string;
  sessionId: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  /** Initiator side queues messages emitted before the channel reaches 'open'. */
  outboundQueue: string[];
  /** Buffer for ICE candidates received before remoteDescription is applied. */
  pendingRemoteIce: RTCIceCandidateInit[];
  state: 'connecting' | 'open' | 'closed';
  role: 'initiator' | 'responder';
  lastSeen: number;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

type MessageHandler = (event: { from: string; payload: P2PMessageEnvelope }) => void;

// ICE (STUN/TURN) config is shared with the call path — see lib/webrtc/iceConfig.

/**
 * Both peers must agree on the same `sessionId` so the signaling forwarder
 * (which is stateless) can be used by either side as initiator. Deriving it
 * from the sorted user-id pair guarantees determinism without an extra round
 * trip.
 */
function computeSessionId(selfId: string, peerId: string): string {
  return selfId < peerId ? `${selfId}|${peerId}` : `${peerId}|${selfId}`;
}

/** True when a sessionId belongs to a device-to-device history transfer. */
function isTransferSession(sessionId: string): boolean {
  return sessionId.startsWith(TRANSFER_SESSION_PREFIX);
}

/** Map key for a transfer session: the peer's `userId:deviceId`. */
function transferKey(peer: { userId: string; deviceId: number }): string {
  return `${peer.userId}:${peer.deviceId}`;
}

/** Promise-based delay used to await data-channel buffer drain. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- History transfer (Fase 1C) types --------------------------------------

/** Lifecycle states of a history-transfer connection. */
export type TransferConnectionState = 'connecting' | 'open' | 'closed';

/** A device-addressed peer that owns one side of a transfer. */
export interface TransferPeer {
  userId: string;
  deviceId: number;
}

/** Callbacks the transfer layer (lib/historyTransfer driver) registers. */
export interface TransferConnectionHandlers {
  /** Fired once the data channel is open and ready for frames. */
  onOpen: () => void;
  /** Fired for each raw frame string received from the peer. */
  onFrame: (raw: string) => void;
  /** Fired when the connection closes (after open or on failure). */
  onClose: (reason: string) => void;
  /** Fired if the handshake fails to reach `open` before the timeout. */
  onError: (reason: string) => void;
}

/**
 * One device-to-device history-transfer session. Distinct from `PeerSession`
 * (live messaging): keyed by the peer's deviceId, addressed via `toDeviceId` in
 * signaling, carries opaque transfer frames (not the messaging envelope schema),
 * and is single-purpose (torn down when the transfer ends).
 */
interface TransferSession {
  peer: TransferPeer;
  sessionId: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  pendingRemoteIce: RTCIceCandidateInit[];
  state: TransferConnectionState;
  role: 'initiator' | 'responder';
  handlers: TransferConnectionHandlers;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  /** Set once a terminal callback (onClose/onError) has fired, to fire it once. */
  settled: boolean;
}

/**
 * A live handle returned to the transfer driver for one open session. Lets the
 * driver write frames (with backpressure) and close the session explicitly.
 */
export interface TransferConnection {
  /**
   * Send one raw frame string, awaiting drain if the channel buffer is above the
   * watermark. Resolves true on success, false if the channel is no longer open.
   */
  send(frame: string): Promise<boolean>;
  /** Close the session and signal the peer. */
  close(reason: string): void;
  /** True while the underlying data channel is open. */
  isOpen(): boolean;
}

class P2PManager {
  private socket: Socket | null = null;
  private selfUserId: string | null = null;
  private selfDeviceId: number | null = null;
  private sessions: Map<string, PeerSession> = new Map();
  private messageHandlers: Set<MessageHandler> = new Set();
  private listenersBound = false;

  /**
   * Active history-transfer sessions, keyed `${userId}:${deviceId}` of the PEER.
   * A device runs at most one transfer with a given peer device at a time.
   */
  private transferSessions: Map<string, TransferSession> = new Map();

  /**
   * Attach to an authenticated `/messaging` socket. Idempotent.
   * The hook layer (`useP2PMessaging`) is responsible for lifecycle.
   *
   * `selfDeviceId` is this device's Signal device id, required only for
   * device-addressed history transfer (Fase 1C). It may be omitted for the
   * pure user-to-user messaging path.
   */
  init(socket: Socket, selfUserId: string, selfDeviceId?: number): void {
    if (selfDeviceId !== undefined) {
      this.selfDeviceId = selfDeviceId;
    }
    if (this.socket === socket && this.selfUserId === selfUserId && this.listenersBound) {
      return;
    }
    this.detachSocketListeners();
    this.socket = socket;
    this.selfUserId = selfUserId;
    this.attachSocketListeners();
  }

  /** Set/refresh this device's Signal device id (used by history transfer). */
  setSelfDeviceId(deviceId: number): void {
    this.selfDeviceId = deviceId;
  }

  /**
   * Detach without tearing down sessions — they may still be useful if the
   * socket reconnects with the same identity.
   */
  detach(): void {
    this.detachSocketListeners();
    this.socket = null;
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  /**
   * Attempt to push an envelope to `peerUserId`. Returns true iff the data
   * channel was already open and accepted the payload.
   *
   * If no session exists, kicks off a handshake in the background so future
   * sends to the same peer can short-circuit the relay. The first message
   * after a cold start still flows through the relay.
   */
  sendMessage(peerUserId: string, envelope: P2PMessageEnvelope): boolean {
    if (!this.socket || !this.selfUserId) {
      return false;
    }
    if (peerUserId === this.selfUserId) {
      return false;
    }

    const session = this.sessions.get(peerUserId);
    if (session && session.state === 'open' && session.dc) {
      return this.writeToChannel(session, envelope);
    }

    if (!session) {
      this.initiateHandshake(peerUserId);
    }
    return false;
  }

  closePeer(peerUserId: string): void {
    const session = this.sessions.get(peerUserId);
    if (!session) return;
    const { sessionId } = session;
    this.teardownSession(session, 'local-close');
    if (this.socket && this.selfUserId) {
      this.socket.emit('p2p:close', { to: peerUserId, sessionId });
    }
  }

  closeAll(): void {
    const peers = Array.from(this.sessions.keys());
    peers.forEach((peerId) => this.closePeer(peerId));
  }

  isOpen(peerUserId: string): boolean {
    const s = this.sessions.get(peerUserId);
    return !!s && s.state === 'open';
  }

  // --- internal: socket wiring ----------------------------------------------

  private attachSocketListeners(): void {
    const socket = this.socket;
    if (!socket || this.listenersBound) return;
    socket.on('p2p:offer', this.handleOffer);
    socket.on('p2p:answer', this.handleAnswer);
    socket.on('p2p:ice', this.handleIce);
    socket.on('p2p:close', this.handleRemoteClose);
    this.listenersBound = true;
  }

  private detachSocketListeners(): void {
    const socket = this.socket;
    if (!socket || !this.listenersBound) return;
    socket.off('p2p:offer', this.handleOffer);
    socket.off('p2p:answer', this.handleAnswer);
    socket.off('p2p:ice', this.handleIce);
    socket.off('p2p:close', this.handleRemoteClose);
    this.listenersBound = false;
  }

  // --- internal: signaling handlers (arrow-bound for off() symmetry) --------

  private handleOffer = async (evt: P2POfferEvent): Promise<void> => {
    if (!this.selfUserId || !this.socket) return;
    const { from, sdp, sessionId } = evt;
    if (!from || !sdp || !sessionId) return;

    // History-transfer offers are handled by the transfer subsystem, not here.
    if (isTransferSession(sessionId)) {
      void this.handleTransferOffer(evt);
      return;
    }

    const expected = computeSessionId(this.selfUserId, from);
    if (sessionId !== expected) {
      return;
    }

    // If we already have a session with this peer, decide who keeps theirs.
    // Glare resolution: the lexicographically smaller userId wins (keeps its
    // existing connection; the other side replaces).
    const existing = this.sessions.get(from);
    if (existing) {
      const weWin = this.selfUserId < from;
      if (weWin && existing.state !== 'closed') {
        // Ignore the incoming offer; ours stands.
        return;
      }
      this.teardownSession(existing, 'glare');
    }

    try {
      const session = this.buildSession(from, sessionId, 'responder');
      session.pc.ondatachannel = (event: RTCDataChannelEvent) => {
        this.attachDataChannel(session, event.channel);
      };
      await session.pc.setRemoteDescription(new webrtc.RTCSessionDescription(sdp));
      this.flushPendingIce(session);
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      this.socket.emit('p2p:answer', {
        to: from,
        sdp: session.pc.localDescription,
        sessionId,
      });
    } catch (err) {
      console.warn('[P2P] handleOffer failed:', err);
      const s = this.sessions.get(from);
      if (s) this.teardownSession(s, 'offer-error');
    }
  };

  private handleAnswer = async (evt: P2PAnswerEvent): Promise<void> => {
    const { from, sdp, sessionId } = evt;
    if (isTransferSession(sessionId)) {
      void this.handleTransferAnswer(evt);
      return;
    }
    const session = this.sessions.get(from);
    if (!session || session.role !== 'initiator' || session.sessionId !== sessionId) {
      return;
    }
    try {
      await session.pc.setRemoteDescription(new webrtc.RTCSessionDescription(sdp));
      this.flushPendingIce(session);
    } catch (err) {
      console.warn('[P2P] handleAnswer failed:', err);
      this.teardownSession(session, 'answer-error');
    }
  };

  private handleIce = async (evt: P2PIceEvent): Promise<void> => {
    const { from, candidate, sessionId } = evt;
    if (isTransferSession(sessionId)) {
      void this.handleTransferIce(evt);
      return;
    }
    const session = this.sessions.get(from);
    if (!session || session.sessionId !== sessionId) {
      return;
    }
    // Null candidate = end-of-candidates marker. Some platforms ignore null;
    // skip the call rather than risk an error.
    if (!candidate) return;

    if (!session.pc.remoteDescription || !session.pc.remoteDescription.type) {
      session.pendingRemoteIce.push(candidate);
      return;
    }
    try {
      await session.pc.addIceCandidate(new webrtc.RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[P2P] addIceCandidate failed:', err);
    }
  };

  private handleRemoteClose = (evt: P2PCloseEvent): void => {
    const { from, sessionId } = evt;
    if (isTransferSession(sessionId)) {
      this.handleTransferRemoteClose(evt);
      return;
    }
    const session = this.sessions.get(from);
    if (!session || session.sessionId !== sessionId) return;
    this.teardownSession(session, 'remote-close');
  };

  // --- internal: session lifecycle ------------------------------------------

  private initiateHandshake(peerUserId: string): void {
    if (!this.socket || !this.selfUserId) return;
    if (this.sessions.has(peerUserId)) return;
    if (!webrtc.isSupported || !webrtc.RTCPeerConnection) return;

    const sessionId = computeSessionId(this.selfUserId, peerUserId);
    const session = this.buildSession(peerUserId, sessionId, 'initiator');

    try {
      const dc = session.pc.createDataChannel('allo-msg', {
        ordered: true,
      });
      this.attachDataChannel(session, dc);
    } catch (err) {
      console.warn('[P2P] createDataChannel failed:', err);
      this.teardownSession(session, 'create-dc-error');
      return;
    }

    void (async () => {
      try {
        const offer = await session.pc.createOffer();
        await session.pc.setLocalDescription(offer);
        if (!this.socket || this.sessions.get(peerUserId) !== session) return;
        this.socket.emit('p2p:offer', {
          to: peerUserId,
          sdp: session.pc.localDescription,
          sessionId,
        });
      } catch (err) {
        console.warn('[P2P] createOffer failed:', err);
        this.teardownSession(session, 'create-offer-error');
      }
    })();
  }

  private buildSession(
    peerUserId: string,
    sessionId: string,
    role: 'initiator' | 'responder'
  ): PeerSession {
    const pc = new webrtc.RTCPeerConnection({ iceServers: getIceServers() });
    const session: PeerSession = {
      peerUserId,
      sessionId,
      pc,
      dc: null,
      outboundQueue: [],
      pendingRemoteIce: [],
      state: 'connecting',
      role,
      lastSeen: Date.now(),
      handshakeTimer: setTimeout(() => {
        if (session.state !== 'open') {
          console.warn('[P2P] handshake timeout for', peerUserId);
          this.teardownSession(session, 'handshake-timeout');
        }
      }, HANDSHAKE_TIMEOUT_MS),
    };

    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (!ev.candidate || !this.socket) return;
      const candidate: RTCIceCandidateInit = ev.candidate.toJSON
        ? ev.candidate.toJSON()
        : (ev.candidate as unknown as RTCIceCandidateInit);
      this.socket.emit('p2p:ice', {
        to: peerUserId,
        candidate,
        sessionId,
      });
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'failed' || s === 'closed') {
        this.teardownSession(session, `ice-${s}`);
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') {
        this.teardownSession(session, `pc-${s}`);
      }
    };

    this.sessions.set(peerUserId, session);
    return session;
  }

  private attachDataChannel(session: PeerSession, dc: RTCDataChannel): void {
    session.dc = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      session.state = 'open';
      session.lastSeen = Date.now();
      if (session.handshakeTimer) {
        clearTimeout(session.handshakeTimer);
        session.handshakeTimer = null;
      }
      // Drain anything queued while we were still negotiating.
      while (session.outboundQueue.length > 0 && dc.readyState === 'open') {
        const payload = session.outboundQueue.shift();
        if (payload === undefined) break;
        try {
          dc.send(payload);
        } catch (err) {
          console.warn('[P2P] drain send failed:', err);
          break;
        }
      }
    };

    dc.onclose = () => {
      this.teardownSession(session, 'dc-close');
    };

    dc.onerror = (err: unknown) => {
      console.warn('[P2P] dc error:', err);
    };

    dc.onmessage = (ev: MessageEvent) => {
      session.lastSeen = Date.now();
      this.dispatchIncoming(session.peerUserId, ev.data);
    };
  }

  private dispatchIncoming(from: string, raw: unknown): void {
    if (typeof raw !== 'string') {
      // We never send binary today.
      return;
    }
    let parsed: P2PMessageEnvelope | null = null;
    try {
      const obj = JSON.parse(raw) as P2PMessageEnvelope;
      if (
        obj &&
        obj.type === 'msg' &&
        typeof obj.clientMessageId === 'string' &&
        typeof obj.conversationId === 'string' &&
        typeof obj.senderId === 'string' &&
        typeof obj.senderDeviceId === 'number' &&
        typeof obj.timestamp === 'string'
      ) {
        parsed = obj;
      }
    } catch {
      // ignore malformed payload
    }
    if (!parsed) return;
    const envelope = parsed;
    this.messageHandlers.forEach((handler) => {
      try {
        handler({ from, payload: envelope });
      } catch (err) {
        console.warn('[P2P] message handler threw:', err);
      }
    });
  }

  private writeToChannel(session: PeerSession, envelope: P2PMessageEnvelope): boolean {
    if (!session.dc || session.dc.readyState !== 'open') {
      return false;
    }
    if (session.dc.bufferedAmount > DC_BUFFER_HIGH_WATERMARK) {
      // Backpressure: let the caller relay this one.
      return false;
    }
    try {
      session.dc.send(JSON.stringify(envelope));
      session.lastSeen = Date.now();
      return true;
    } catch (err) {
      console.warn('[P2P] dc.send failed:', err);
      return false;
    }
  }

  private flushPendingIce(session: PeerSession): void {
    if (session.pendingRemoteIce.length === 0) return;
    const queued = session.pendingRemoteIce;
    session.pendingRemoteIce = [];
    queued.forEach((candidate) => {
      session.pc
        .addIceCandidate(new webrtc.RTCIceCandidate(candidate))
        .catch((err) => console.warn('[P2P] queued addIceCandidate failed:', err));
    });
  }

  private teardownSession(session: PeerSession, reason: string): void {
    if (session.state === 'closed') {
      this.sessions.delete(session.peerUserId);
      return;
    }
    session.state = 'closed';
    if (session.handshakeTimer) {
      clearTimeout(session.handshakeTimer);
      session.handshakeTimer = null;
    }
    if (session.dc) {
      try {
        session.dc.onopen = null;
        session.dc.onclose = null;
        session.dc.onerror = null;
        session.dc.onmessage = null;
        session.dc.close();
      } catch {
        /* ignore */
      }
      session.dc = null;
    }
    try {
      session.pc.onicecandidate = null;
      session.pc.oniceconnectionstatechange = null;
      session.pc.onconnectionstatechange = null;
      // `pc.close()` detaches remaining handlers (incl. ondatachannel) natively.
      session.pc.close();
    } catch {
      /* ignore */
    }
    this.sessions.delete(session.peerUserId);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[P2P] session ${session.peerUserId} closed (${reason})`);
    }
  }

  /**
   * Periodically called by the hook to evict stale sessions. Pure no-op if no
   * peer is idle past the TTL.
   */
  evictIdleSessions(now: number = Date.now()): void {
    this.sessions.forEach((session, peerId) => {
      if (now - session.lastSeen > IDLE_TTL_MS) {
        this.closePeer(peerId);
      }
    });
  }

  // ========================================================================
  // History transfer (Fase 1C) — device-to-device encrypted channel.
  // ========================================================================

  /**
   * Open a history-transfer connection to a peer DEVICE (same account, different
   * device) as the INITIATOR. Returns a `TransferConnection` handle once the
   * handshake is requested; the `onOpen` handler fires when the channel is ready.
   *
   * The data-channel payload is opaque transfer frames already AEAD-encrypted by
   * the caller with the out-of-band transfer key — this layer adds transport
   * only, exactly like the messaging path adds no crypto of its own.
   */
  openTransfer(peer: TransferPeer, handlers: TransferConnectionHandlers): TransferConnection | null {
    if (!this.socket || !this.selfUserId) {
      handlers.onError('not_connected');
      return null;
    }
    if (!webrtc.isSupported || !webrtc.RTCPeerConnection) {
      handlers.onError('webrtc_unsupported');
      return null;
    }
    const key = transferKey(peer);
    if (this.transferSessions.has(key)) {
      // Replace any stale prior attempt to this device.
      this.teardownTransfer(this.transferSessions.get(key) as TransferSession, 'restart');
    }

    const sessionId = `${TRANSFER_SESSION_PREFIX}${this.selfUserId}|${this.selfDeviceId ?? 0}|${peer.deviceId}|${Date.now()}`;
    const session = this.buildTransferSession(peer, sessionId, 'initiator', handlers);

    try {
      const dc = session.pc.createDataChannel('allo-history', { ordered: true });
      this.attachTransferChannel(session, dc);
    } catch (err) {
      console.warn('[P2P] transfer createDataChannel failed:', err);
      this.teardownTransfer(session, 'create-dc-error');
      return null;
    }

    void (async () => {
      try {
        const offer = await session.pc.createOffer();
        await session.pc.setLocalDescription(offer);
        if (!this.socket || this.transferSessions.get(key) !== session) return;
        this.socket.emit('p2p:offer', {
          to: peer.userId,
          toDeviceId: peer.deviceId,
          sdp: session.pc.localDescription,
          sessionId,
        });
      } catch (err) {
        console.warn('[P2P] transfer createOffer failed:', err);
        this.teardownTransfer(session, 'create-offer-error');
      }
    })();

    return this.transferHandle(session);
  }

  /**
   * Register as the RESPONDER for an incoming transfer. The receiving device
   * (the one missing history) calls this BEFORE displaying its pairing code.
   *
   * The receiver does NOT know the sending device's id in advance — the pairing
   * code flows new→old and carries the NEW device's address. So the responder
   * registers a single pending listener scoped to `expectedSenderUserId` (which
   * must be the user's own account) and accepts the FIRST matching offer,
   * learning the sender's device id from the signaling `fromDeviceId`.
   *
   * Authenticity does not rely on knowing the peer device up front: the AEAD
   * transfer key (derived from the out-of-band secret) means only a peer holding
   * that key can produce frames that decrypt.
   *
   * Returns a handle immediately; the connection becomes usable on `onOpen`.
   */
  prepareTransferResponder(
    expectedSenderUserId: string,
    handlers: TransferConnectionHandlers
  ): TransferConnection {
    // Replace any prior pending/active responder — one inbound transfer at a time.
    if (this.pendingResponder) {
      this.pendingResponder = null;
    }
    if (this.activeResponderPeer) {
      const prior = this.transferSessions.get(transferKey(this.activeResponderPeer));
      if (prior) this.teardownTransfer(prior, 'responder-reset');
      this.activeResponderPeer = null;
    }
    this.pendingResponder = { expectedSenderUserId, handlers };

    return {
      send: async (frame: string) => {
        const s = this.activeResponderPeer
          ? this.transferSessions.get(transferKey(this.activeResponderPeer))
          : undefined;
        return s ? this.writeTransferFrame(s, frame) : false;
      },
      close: (reason: string) => {
        const s = this.activeResponderPeer
          ? this.transferSessions.get(transferKey(this.activeResponderPeer))
          : undefined;
        if (s) {
          this.teardownTransfer(s, reason);
        }
        this.pendingResponder = null;
        this.activeResponderPeer = null;
      },
      isOpen: () => {
        const s = this.activeResponderPeer
          ? this.transferSessions.get(transferKey(this.activeResponderPeer))
          : undefined;
        return !!s && s.state === 'open';
      },
    };
  }

  /** Single pending responder awaiting an inbound transfer offer, if any. */
  private pendingResponder: {
    expectedSenderUserId: string;
    handlers: TransferConnectionHandlers;
  } | null = null;

  /** The peer device of the currently active responder session, if any. */
  private activeResponderPeer: TransferPeer | null = null;

  private handleTransferOffer = async (evt: P2POfferEvent): Promise<void> => {
    if (!this.socket || evt.fromDeviceId === undefined) return;
    const peer: TransferPeer = { userId: evt.from, deviceId: evt.fromDeviceId };

    const pending = this.pendingResponder;
    if (!pending || pending.expectedSenderUserId !== peer.userId) {
      // No one is expecting a transfer from this account; ignore the offer.
      return;
    }
    // Bind this responder to the peer device that actually offered.
    this.pendingResponder = null;
    this.activeResponderPeer = peer;
    const handlers = pending.handlers;

    const session = this.buildTransferSession(peer, evt.sessionId, 'responder', handlers);
    session.pc.ondatachannel = (event: RTCDataChannelEvent) => {
      this.attachTransferChannel(session, event.channel);
    };
    try {
      await session.pc.setRemoteDescription(new webrtc.RTCSessionDescription(evt.sdp));
      this.flushTransferIce(session);
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      this.socket.emit('p2p:answer', {
        to: peer.userId,
        toDeviceId: peer.deviceId,
        sdp: session.pc.localDescription,
        sessionId: evt.sessionId,
      });
    } catch (err) {
      console.warn('[P2P] transfer handleOffer failed:', err);
      this.teardownTransfer(session, 'offer-error');
    }
  };

  private handleTransferAnswer = async (evt: P2PAnswerEvent): Promise<void> => {
    if (evt.fromDeviceId === undefined) return;
    const session = this.transferSessions.get(
      transferKey({ userId: evt.from, deviceId: evt.fromDeviceId })
    );
    if (!session || session.role !== 'initiator' || session.sessionId !== evt.sessionId) {
      return;
    }
    try {
      await session.pc.setRemoteDescription(new webrtc.RTCSessionDescription(evt.sdp));
      this.flushTransferIce(session);
    } catch (err) {
      console.warn('[P2P] transfer handleAnswer failed:', err);
      this.teardownTransfer(session, 'answer-error');
    }
  };

  private handleTransferIce = async (evt: P2PIceEvent): Promise<void> => {
    if (evt.fromDeviceId === undefined) return;
    const session = this.transferSessions.get(
      transferKey({ userId: evt.from, deviceId: evt.fromDeviceId })
    );
    if (!session || session.sessionId !== evt.sessionId || !evt.candidate) return;
    if (!session.pc.remoteDescription || !session.pc.remoteDescription.type) {
      session.pendingRemoteIce.push(evt.candidate);
      return;
    }
    try {
      await session.pc.addIceCandidate(new webrtc.RTCIceCandidate(evt.candidate));
    } catch (err) {
      console.warn('[P2P] transfer addIceCandidate failed:', err);
    }
  };

  private handleTransferRemoteClose = (evt: P2PCloseEvent): void => {
    if (evt.fromDeviceId === undefined) return;
    const session = this.transferSessions.get(
      transferKey({ userId: evt.from, deviceId: evt.fromDeviceId })
    );
    if (!session || session.sessionId !== evt.sessionId) return;
    this.teardownTransfer(session, 'remote-close');
  };

  private buildTransferSession(
    peer: TransferPeer,
    sessionId: string,
    role: 'initiator' | 'responder',
    handlers: TransferConnectionHandlers
  ): TransferSession {
    const pc = new webrtc.RTCPeerConnection({ iceServers: getIceServers() });
    const session: TransferSession = {
      peer,
      sessionId,
      pc,
      dc: null,
      pendingRemoteIce: [],
      state: 'connecting',
      role,
      handlers,
      settled: false,
      handshakeTimer: setTimeout(() => {
        if (session.state !== 'open') {
          this.teardownTransfer(session, 'handshake-timeout');
        }
      }, TRANSFER_HANDSHAKE_TIMEOUT_MS),
    };

    pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (!ev.candidate || !this.socket) return;
      const candidate: RTCIceCandidateInit = ev.candidate.toJSON
        ? ev.candidate.toJSON()
        : (ev.candidate as unknown as RTCIceCandidateInit);
      this.socket.emit('p2p:ice', {
        to: peer.userId,
        toDeviceId: peer.deviceId,
        candidate,
        sessionId,
      });
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'failed' || s === 'closed') {
        this.teardownTransfer(session, `ice-${s}`);
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') {
        this.teardownTransfer(session, `pc-${s}`);
      }
    };

    this.transferSessions.set(transferKey(peer), session);
    return session;
  }

  private attachTransferChannel(session: TransferSession, dc: RTCDataChannel): void {
    session.dc = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      session.state = 'open';
      if (session.handshakeTimer) {
        clearTimeout(session.handshakeTimer);
        session.handshakeTimer = null;
      }
      try {
        session.handlers.onOpen();
      } catch (err) {
        console.warn('[P2P] transfer onOpen handler threw:', err);
      }
    };
    dc.onclose = () => {
      this.teardownTransfer(session, 'dc-close');
    };
    dc.onerror = (err: unknown) => {
      console.warn('[P2P] transfer dc error:', err);
    };
    dc.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return;
      try {
        session.handlers.onFrame(ev.data);
      } catch (err) {
        console.warn('[P2P] transfer onFrame handler threw:', err);
      }
    };
  }

  private async writeTransferFrame(session: TransferSession, frame: string): Promise<boolean> {
    const dc = session.dc;
    if (!dc || dc.readyState !== 'open') return false;
    // Backpressure: wait for the buffer to drain below the watermark so we never
    // overrun the SCTP send buffer mid-transfer.
    while (dc.bufferedAmount > TRANSFER_DC_BUFFER_HIGH_WATERMARK) {
      if (dc.readyState !== 'open') return false;
      await delay(TRANSFER_DRAIN_POLL_MS);
    }
    try {
      dc.send(frame);
      return true;
    } catch (err) {
      console.warn('[P2P] transfer send failed:', err);
      return false;
    }
  }

  private flushTransferIce(session: TransferSession): void {
    if (session.pendingRemoteIce.length === 0) return;
    const queued = session.pendingRemoteIce;
    session.pendingRemoteIce = [];
    queued.forEach((candidate) => {
      session.pc
        .addIceCandidate(new webrtc.RTCIceCandidate(candidate))
        .catch((err) => console.warn('[P2P] transfer queued addIceCandidate failed:', err));
    });
  }

  private transferHandle(session: TransferSession): TransferConnection {
    return {
      send: (frame: string) => this.writeTransferFrame(session, frame),
      close: (reason: string) => this.teardownTransfer(session, reason),
      isOpen: () => session.state === 'open',
    };
  }

  private teardownTransfer(session: TransferSession, reason: string): void {
    const wasOpen = session.state === 'open';
    if (session.state === 'closed') {
      this.transferSessions.delete(transferKey(session.peer));
      return;
    }
    session.state = 'closed';
    if (session.handshakeTimer) {
      clearTimeout(session.handshakeTimer);
      session.handshakeTimer = null;
    }
    if (session.dc) {
      try {
        session.dc.onopen = null;
        session.dc.onclose = null;
        session.dc.onerror = null;
        session.dc.onmessage = null;
        session.dc.close();
      } catch {
        /* ignore */
      }
      session.dc = null;
    }
    try {
      session.pc.onicecandidate = null;
      session.pc.oniceconnectionstatechange = null;
      session.pc.onconnectionstatechange = null;
      session.pc.close();
    } catch {
      /* ignore */
    }
    this.transferSessions.delete(transferKey(session.peer));

    // Tell the peer (best effort) so its side tears down promptly.
    if (this.socket && this.selfUserId) {
      this.socket.emit('p2p:close', {
        to: session.peer.userId,
        toDeviceId: session.peer.deviceId,
        sessionId: session.sessionId,
      });
    }

    // Fire exactly one terminal callback.
    if (!session.settled) {
      session.settled = true;
      try {
        if (wasOpen) {
          session.handlers.onClose(reason);
        } else {
          session.handlers.onError(reason);
        }
      } catch (err) {
        console.warn('[P2P] transfer terminal handler threw:', err);
      }
    }
  }

  /**
   * Full shutdown for logout / account switch: tear down every peer session,
   * detach socket listeners, and clear identity + message handlers so no state
   * leaks across accounts. The hook re-initialises the manager on next login.
   */
  reset(): void {
    this.sessions.forEach((session) => {
      this.teardownSession(session, 'reset');
    });
    this.sessions.clear();
    this.transferSessions.forEach((session) => {
      this.teardownTransfer(session, 'reset');
    });
    this.transferSessions.clear();
    this.pendingResponder = null;
    this.activeResponderPeer = null;
    this.detachSocketListeners();
    this.socket = null;
    this.selfUserId = null;
    this.selfDeviceId = null;
    this.messageHandlers.clear();
  }
}

export const p2pManager = new P2PManager();
export type { PeerSession };
