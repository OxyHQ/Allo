/**
 * Calls store state-machine tests.
 *
 * Exercises the active/incoming lifecycle transitions driven by socket events
 * and user actions, with WebRTC and the signaling sender mocked. The pure
 * server-side transitions are covered in the backend's callState tests; here we
 * assert the FRONTEND state machine: ringing → connecting → connected → cleared,
 * incoming accept/decline, busy auto-decline, answered-elsewhere dismissal and
 * connection-lost teardown.
 */

// --- Mocks (declared before importing the store; jest hoists jest.mock) ---

jest.mock('@/utils/api', () => ({
  api: {
    get: jest.fn(async () => ({ data: { data: { calls: [] } } })),
    post: jest.fn(),
    delete: jest.fn(async () => ({ data: {} })),
  },
}));

// All WebRTC fakes live inside the factory (jest hoists jest.mock above any
// top-level declarations, so the factory cannot reference outer classes). The
// factory publishes test hooks on a `mock`-prefixed holder — jest's hoisting
// allowlist permits referencing identifiers that begin with `mock`.
interface WebrtcTestHooks {
  /** Most recently constructed fake peer connection. */
  lastPeer: {
    onicecandidate: ((ev: { candidate: unknown }) => void) | null;
    oniceconnectionstatechange: (() => void) | null;
    iceConnectionState: string;
    remoteDescription: { type: string } | null;
    localDescription: { type: string } | null;
    closed: boolean;
    fireIceState: (state: string) => void;
  } | null;
  /** Overridable getUserMedia behaviour per test. */
  getUserMedia: (constraints: { video: unknown }) => Promise<unknown>;
}

const mockWebrtcHooks: WebrtcTestHooks = {
  lastPeer: null,
  getUserMedia: async () => undefined,
};

jest.mock('@/lib/webrtc', () => {
  class FakeMediaStreamTrack {
    enabled = true;
    stopped = false;
    kind: string;
    constructor(kind: string) {
      this.kind = kind;
    }
    stop(): void {
      this.stopped = true;
    }
  }
  class FakeMediaStream {
    private tracks: FakeMediaStreamTrack[];
    constructor(kinds: string[]) {
      this.tracks = kinds.map((k) => new FakeMediaStreamTrack(k));
    }
    getTracks(): FakeMediaStreamTrack[] {
      return this.tracks;
    }
    getAudioTracks(): FakeMediaStreamTrack[] {
      return this.tracks.filter((t) => t.kind === 'audio');
    }
    getVideoTracks(): FakeMediaStreamTrack[] {
      return this.tracks.filter((t) => t.kind === 'video');
    }
  }
  class FakePeerConnection {
    onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    ontrack: ((ev: unknown) => void) | null = null;
    onaddstream: ((ev: unknown) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    iceConnectionState = 'new';
    remoteDescription: { type: string } | null = null;
    localDescription: { type: string } | null = null;
    closed = false;
    addTrack(): void {}
    async createOffer(): Promise<{ type: string; sdp: string }> {
      return { type: 'offer', sdp: 'OFFER_SDP' };
    }
    async createAnswer(): Promise<{ type: string; sdp: string }> {
      return { type: 'answer', sdp: 'ANSWER_SDP' };
    }
    async setLocalDescription(desc: { type: string }): Promise<void> {
      this.localDescription = desc;
    }
    async setRemoteDescription(desc: { type: string }): Promise<void> {
      this.remoteDescription = desc;
    }
    async addIceCandidate(): Promise<void> {
      return undefined;
    }
    close(): void {
      this.closed = true;
    }
    fireIceState(state: string): void {
      this.iceConnectionState = state;
      this.oniceconnectionstatechange?.();
    }
  }
  return {
    // Use the shared FakeMediaStream so `getUserMedia` defaults can build one.
    __FakeMediaStream: FakeMediaStream,
    webrtc: {
      isSupported: true,
      RTCPeerConnection: jest.fn().mockImplementation(() => {
        const pc = new FakePeerConnection();
        mockWebrtcHooks.lastPeer = pc;
        return pc;
      }),
      RTCSessionDescription: jest
        .fn()
        .mockImplementation((init: { type: string; sdp: string }) => init),
      RTCIceCandidate: jest.fn().mockImplementation((init: unknown) => init),
      mediaDevices: {
        getUserMedia: jest.fn((constraints: { video: unknown }) =>
          mockWebrtcHooks.getUserMedia(constraints)
        ),
      },
      streamToURL: jest.fn(() => 'stream://url'),
    },
  };
});

jest.mock('@/lib/webrtc/iceConfig', () => ({
  getIceServers: jest.fn(() => [{ urls: ['stun:stun.l.google.com:19302'] }]),
  hasTurnServer: jest.fn(() => false),
}));

// eslint-disable-next-line import/first
import { useCallsStore } from '@/stores/callsStore';
// The fake MediaStream class, recovered from the mock for building defaults.
// eslint-disable-next-line import/first
import * as webrtcMock from '@/lib/webrtc';

const FakeMediaStreamCtor = (webrtcMock as unknown as {
  __FakeMediaStream: new (kinds: string[]) => unknown;
}).__FakeMediaStream;
// eslint-disable-next-line import/first
import type {
  CallIncomingEvent,
  CallAcceptedEvent,
  CallSignalEvent,
  CallSignalBody,
} from '@allo/shared-types';

const SELF = 'self-user';
const PEER = 'peer-user';

interface MockSignal {
  sendInvite: jest.Mock;
  sendAccept: jest.Mock;
  sendDecline: jest.Mock;
  sendCancel: jest.Mock;
  sendEnd: jest.Mock;
  sendSignal: jest.Mock;
}

function makeSignal(overrides: Partial<MockSignal> = {}): MockSignal {
  return {
    sendInvite: jest.fn(async () => ({ ok: true, callId: 'call-1' })),
    sendAccept: jest.fn(async () => ({ ok: true })),
    sendDecline: jest.fn(async () => ({ ok: true })),
    sendCancel: jest.fn(async () => ({ ok: true })),
    sendEnd: jest.fn(async () => ({ ok: true })),
    sendSignal: jest.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function incomingEvent(overrides: Partial<CallIncomingEvent> = {}): CallIncomingEvent {
  return {
    callId: 'call-1',
    callerId: PEER,
    calleeId: SELF,
    type: 'audio',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWebrtcHooks.lastPeer = null;
  mockWebrtcHooks.getUserMedia = async (constraints: { video: unknown }) =>
    new FakeMediaStreamCtor(constraints.video ? ['audio', 'video'] : ['audio']);
  useCallsStore.getState().reset();
});

describe('startCall (caller)', () => {
  it('acquires media, sends an invite and enters the ringing state', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);

    await useCallsStore.getState().startCall(PEER, 'audio', 'conv-1');

    const { active } = useCallsStore.getState();
    expect(signal.sendInvite).toHaveBeenCalledWith({
      calleeId: PEER,
      type: 'audio',
      conversationId: 'conv-1',
    });
    expect(active).toMatchObject({
      callId: 'call-1',
      peerId: PEER,
      role: 'caller',
      state: 'ringing',
      type: 'audio',
    });
    expect(useCallsStore.getState().errorCode).toBeNull();
  });

  it('does not start a second call while one is active (already-in-call)', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    await useCallsStore.getState().startCall(PEER, 'audio');
    signal.sendInvite.mockClear();

    await useCallsStore.getState().startCall('other', 'audio');

    expect(signal.sendInvite).not.toHaveBeenCalled();
    expect(useCallsStore.getState().errorCode).toBe('already-in-call');
  });

  it('maps a server "busy" rejection to the busy error code and stops media', async () => {
    const signal = makeSignal({ sendInvite: jest.fn(async () => ({ ok: false, error: 'busy' })) });
    useCallsStore.getState()._setSignalSender(signal);

    await useCallsStore.getState().startCall(PEER, 'audio');

    expect(useCallsStore.getState().active).toBeNull();
    expect(useCallsStore.getState().errorCode).toBe('busy');
  });

  it('maps a denied mic/camera permission to the permission-denied code', async () => {
    const denial = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    mockWebrtcHooks.getUserMedia = async () => {
      throw denial;
    };
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);

    await useCallsStore.getState().startCall(PEER, 'video');

    expect(signal.sendInvite).not.toHaveBeenCalled();
    expect(useCallsStore.getState().active).toBeNull();
    expect(useCallsStore.getState().errorCode).toBe('permission-denied');
  });
});

describe('caller signaling — offer/answer', () => {
  it('creates and sends an offer once the callee accepts', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    await useCallsStore.getState().startCall(PEER, 'audio');

    const accepted: CallAcceptedEvent = {
      callId: 'call-1',
      callerId: SELF,
      calleeId: PEER,
      type: 'audio',
      connectedAt: new Date().toISOString(),
    };
    await useCallsStore.getState().onAccepted(accepted);

    expect(useCallsStore.getState().active?.state).toBe('connecting');
    expect(signal.sendSignal).toHaveBeenCalledWith(
      'call-1',
      PEER,
      expect.objectContaining({ kind: 'offer', sdp: 'OFFER_SDP' })
    );
  });

  it('transitions to connected when the answer arrives', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    await useCallsStore.getState().startCall(PEER, 'audio');
    await useCallsStore.getState().onAccepted({
      callId: 'call-1',
      callerId: SELF,
      calleeId: PEER,
      type: 'audio',
      connectedAt: new Date().toISOString(),
    });

    const answer: CallSignalEvent<CallSignalBody> = {
      callId: 'call-1',
      from: PEER,
      payload: { kind: 'answer', sdp: 'ANSWER_SDP' },
    };
    await useCallsStore.getState().onSignal(answer);

    expect(useCallsStore.getState().active?.state).toBe('connected');
    expect(mockWebrtcHooks.lastPeer?.remoteDescription?.type).toBe('answer');
  });
});

describe('incoming call (callee)', () => {
  it('stores the incoming call when idle', () => {
    useCallsStore.getState()._setSignalSender(makeSignal());
    useCallsStore.getState().onIncoming(incomingEvent());

    expect(useCallsStore.getState().incoming).toMatchObject({
      callId: 'call-1',
      peerId: PEER,
      type: 'audio',
    });
  });

  it('auto-declines an incoming call while already busy', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    // Become busy with an outgoing call first.
    await useCallsStore.getState().startCall(PEER, 'audio');

    useCallsStore.getState().onIncoming(incomingEvent({ callId: 'call-2', callerId: 'other' }));

    expect(signal.sendDecline).toHaveBeenCalledWith('call-2');
    expect(useCallsStore.getState().incoming).toBeNull();
  });

  it('accepts an incoming call: acquires media and sends accept', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    useCallsStore.getState().onIncoming(incomingEvent());

    await useCallsStore.getState().acceptIncoming('call-1');

    const { active, incoming } = useCallsStore.getState();
    expect(incoming).toBeNull();
    expect(active).toMatchObject({ callId: 'call-1', role: 'callee', state: 'connecting' });
    expect(signal.sendAccept).toHaveBeenCalledWith('call-1');
  });

  it('answers an offer with an answer and reaches connected', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    useCallsStore.getState().onIncoming(incomingEvent());
    await useCallsStore.getState().acceptIncoming('call-1');

    const offer: CallSignalEvent<CallSignalBody> = {
      callId: 'call-1',
      from: PEER,
      payload: { kind: 'offer', sdp: 'OFFER_SDP' },
    };
    await useCallsStore.getState().onSignal(offer);

    expect(signal.sendSignal).toHaveBeenCalledWith(
      'call-1',
      PEER,
      expect.objectContaining({ kind: 'answer', sdp: 'ANSWER_SDP' })
    );
    expect(useCallsStore.getState().active?.state).toBe('connected');
  });

  it('declines an incoming call and clears it', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    useCallsStore.getState().onIncoming(incomingEvent());

    await useCallsStore.getState().decline('call-1');

    expect(signal.sendDecline).toHaveBeenCalledWith('call-1');
    expect(useCallsStore.getState().incoming).toBeNull();
  });

  it('surfaces accept-failed and declines when media is denied on accept', async () => {
    const denial = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    mockWebrtcHooks.getUserMedia = async () => {
      throw denial;
    };
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    useCallsStore.getState().onIncoming(incomingEvent());

    await useCallsStore.getState().acceptIncoming('call-1');

    expect(useCallsStore.getState().active).toBeNull();
    expect(useCallsStore.getState().incoming).toBeNull();
    expect(useCallsStore.getState().errorCode).toBe('permission-denied');
    // The caller is told we couldn't take it.
    expect(signal.sendDecline).toHaveBeenCalledWith('call-1');
  });
});

describe('answered-elsewhere & terminal events', () => {
  it('dismisses a ringing incoming call when answered on another device', () => {
    useCallsStore.getState()._setSignalSender(makeSignal());
    useCallsStore.getState().onIncoming(incomingEvent());

    useCallsStore.getState().onAnsweredElsewhere({ callId: 'call-1', calleeId: SELF, answeringDeviceId: 7 });

    expect(useCallsStore.getState().incoming).toBeNull();
  });

  it('does not touch an unrelated incoming call on answered-elsewhere', () => {
    useCallsStore.getState()._setSignalSender(makeSignal());
    useCallsStore.getState().onIncoming(incomingEvent({ callId: 'call-9' }));

    useCallsStore.getState().onAnsweredElsewhere({ callId: 'call-1', calleeId: SELF });

    expect(useCallsStore.getState().incoming?.callId).toBe('call-9');
  });

  it('tears down the active call when the peer ends it', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    await useCallsStore.getState().startCall(PEER, 'audio');
    const pc = mockWebrtcHooks.lastPeer;

    useCallsStore.getState().onEnded({
      callId: 'call-1',
      callerId: SELF,
      calleeId: PEER,
      status: 'completed',
      endedBy: PEER,
      endedAt: new Date().toISOString(),
    });

    expect(useCallsStore.getState().active).toBeNull();
    expect(pc?.closed).toBe(true);
  });

  it('clears active on decline of our outgoing call', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    await useCallsStore.getState().startCall(PEER, 'audio');

    useCallsStore.getState().onDeclined({ callId: 'call-1', callerId: SELF, calleeId: PEER, endedBy: PEER });

    expect(useCallsStore.getState().active).toBeNull();
  });

  it('clears the incoming overlay when the caller cancels', () => {
    useCallsStore.getState()._setSignalSender(makeSignal());
    useCallsStore.getState().onIncoming(incomingEvent());

    useCallsStore.getState().onCanceled({ callId: 'call-1', callerId: PEER, calleeId: SELF, endedBy: PEER });

    expect(useCallsStore.getState().incoming).toBeNull();
  });
});

describe('connection loss', () => {
  it('ends the call and surfaces connection-lost when ICE fails', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    await useCallsStore.getState().startCall(PEER, 'audio');

    // Simulate ICE failing on the live peer connection.
    mockWebrtcHooks.lastPeer?.fireIceState('failed');
    // handleIceFailure is async (awaits sendEnd); flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(signal.sendEnd).toHaveBeenCalledWith('call-1');
    expect(useCallsStore.getState().active).toBeNull();
    expect(useCallsStore.getState().errorCode).toBe('connection-lost');
  });

  it('tears down a still-connecting call when the signaling socket drops', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    // Caller in the `ringing` state (no media path established yet).
    await useCallsStore.getState().startCall(PEER, 'audio');

    useCallsStore.getState().onConnectionLost();

    expect(useCallsStore.getState().active).toBeNull();
    expect(useCallsStore.getState().errorCode).toBe('connection-lost');
  });

  it('preserves a CONNECTED call when the signaling socket drops (media is p2p)', async () => {
    const signal = makeSignal();
    useCallsStore.getState()._setSignalSender(signal);
    await useCallsStore.getState().startCall(PEER, 'audio');
    await useCallsStore.getState().onAccepted({
      callId: 'call-1',
      callerId: SELF,
      calleeId: PEER,
      type: 'audio',
      connectedAt: new Date().toISOString(),
    });
    // Drive to connected via the answer.
    await useCallsStore.getState().onSignal({
      callId: 'call-1',
      from: PEER,
      payload: { kind: 'answer', sdp: 'ANSWER_SDP' },
    });
    expect(useCallsStore.getState().active?.state).toBe('connected');

    useCallsStore.getState().onConnectionLost();

    // The connected call survives a transient signaling drop.
    expect(useCallsStore.getState().active?.state).toBe('connected');
    expect(useCallsStore.getState().errorCode).toBeNull();
  });

  it('dismisses a pending incoming overlay on connection loss', () => {
    useCallsStore.getState()._setSignalSender(makeSignal());
    useCallsStore.getState().onIncoming(incomingEvent());

    useCallsStore.getState().onConnectionLost();

    expect(useCallsStore.getState().incoming).toBeNull();
    expect(useCallsStore.getState().errorCode).toBe('connection-lost');
  });

  it('connection loss is a no-op when idle', () => {
    useCallsStore.getState()._setSignalSender(makeSignal());
    useCallsStore.getState().onConnectionLost();
    expect(useCallsStore.getState().errorCode).toBeNull();
  });
});

describe('media controls', () => {
  it('toggles mute by disabling the audio tracks', async () => {
    useCallsStore.getState()._setSignalSender(makeSignal());
    await useCallsStore.getState().startCall(PEER, 'audio');

    useCallsStore.getState().toggleMute();
    expect(useCallsStore.getState().active?.muted).toBe(true);

    useCallsStore.getState().toggleMute();
    expect(useCallsStore.getState().active?.muted).toBe(false);
  });

  it('toggles the camera flag on a video call', async () => {
    useCallsStore.getState()._setSignalSender(makeSignal());
    await useCallsStore.getState().startCall(PEER, 'video');

    expect(useCallsStore.getState().active?.cameraOn).toBe(true);
    useCallsStore.getState().toggleCamera();
    expect(useCallsStore.getState().active?.cameraOn).toBe(false);
  });
});
