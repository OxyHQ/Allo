/**
 * Calls store — owns WebRTC peer connections, media streams and the active
 * call lifecycle. All signaling is routed through the messaging Socket.IO
 * namespace via the `useCallSignaling` hook.
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { Platform } from 'react-native';
import { api } from '@/utils/api';
import {
  webrtc,
  type RTCViewProps,
} from '@/lib/webrtc';
import { getIceServers } from '@/lib/webrtc/iceConfig';
import type {
  CallHistoryEntry,
  CallType,
  CallSignalBody,
  CallIncomingEvent,
  CallAcceptedEvent,
  CallDeclinedEvent,
  CallCanceledEvent,
  CallEndedEvent,
  CallMissedEvent,
  CallSignalEvent,
  CallAnsweredElsewhereEvent,
} from '@allo/shared-types';

/**
 * Machine-readable call error codes. The UI maps these to localized strings
 * (`calls.error.*`) so no human-facing copy is hardcoded in the store.
 */
export type CallErrorCode =
  | 'permission-denied'
  | 'unsupported'
  | 'busy'
  | 'already-in-call'
  | 'start-failed'
  | 'accept-failed'
  | 'connection-lost';

export type CallRole = 'caller' | 'callee';
export type ActiveCallState =
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'ended';

export interface ActiveCall {
  callId: string;
  peerId: string;
  type: CallType;
  role: CallRole;
  state: ActiveCallState;
  startedAt: Date;
  connectedAt?: Date;
  /** Last error message, if any. */
  error?: string;
  /** UI flags. */
  muted: boolean;
  cameraOn: boolean;
  speakerOn: boolean;
  facing: 'user' | 'environment';
}

export interface IncomingCall {
  callId: string;
  peerId: string;
  type: CallType;
  conversationId?: string;
  startedAt: Date;
}

/**
 * Shape of `GET /calls`. The backend wraps the payload (`{ data: { calls } }`),
 * but we tolerate a flat `{ calls }` too so the parse never needs `any`.
 */
interface CallHistoryResponse {
  calls?: CallHistoryEntry[];
  data?: { calls?: CallHistoryEntry[] };
}

interface SignalSender {
  sendInvite: (params: {
    calleeId: string;
    type: CallType;
    conversationId?: string;
  }) => Promise<{ ok: boolean; callId?: string; error?: string }>;
  sendAccept: (callId: string) => Promise<{ ok: boolean; error?: string }>;
  sendDecline: (callId: string) => Promise<{ ok: boolean; error?: string }>;
  sendCancel: (callId: string) => Promise<{ ok: boolean; error?: string }>;
  sendEnd: (callId: string) => Promise<{ ok: boolean; error?: string }>;
  sendSignal: (
    callId: string,
    to: string,
    payload: CallSignalBody
  ) => Promise<{ ok: boolean; error?: string }>;
}

interface CallsState {
  history: CallHistoryEntry[];
  loading: boolean;
  error: string | null;
  /** Machine-readable variant of `error` for i18n in the UI. */
  errorCode: CallErrorCode | null;
  active: ActiveCall | null;
  incoming: IncomingCall | null;
  /** Track the URLs of the streams so RN <RTCView> can render them. */
  localStreamURL: string | null;
  remoteStreamURL: string | null;
  /** Direct stream handles for the web RTCView prop. */
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;

  // --- Wiring (set by useCallSignaling) ---
  _signal: SignalSender | null;
  _setSignalSender: (s: SignalSender | null) => void;

  // --- Public actions ---
  fetchHistory: () => Promise<void>;
  startCall: (peerId: string, type: CallType, conversationId?: string) => Promise<void>;
  acceptIncoming: (callId: string) => Promise<void>;
  decline: (callId: string) => Promise<void>;
  cancel: () => Promise<void>;
  endCall: () => Promise<void>;
  deleteEntry: (callId: string) => Promise<void>;
  toggleMute: () => void;
  toggleCamera: () => void;
  toggleSpeaker: () => void;
  swapCamera: () => void;
  clearError: () => void;
  /** Called when ICE fails for `callId`: ends the call + surfaces the error. */
  handleIceFailure: (callId: string) => Promise<void>;

  // --- Socket event handlers (called by useCallSignaling) ---
  onIncoming: (evt: CallIncomingEvent) => void;
  onAccepted: (evt: CallAcceptedEvent) => Promise<void>;
  onDeclined: (evt: CallDeclinedEvent) => void;
  onCanceled: (evt: CallCanceledEvent) => void;
  onEnded: (evt: CallEndedEvent) => void;
  onMissed: (evt: CallMissedEvent) => void;
  onAnsweredElsewhere: (evt: CallAnsweredElsewhereEvent) => void;
  onSignal: (evt: CallSignalEvent<CallSignalBody>) => Promise<void>;
  /** Called when the signaling socket drops while a call is active. */
  onConnectionLost: () => void;

  // --- Lifecycle ---
  reset: () => void;
}

/**
 * `RTCPeerConnection` plus the legacy stream-based event surface that
 * `react-native-webrtc` (and older browsers) expose but `lib.dom` omits. We
 * support both the modern track-based API (`ontrack`) and the legacy
 * stream-based one (`onaddstream`) so a single code path works across engines.
 */
interface LegacyAddStreamEvent {
  stream: MediaStream;
}
interface ExtendedRTCPeerConnection extends RTCPeerConnection {
  onaddstream: ((event: LegacyAddStreamEvent) => void) | null;
}

/**
 * `MediaStreamTrack` plus react-native-webrtc's `_switchCamera()` extension
 * (toggles the front/back camera on native; absent on web). Typed so the swap
 * path stays `any`-free.
 */
interface SwitchableMediaStreamTrack extends MediaStreamTrack {
  _switchCamera?: () => void;
}

// --- Module-level WebRTC state (NOT in immer state, to avoid serialisation) ---
let pc: ExtendedRTCPeerConnection | null = null;
let localStreamRef: MediaStream | null = null;
let remoteStreamRef: MediaStream | null = null;
/** ICE candidates received before remoteDescription is set. */
let pendingRemoteIce: RTCIceCandidateInit[] = [];

/**
 * Map a `getUserMedia` failure to a call error code. A denied permission throws
 * `NotAllowedError`/`PermissionDeniedError` (web + react-native-webrtc); a
 * missing device throws `NotFoundError`. Anything else is treated as a generic
 * start failure.
 */
function mediaErrorToCode(err: unknown): CallErrorCode {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'permission-denied';
  }
  return 'start-failed';
}

function teardownPeer() {
  if (pc) {
    try {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onaddstream = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.close();
    } catch {
      /* ignore */
    }
    pc = null;
  }
  if (localStreamRef) {
    try {
      localStreamRef.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    localStreamRef = null;
  }
  if (remoteStreamRef) {
    try {
      remoteStreamRef.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    remoteStreamRef = null;
  }
  pendingRemoteIce = [];
}

async function ensureLocalMedia(type: CallType): Promise<MediaStream> {
  // `facingMode` is a standard MediaTrackConstraints member used by mobile
  // (front camera); on web we constrain resolution instead.
  const videoConstraints: MediaTrackConstraints =
    Platform.OS === 'web'
      ? { width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: 'user' };
  const constraints: MediaStreamConstraints = {
    audio: true,
    video: type === 'video' ? videoConstraints : false,
  };
  const stream = await webrtc.mediaDevices.getUserMedia(constraints);
  return stream as unknown as MediaStream;
}

/**
 * Construct a peer connection typed as `ExtendedRTCPeerConnection`. The single
 * boundary cast is justified here: `lib.dom`'s constructor returns the modern
 * `RTCPeerConnection` type, but the underlying engine (react-native-webrtc /
 * older browsers) also exposes the legacy `onaddstream` member we rely on.
 * Centralizing the widening keeps the rest of the call code fully typed.
 */
function createPeerConnection(): ExtendedRTCPeerConnection {
  const conn = new webrtc.RTCPeerConnection({ iceServers: getIceServers() });
  return conn as ExtendedRTCPeerConnection;
}

function attachRemoteTrackHandlers(
  conn: ExtendedRTCPeerConnection,
  onRemoteStream: (stream: MediaStream) => void
) {
  // Modern API.
  conn.ontrack = (event: RTCTrackEvent) => {
    const stream = event.streams && event.streams[0];
    if (stream) {
      remoteStreamRef = stream;
      onRemoteStream(stream);
    }
  };
  // Legacy API (react-native-webrtc older versions).
  conn.onaddstream = (event: LegacyAddStreamEvent) => {
    if (event?.stream) {
      remoteStreamRef = event.stream;
      onRemoteStream(event.stream);
    }
  };
}

/**
 * Attach ICE connection-state handling. A terminal `failed` state means the
 * media path can't be (re)established — typically a NAT both peers can't
 * traverse without TURN. We invoke `onLost` so the call ends gracefully with a
 * connection-lost state instead of hanging on "Connecting…".
 */
function attachConnectionStateHandlers(conn: RTCPeerConnection, onLost: () => void) {
  conn.oniceconnectionstatechange = () => {
    const ice = conn.iceConnectionState;
    if (ice === 'failed') {
      console.warn('[CallsStore] ICE connection failed — ending call');
      onLost();
    } else if (ice === 'disconnected') {
      // `disconnected` is often transient (brief network blip); WebRTC may
      // recover to `connected`. We log but don't tear down here — a real drop
      // proceeds to `failed`, which we handle above.
      console.warn('[CallsStore] ICE connection disconnected (may recover)');
    }
  };
}

export const useCallsStore = create<CallsState>()(
  immer((set, get) => ({
    history: [],
    loading: false,
    error: null,
    errorCode: null,
    active: null,
    incoming: null,
    localStreamURL: null,
    remoteStreamURL: null,
    localStream: null,
    remoteStream: null,
    _signal: null,

    _setSignalSender: (s) => {
      set((state) => {
        state._signal = s;
      });
    },

    fetchHistory: async () => {
      set((state) => {
        state.loading = true;
        state.error = null;
      });
      try {
        // The endpoint may return the calls either wrapped (`{ data: { calls } }`)
        // or flat (`{ calls }`); accept both without `any`.
        const { data } = await api.get<CallHistoryResponse>('/calls');
        const calls = data?.data?.calls ?? data?.calls ?? [];
        set((state) => {
          state.history = calls;
          state.loading = false;
        });
      } catch (err: unknown) {
        console.error('[CallsStore] fetchHistory failed', err);
        set((state) => {
          state.loading = false;
          state.error = (err as { message?: string })?.message || 'Failed to fetch call history';
        });
      }
    },

    deleteEntry: async (callId: string) => {
      try {
        await api.delete(`/calls/${callId}`);
        set((state) => {
          state.history = state.history.filter((c) => c.id !== callId);
        });
      } catch (err) {
        console.error('[CallsStore] deleteEntry failed', err);
      }
    },

    startCall: async (peerId, type, conversationId) => {
      const sig = get()._signal;
      if (!sig) {
        console.error('[CallsStore] No signaling sender bound — is useCallSignaling mounted?');
        return;
      }
      if (get().active) {
        console.warn('[CallsStore] startCall ignored: already in a call');
        set((state) => {
          state.errorCode = 'already-in-call';
        });
        return;
      }
      if (!webrtc.isSupported) {
        set((state) => {
          state.errorCode = 'unsupported';
          state.error = 'WebRTC is not supported on this device';
        });
        return;
      }

      try {
        // 1. Acquire local media first so we fail fast on permission denial.
        const stream = await ensureLocalMedia(type);
        localStreamRef = stream;

        // 2. Ask server to create the call record + ring the callee.
        const resp = await sig.sendInvite({ calleeId: peerId, type, conversationId });
        if (!resp.ok || !resp.callId) {
          stream.getTracks().forEach((t) => t.stop());
          localStreamRef = null;
          set((state) => {
            // Map server-side rejection reasons to localizable codes.
            state.errorCode =
              resp.error === 'busy'
                ? 'busy'
                : resp.error === 'already_in_call'
                  ? 'already-in-call'
                  : 'start-failed';
            state.error = resp.error || 'Failed to start call';
          });
          return;
        }
        const callId = resp.callId;

        // 3. Build peer connection.
        const conn = createPeerConnection();
        pc = conn;
        stream.getTracks().forEach((track) => {
          conn.addTrack(track, stream);
        });
        attachRemoteTrackHandlers(conn, (remote) => {
          set((state) => {
            state.remoteStream = remote;
            state.remoteStreamURL = webrtc.streamToURL(remote);
          });
        });
        conn.onicecandidate = (ev) => {
          if (ev.candidate) {
            void sig.sendSignal(callId, peerId, {
              kind: 'ice',
              candidate: ev.candidate.toJSON
                ? ev.candidate.toJSON()
                : (ev.candidate as unknown as RTCIceCandidateInit),
            });
          }
        };
        attachConnectionStateHandlers(conn, () => void get().handleIceFailure(callId));

        set((state) => {
          state.active = {
            callId,
            peerId,
            type,
            role: 'caller',
            state: 'ringing',
            startedAt: new Date(),
            muted: false,
            cameraOn: type === 'video',
            speakerOn: type === 'audio' ? false : true,
            facing: 'user',
          };
          state.localStream = stream;
          state.localStreamURL = webrtc.streamToURL(stream);
          state.error = null;
          state.errorCode = null;
        });
      } catch (err) {
        console.error('[CallsStore] startCall error', err);
        teardownPeer();
        const code = mediaErrorToCode(err);
        set((state) => {
          state.errorCode = code;
          state.error = (err as { message?: string })?.message || 'Failed to start call';
          state.active = null;
          state.localStream = null;
          state.localStreamURL = null;
          state.remoteStream = null;
          state.remoteStreamURL = null;
        });
      }
    },

    acceptIncoming: async (callId) => {
      const sig = get()._signal;
      if (!sig) return;
      const incoming = get().incoming;
      if (!incoming || incoming.callId !== callId) return;

      if (!webrtc.isSupported) {
        set((state) => {
          state.errorCode = 'unsupported';
          state.error = 'WebRTC is not supported on this device';
        });
        return;
      }

      try {
        const stream = await ensureLocalMedia(incoming.type);
        localStreamRef = stream;

        const conn = createPeerConnection();
        pc = conn;
        stream.getTracks().forEach((track) => {
          conn.addTrack(track, stream);
        });
        attachRemoteTrackHandlers(conn, (remote) => {
          set((state) => {
            state.remoteStream = remote;
            state.remoteStreamURL = webrtc.streamToURL(remote);
          });
        });
        conn.onicecandidate = (ev) => {
          if (ev.candidate) {
            void sig.sendSignal(callId, incoming.peerId, {
              kind: 'ice',
              candidate: ev.candidate.toJSON
                ? ev.candidate.toJSON()
                : (ev.candidate as unknown as RTCIceCandidateInit),
            });
          }
        };
        attachConnectionStateHandlers(conn, () => void get().handleIceFailure(callId));

        set((state) => {
          state.active = {
            callId,
            peerId: incoming.peerId,
            type: incoming.type,
            role: 'callee',
            state: 'connecting',
            startedAt: new Date(),
            muted: false,
            cameraOn: incoming.type === 'video',
            speakerOn: incoming.type === 'audio' ? false : true,
            facing: 'user',
          };
          state.incoming = null;
          state.localStream = stream;
          state.localStreamURL = webrtc.streamToURL(stream);
        });

        // Tell the server we're accepting; caller will then send the offer.
        const ack = await sig.sendAccept(callId);
        if (!ack.ok) {
          set((state) => {
            state.errorCode = 'accept-failed';
            state.error = ack.error || 'Failed to accept call';
          });
        }
      } catch (err) {
        console.error('[CallsStore] acceptIncoming error', err);
        teardownPeer();
        // Tell the caller we couldn't take it.
        await sig.sendDecline(callId).catch(() => undefined);
        const code = mediaErrorToCode(err);
        set((state) => {
          state.errorCode = code;
          state.error = (err as { message?: string })?.message || 'Failed to accept call';
          state.active = null;
          state.incoming = null;
          state.localStream = null;
          state.localStreamURL = null;
        });
      }
    },

    decline: async (callId) => {
      const sig = get()._signal;
      if (!sig) return;
      await sig.sendDecline(callId).catch(() => undefined);
      set((state) => {
        if (state.incoming?.callId === callId) {
          state.incoming = null;
        }
      });
    },

    cancel: async () => {
      const sig = get()._signal;
      const active = get().active;
      if (!sig || !active) return;
      if (active.role !== 'caller') return;
      await sig.sendCancel(active.callId).catch(() => undefined);
      teardownPeer();
      set((state) => {
        state.active = null;
        state.localStream = null;
        state.localStreamURL = null;
        state.remoteStream = null;
        state.remoteStreamURL = null;
      });
    },

    endCall: async () => {
      const sig = get()._signal;
      const active = get().active;
      if (!sig || !active) return;
      await sig.sendEnd(active.callId).catch(() => undefined);
      teardownPeer();
      set((state) => {
        if (state.active) {
          state.active.state = 'ended';
        }
        state.active = null;
        state.localStream = null;
        state.localStreamURL = null;
        state.remoteStream = null;
        state.remoteStreamURL = null;
      });
    },

    toggleMute: () => {
      const active = get().active;
      if (!active || !localStreamRef) return;
      const next = !active.muted;
      localStreamRef.getAudioTracks().forEach((t) => {
        t.enabled = !next;
      });
      set((state) => {
        if (state.active) state.active.muted = next;
      });
    },

    toggleCamera: () => {
      const active = get().active;
      if (!active || !localStreamRef) return;
      const next = !active.cameraOn;
      localStreamRef.getVideoTracks().forEach((t) => {
        t.enabled = next;
      });
      set((state) => {
        if (state.active) state.active.cameraOn = next;
      });
    },

    toggleSpeaker: () => {
      set((state) => {
        if (state.active) state.active.speakerOn = !state.active.speakerOn;
      });
      // On native, react-native-webrtc exposes InCallManager separately;
      // toggling the flag here is enough for UI. Apps wishing to physically
      // route audio can subscribe to this flag.
    },

    swapCamera: () => {
      const active = get().active;
      if (!active || !localStreamRef) return;
      const videoTracks = localStreamRef.getVideoTracks();
      if (videoTracks.length === 0) return;
      const track = videoTracks[0] as SwitchableMediaStreamTrack;
      if (typeof track._switchCamera === 'function') {
        // react-native-webrtc API
        track._switchCamera();
      }
      set((state) => {
        if (state.active) {
          state.active.facing = state.active.facing === 'user' ? 'environment' : 'user';
        }
      });
    },

    clearError: () => {
      set((state) => {
        state.error = null;
        state.errorCode = null;
      });
    },

    handleIceFailure: async (callId) => {
      const active = get().active;
      if (!active || active.callId !== callId) return;
      // Notify the server so the peer is told the call ended, then clean up
      // locally with a connection-lost code. Best-effort: even if the signal
      // fails (socket also down), we still tear down the local media.
      await get()._signal?.sendEnd(callId).catch(() => undefined);
      teardownPeer();
      set((state) => {
        state.errorCode = 'connection-lost';
        state.active = null;
        state.localStream = null;
        state.localStreamURL = null;
        state.remoteStream = null;
        state.remoteStreamURL = null;
      });
    },

    // --- Socket event handlers ---

    onIncoming: (evt) => {
      // Ignore if we're already in a call (busy): auto-decline so the caller is
      // told immediately instead of ringing into a device that can't pick up.
      if (get().active || get().incoming) {
        get()._signal?.sendDecline(evt.callId).catch(() => undefined);
        return;
      }
      set((state) => {
        state.incoming = {
          callId: evt.callId,
          peerId: evt.callerId,
          type: evt.type,
          conversationId: evt.conversationId,
          startedAt: new Date(evt.startedAt),
        };
      });
    },

    onAccepted: async (evt) => {
      const active = get().active;
      const sig = get()._signal;
      if (!active || active.callId !== evt.callId || !sig) return;
      set((state) => {
        if (state.active) {
          state.active.state = 'connecting';
          state.active.connectedAt = new Date(evt.connectedAt);
        }
      });
      // Caller now creates and sends the offer.
      if (active.role === 'caller' && pc) {
        try {
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: active.type === 'video',
          });
          await pc.setLocalDescription(offer);
          await sig.sendSignal(evt.callId, active.peerId, {
            kind: 'offer',
            sdp: offer.sdp || '',
          });
        } catch (err) {
          console.error('[CallsStore] Failed to create/send offer', err);
        }
      }
    },

    onDeclined: (evt) => {
      const active = get().active;
      if (active && active.callId === evt.callId) {
        teardownPeer();
        set((state) => {
          state.active = null;
          state.localStream = null;
          state.localStreamURL = null;
          state.remoteStream = null;
          state.remoteStreamURL = null;
        });
      }
      set((state) => {
        if (state.incoming?.callId === evt.callId) {
          state.incoming = null;
        }
      });
    },

    onCanceled: (evt) => {
      set((state) => {
        if (state.incoming?.callId === evt.callId) {
          state.incoming = null;
        }
      });
      const active = get().active;
      if (active && active.callId === evt.callId) {
        teardownPeer();
        set((state) => {
          state.active = null;
          state.localStream = null;
          state.localStreamURL = null;
          state.remoteStream = null;
          state.remoteStreamURL = null;
        });
      }
    },

    onEnded: (evt) => {
      const active = get().active;
      if (active && active.callId === evt.callId) {
        teardownPeer();
        set((state) => {
          state.active = null;
          state.localStream = null;
          state.localStreamURL = null;
          state.remoteStream = null;
          state.remoteStreamURL = null;
        });
      }
      // Refresh history so the ended call shows up.
      void get().fetchHistory();
    },

    onMissed: (evt) => {
      set((state) => {
        if (state.incoming?.callId === evt.callId) {
          state.incoming = null;
        }
      });
      void get().fetchHistory();
    },

    onAnsweredElsewhere: (evt) => {
      // Another of our own devices accepted this call. Stop ringing here. We
      // only dismiss the matching incoming overlay — never an active call, since
      // an active call on THIS device means THIS device answered (the server
      // already excludes the accepting device's room, and the payload's
      // answeringDeviceId guards the user-room fallback for legacy clients).
      set((state) => {
        if (state.incoming?.callId === evt.callId) {
          state.incoming = null;
        }
      });
    },

    onConnectionLost: () => {
      // The signaling socket dropped. A CONNECTED call's media path is
      // peer-to-peer and survives signaling blips (ICE failure handles a real
      // media drop), so we leave it alone. But a call still in `ringing`/
      // `connecting` has no media yet — its setup depends on signaling, so a drop
      // there dooms it: tear it down with a connection-lost state. Also dismiss a
      // pending incoming overlay we can no longer answer. No-op when idle.
      const active = get().active;
      const incoming = get().incoming;
      if (!active && !incoming) return;
      const callConnected = active?.state === 'connected';
      if (callConnected) return;
      teardownPeer();
      set((state) => {
        state.errorCode = 'connection-lost';
        state.active = null;
        state.incoming = null;
        state.localStream = null;
        state.localStreamURL = null;
        state.remoteStream = null;
        state.remoteStreamURL = null;
      });
    },

    onSignal: async (evt) => {
      if (!pc) {
        // Buffer ICE if the connection is not ready yet (shouldn't usually happen).
        if (evt.payload?.kind === 'ice' && evt.payload.candidate) {
          pendingRemoteIce.push(evt.payload.candidate);
        }
        return;
      }
      const active = get().active;
      if (!active || active.callId !== evt.callId) return;
      const sig = get()._signal;

      try {
        if (evt.payload.kind === 'offer') {
          await pc.setRemoteDescription(
            new webrtc.RTCSessionDescription({ type: 'offer', sdp: evt.payload.sdp })
          );
          // Drain buffered ICE.
          for (const c of pendingRemoteIce) {
            try {
              await pc.addIceCandidate(new webrtc.RTCIceCandidate(c));
            } catch (err) {
              console.warn('[CallsStore] Failed buffered ICE add', err);
            }
          }
          pendingRemoteIce = [];

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (sig) {
            await sig.sendSignal(active.callId, evt.from, {
              kind: 'answer',
              sdp: answer.sdp || '',
            });
          }
          set((state) => {
            if (state.active) state.active.state = 'connected';
          });
        } else if (evt.payload.kind === 'answer') {
          await pc.setRemoteDescription(
            new webrtc.RTCSessionDescription({ type: 'answer', sdp: evt.payload.sdp })
          );
          for (const c of pendingRemoteIce) {
            try {
              await pc.addIceCandidate(new webrtc.RTCIceCandidate(c));
            } catch (err) {
              console.warn('[CallsStore] Failed buffered ICE add', err);
            }
          }
          pendingRemoteIce = [];
          set((state) => {
            if (state.active) state.active.state = 'connected';
          });
        } else if (evt.payload.kind === 'ice') {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new webrtc.RTCIceCandidate(evt.payload.candidate));
            } catch (err) {
              console.warn('[CallsStore] addIceCandidate failed', err);
            }
          } else {
            pendingRemoteIce.push(evt.payload.candidate);
          }
        }
      } catch (err) {
        console.error('[CallsStore] onSignal error', err);
      }
    },

    // Lifecycle: end any in-flight call, release camera/mic, and clear all call
    // state on logout / account switch. The signal sender is re-bound by
    // `useCallSignaling` once the next session connects.
    reset: () => {
      teardownPeer();
      set((state) => {
        state.history = [];
        state.loading = false;
        state.error = null;
        state.errorCode = null;
        state.active = null;
        state.incoming = null;
        state.localStream = null;
        state.remoteStream = null;
        state.localStreamURL = null;
        state.remoteStreamURL = null;
        state._signal = null;
      });
    },
  }))
);

/** Re-export type for screens consuming RTCView. */
export type { RTCViewProps };
