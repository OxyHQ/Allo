/**
 * The call state machine, without a call.
 *
 * `lib/phase2/calls.ts` is the seam a transport replaces, so what is pinned
 * here is the part that has to survive the swap: which states follow which,
 * what a finished call is filed as, and the strings the log screen draws.
 * Rendering is not covered and cannot be — a Bloom chat surface under jest dies
 * in reanimated's native worklets — so the screens are checked in a browser.
 */
import {
  callDurationMs,
  callHistorySections,
  formatCallDuration,
  logDirection,
  useCallsStore,
  type CallLogEntry,
  type CallSession,
} from '@/lib/phase2/calls';

const ANA = '6700000000000000000000a2';
const TEODOR = '6700000000000000000000a3';

const store = () => useCallsStore.getState();

function reset() {
  useCallsStore.setState({ session: null, log: [] });
}

function session(overrides: Partial<CallSession> = {}): CallSession {
  return {
    id: 'c1',
    conversationId: ANA,
    peers: [{ accountId: ANA }],
    mode: 'voice',
    incoming: false,
    status: 'active',
    startedAt: 1_000,
    muted: false,
    speaker: false,
    videoOn: false,
    screenSharing: false,
    cameraFacing: 'front',
    minimised: false,
    pipCorner: 'top-right',
    ...overrides,
  };
}

beforeEach(reset);

describe('formatCallDuration', () => {
  it('shows the hour only once there is one', () => {
    expect(formatCallDuration(0)).toBe('00:00');
    expect(formatCallDuration(42_000)).toBe('00:42');
    expect(formatCallDuration(12 * 60_000 + 7_000)).toBe('12:07');
    expect(formatCallDuration(3_600_000 + 4 * 60_000 + 11_000)).toBe('1:04:11');
  });

  it('never counts backwards', () => {
    expect(formatCallDuration(-5_000)).toBe('00:00');
  });
});

describe('callDurationMs', () => {
  it('is zero until the call connects', () => {
    expect(callDurationMs(session({ status: 'ringing', connectedAt: undefined }), 9_999)).toBe(0);
    expect(callDurationMs(null, 9_999)).toBe(0);
  });

  it('counts from the moment media started, not from the moment it was placed', () => {
    expect(callDurationMs(session({ startedAt: 1_000, connectedAt: 5_000 }), 8_000)).toBe(3_000);
  });
});

describe('logDirection', () => {
  it('files a call WE placed and nobody took as outgoing, never missed', () => {
    // `missed` is what the person who was called sees. Drawing it on the
    // caller's own log tells them they ignored their own call.
    expect(logDirection(session({ incoming: false, connectedAt: undefined }), 'ended')).toBe(
      'outgoing',
    );
  });

  it('files an unanswered incoming call as missed', () => {
    expect(logDirection(session({ incoming: true, connectedAt: undefined }), 'ended')).toBe('missed');
  });

  it('keeps the two connected directions apart', () => {
    expect(logDirection(session({ incoming: true, connectedAt: 2_000 }), 'ended')).toBe('incoming');
    expect(logDirection(session({ incoming: false, connectedAt: 2_000 }), 'ended')).toBe('outgoing');
  });

  it('lets an explicit outcome win over what the call looked like', () => {
    expect(logDirection(session({ incoming: true, connectedAt: 2_000 }), 'declined')).toBe('declined');
    expect(logDirection(session({ incoming: false }), 'missed')).toBe('missed');
  });
});

describe('the state machine', () => {
  it('walks an outgoing call from placed to connected', () => {
    store().place({ conversationId: ANA, peerAccountIds: [ANA] });
    expect(store().session?.status).toBe('calling');
    expect(store().session?.incoming).toBe(false);

    store().markRinging();
    expect(store().session?.status).toBe('ringing');

    store().connect();
    expect(store().session?.status).toBe('active');
    expect(store().session?.connectedAt).toBeDefined();
  });

  it('a video call starts with the camera on and a voice call does not', () => {
    store().place({ conversationId: ANA, peerAccountIds: [ANA], mode: 'video' });
    expect(store().session?.videoOn).toBe(true);
    reset();
    store().place({ conversationId: ANA, peerAccountIds: [ANA] });
    expect(store().session?.videoOn).toBe(false);
  });

  it('an incoming call arrives ringing and only it can be answered', () => {
    store().receive({ conversationId: ANA, peerAccountIds: [ANA] });
    expect(store().session?.status).toBe('ringing');
    store().answer();
    expect(store().session?.status).toBe('connecting');

    reset();
    store().place({ conversationId: ANA, peerAccountIds: [ANA] });
    store().answer();
    expect(store().session?.status).toBe('calling');
  });

  it('holds only a live call, and coming off hold puts it back', () => {
    store().place({ conversationId: ANA, peerAccountIds: [ANA] });
    store().setHold(true);
    expect(store().session?.status).toBe('calling');

    store().connect();
    store().setHold(true);
    expect(store().session?.status).toBe('onHold');
    store().setHold(false);
    expect(store().session?.status).toBe('active');
  });

  it('keeps `connectedAt` when the call comes back from a reconnect', () => {
    store().place({ conversationId: ANA, peerAccountIds: [ANA] });
    store().connect();
    const connectedAt = store().session?.connectedAt;
    store().markReconnecting();
    store().connect();
    expect(store().session?.connectedAt).toBe(connectedAt);
  });

  it('toggles the device controls', () => {
    store().place({ conversationId: ANA, peerAccountIds: [ANA] });
    store().setMuted(true);
    store().setSpeaker(true);
    store().setScreenSharing(true);
    store().flipCamera();
    store().movePip('bottom-left');
    store().setMinimised(true);
    expect(store().session).toMatchObject({
      muted: true,
      speaker: true,
      screenSharing: true,
      cameraFacing: 'back',
      pipCorner: 'bottom-left',
      minimised: true,
    });
    store().flipCamera();
    expect(store().session?.cameraFacing).toBe('front');
  });

  it('marks exactly one person as speaking', () => {
    store().place({ conversationId: ANA, peerAccountIds: [ANA, TEODOR] });
    store().setSpeaking(TEODOR);
    expect(store().session?.peers.map((peer) => peer.speaking)).toEqual([false, true]);
    store().setSpeaking(undefined);
    expect(store().session?.peers.map((peer) => peer.speaking)).toEqual([false, false]);
  });

  it('files the call when it ends, and clears it', () => {
    store().place({ conversationId: ANA, peerAccountIds: [ANA], mode: 'video' });
    store().connect();
    store().end();

    expect(store().session).toBeNull();
    expect(store().log).toHaveLength(1);
    expect(store().log[0]).toMatchObject({
      conversationId: ANA,
      peerAccountIds: [ANA],
      mode: 'video',
      direction: 'outgoing',
    });
  });

  it('files a declined call as declined and a dropped one as missed', () => {
    store().receive({ conversationId: ANA, peerAccountIds: [ANA] });
    store().decline();
    expect(store().log[0].direction).toBe('declined');
    expect(store().log[0].durationMs).toBe(0);

    store().receive({ conversationId: TEODOR, peerAccountIds: [TEODOR] });
    store().missed();
    expect(store().log[0].direction).toBe('missed');
    expect(store().log).toHaveLength(2);
  });

  it('does nothing at all when there is no call', () => {
    store().connect();
    store().end();
    store().setMuted(true);
    expect(store().session).toBeNull();
    expect(store().log).toEqual([]);
  });
});

describe('callHistorySections', () => {
  const NOW = new Date('2026-09-18T20:00:00');
  const t = (key: string) => key;
  const copy = {
    now: NOW,
    locale: 'en-US',
    t,
    nameFor: (ids: readonly string[]) => (ids.length === 1 ? 'Ana Restrepo' : 'Ana and 1 more'),
    avatarFor: (ids: readonly string[]) => (ids.length === 1 ? 'ana' : undefined),
  };

  const entry = (overrides: Partial<CallLogEntry> = {}): CallLogEntry => ({
    id: 'e1',
    conversationId: ANA,
    peerAccountIds: [ANA],
    mode: 'voice',
    direction: 'outgoing',
    at: new Date('2026-09-18T09:14:00').getTime(),
    durationMs: 0,
    ...overrides,
  });

  it('groups by day, newest first, with one heading per day', () => {
    const sections = callHistorySections(
      [
        entry({ id: 'older', at: new Date('2026-09-17T18:40:00').getTime() }),
        entry({ id: 'newer', at: new Date('2026-09-18T11:00:00').getTime() }),
        entry({ id: 'newest', at: new Date('2026-09-18T19:00:00').getTime() }),
      ],
      copy,
    );

    expect(sections.map((section) => section.title)).toEqual([
      'chat.day.today',
      'chat.day.yesterday',
    ]);
    expect(sections[0].items.map((item) => item.id)).toEqual(['newest', 'newer']);
    expect(sections[1].items.map((item) => item.id)).toEqual(['older']);
  });

  it('puts the length on the second line only when the call connected', () => {
    const [today] = callHistorySections(
      [entry({ id: 'missed', durationMs: 0 }), entry({ id: 'talked', durationMs: 272_000 })],
      copy,
    );
    const meta = Object.fromEntries(today.items.map((item) => [item.id, item.meta]));

    expect(meta.missed).not.toContain('·');
    // The same spelling as the live timer on the call screen: a log entry is
    // that timer's last value, and two formats for one number is how "4:32"
    // and "04:32" end up on screen a tap apart.
    expect(meta.talked).toContain('· 04:32');
  });

  it('draws an avatar for one person and none for a group', () => {
    const [today] = callHistorySections(
      [entry({ id: 'solo' }), entry({ id: 'group', peerAccountIds: [ANA, TEODOR] })],
      copy,
    );
    const items = Object.fromEntries(today.items.map((item) => [item.id, item]));

    expect(items.solo.avatar).toBe('ana');
    expect(items.group.avatar).toBeUndefined();
    expect(items.group.name).toBe('Ana and 1 more');
  });

  it('is empty for an empty log', () => {
    expect(callHistorySections([], copy)).toEqual([]);
  });
});
