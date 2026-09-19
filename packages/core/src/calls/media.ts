/**
 * THE SEAM BETWEEN THE SDK AND THE MEDIA — ADR 0002, Decision 5.
 *
 * `@allo/core` runs in Node under `vitest`, where there is no
 * `RTCPeerConnection` and no microphone. So the media is injected, the way
 * storage, secrets, the session and the people directory already are, and the
 * SDK keeps everything that is protocol or security: the state machine, the
 * signalling (encrypted `call` messages through the ordinary outbox), the
 * DTLS fingerprint check that makes a 1:1 call end to end encrypted, and the
 * per-sender frame-key schedule for a group.
 *
 * **The adapter is deliberately dumb.** It holds no policy: it is never asked
 * to decide whether a call is relayed, when a key rotates, when candidates go
 * out or which fingerprint is acceptable. It executes and it reports. A wide
 * adapter is where calling code rots, and every decision it is handed is one
 * each platform can get wrong differently.
 *
 * A client built WITHOUT one can still ring, be rung, decline and end. It
 * simply carries no audio — which is what a test does for ever, and what the
 * app did before the media landed.
 */

/** An SDP together with the DTLS fingerprint the SDK will seal and compare. */
export interface SessionDescription {
  sdp: string;
  /**
   * The `a=fingerprint` line's value, exactly as the local peer connection
   * reports it. The SDK sends it inside the ENCRYPTED offer and checks the
   * one that comes back, which is the whole of Decision 1: a server that
   * swapped it would be swapping a value the MLS group already authenticated.
   */
  fingerprint: string;
}

export interface CallMediaPlan {
  mode: "voice" | "video";
  /** What the server handed out; the adapter uses them and asks nothing about them. */
  iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
  /** `true` maps to WebRTC's `iceTransportPolicy: "relay"`: no host and no server-reflexive candidate is offered. */
  relayOnly: boolean;
}

/** The SFU ticket, for a group call. */
export interface CallRoomTicket {
  url: string;
  token: string;
  room: string;
}

export interface CallMediaAdapter {
  /** Build the local side. Called once per call, before any offer or answer. */
  prepare(plan: CallMediaPlan): Promise<void>;
  /** The description this device offers. */
  createOffer(): Promise<SessionDescription>;
  /** Takes the caller's description, returns this device's answer. */
  acceptOffer(offer: SessionDescription): Promise<SessionDescription>;
  /** Takes the callee's answer. */
  acceptAnswer(answer: SessionDescription): Promise<void>;
  /** Candidates that arrived from the other side. */
  addCandidates(candidates: readonly string[]): Promise<void>;
  /**
   * Local candidates as they are gathered. The SDK batches and encrypts them;
   * an empty batch is the end-of-candidates marker. Returns the unsubscribe.
   */
  onCandidates(listener: (candidates: readonly string[]) => void): () => void;
  /** Group calls only: join the SFU room and publish under `key`. */
  joinRoom?(ticket: CallRoomTicket, key: Uint8Array): Promise<void>;
  /** Group calls only: this device's own sending key, after a rotation. */
  setSendKey?(key: Uint8Array): Promise<void>;
  /** Group calls only: another participant's key, so their frames can be read. */
  setReceiveKey?(instanceId: string, key: Uint8Array): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setCameraEnabled(on: boolean): Promise<void>;
  /** Tear everything down. Called exactly once per call, however it ended. */
  close(): Promise<void>;
}
