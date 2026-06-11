/**
 * useRealtimeStatus wiring tests.
 *
 * `ensureStatusWired` attaches `statusCreated` / `statusViewed` / `statusDeleted`
 * listeners to the SHARED `/messaging` socket (from `getMessagingSocket`)
 * exactly once per socket id, re-wiring on reconnect, and routes each event into
 * the status store. We drive it directly with a fake socket (a tiny event
 * emitter) and a mocked `getMessagingSocket` — a focused unit test with no real
 * socket and no React rendering, mirroring how presence wiring is verified.
 *
 * Cases use DISTINCT socket ids because the wire-tracking state is module-level
 * (it must persist across hook mounts in production); unique ids keep cases
 * independent without exposing a test-only reset.
 */

// Returned by the mocked accessor; reassigned per test.
let mockSocket: FakeSocket | null = null;

jest.mock('@/hooks/useRealtimeMessaging', () => ({
  __esModule: true,
  getMessagingSocket: jest.fn(() => mockSocket),
}));

// `useRealtimeStatus.ts` imports the device-keys store (used only by the React
// hook, not by `ensureStatusWired`). Stub it so importing the module doesn't
// pull in expo-constants / the Signal layer for this pure wiring test.
jest.mock('@/stores/deviceKeysStore', () => ({
  __esModule: true,
  useDeviceKeysStore: jest.fn(),
}));

// The status store imports `@/utils/api` (which touches the Oxy client at load).
// `ensureStatusWired` only drives the store's realtime `apply*` reducers — no
// network — so a bare api stub keeps the store importable.
jest.mock('@/utils/api', () => ({
  __esModule: true,
  api: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));

// `@oxyhq/services` is globally mocked as {} in jest.setup; the hook only reads
// `useOxy`, which `ensureStatusWired` doesn't call, so no further mock needed.

// eslint-disable-next-line import/first
import { ensureStatusWired } from '@/hooks/useRealtimeStatus';
// eslint-disable-next-line import/first
import { useStatusStore, Status } from '@/stores/statusStore';

const OWNER = 'owner-user';
const SELF = 'self-user';

type Handler = (payload: unknown) => void;

/** Minimal socket.io-client stand-in: tracks handlers and emits to them. */
class FakeSocket {
  id: string | undefined;
  connected: boolean;
  private handlers = new Map<string, Handler[]>();

  constructor(id: string | undefined, connected: boolean) {
    this.id = id;
    this.connected = connected;
  }

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  off(event: string): this {
    this.handlers.delete(event);
    return this;
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }

  handlerCount(event: string): number {
    return (this.handlers.get(event) ?? []).length;
  }

  /** Simulate the socket connecting (assigns an id, fires `connect`). */
  connect(id: string): void {
    this.id = id;
    this.connected = true;
    this.emit('connect', undefined);
  }
}

function makeStatus(id: string, userId: string): Status {
  return {
    id,
    userId,
    type: 'text',
    text: 'hi',
    audience: { type: 'all-contacts', userIds: [] },
    viewers: [],
    createdAt: '2026-06-11T10:00:00.000Z',
    expiresAt: '2026-06-12T10:00:00.000Z',
  };
}

beforeEach(() => {
  mockSocket = null;
  useStatusStore.getState().reset();
});

describe('ensureStatusWired', () => {
  it('wires the three status listeners onto a connected socket', () => {
    mockSocket = new FakeSocket('s-listeners', true);
    ensureStatusWired(SELF);

    expect(mockSocket.handlerCount('statusCreated')).toBe(1);
    expect(mockSocket.handlerCount('statusViewed')).toBe(1);
    expect(mockSocket.handlerCount('statusDeleted')).toBe(1);
  });

  it('routes statusCreated from another author into a group', () => {
    mockSocket = new FakeSocket('s-created', true);
    ensureStatusWired(SELF);

    mockSocket.emit('statusCreated', {
      status: makeStatus('a1', OWNER),
      author: { id: OWNER, userId: OWNER },
    });

    const groups = useStatusStore.getState().groups;
    expect(groups).toHaveLength(1);
    expect(groups[0].userId).toBe(OWNER);
  });

  it('routes the current user\'s own statusCreated into myStatus', () => {
    mockSocket = new FakeSocket('s-created-own', true);
    ensureStatusWired(SELF);

    mockSocket.emit('statusCreated', { status: makeStatus('own1', SELF) });

    expect(useStatusStore.getState().myStatus).toHaveLength(1);
    expect(useStatusStore.getState().groups).toHaveLength(0);
  });

  it('applies statusViewed only when the current user owns the status', () => {
    mockSocket = new FakeSocket('s-viewed', true);
    useStatusStore.setState({ myStatus: [makeStatus('own1', SELF)] });
    ensureStatusWired(SELF);

    // Owned by SELF → applied.
    mockSocket.emit('statusViewed', {
      statusId: 'own1',
      ownerId: SELF,
      viewerId: 'v1',
      viewedAt: '2026-06-11T10:30:00.000Z',
    });
    expect(useStatusStore.getState().myStatus[0].viewers).toHaveLength(1);

    // Owned by someone else → ignored.
    mockSocket.emit('statusViewed', {
      statusId: 'own1',
      ownerId: OWNER,
      viewerId: 'v2',
      viewedAt: '2026-06-11T10:31:00.000Z',
    });
    expect(useStatusStore.getState().myStatus[0].viewers).toHaveLength(1);
  });

  it('routes statusDeleted into the store', () => {
    mockSocket = new FakeSocket('s-deleted', true);
    useStatusStore.setState({
      groups: [
        {
          userId: OWNER,
          author: { id: OWNER, userId: OWNER },
          statuses: [makeStatus('a1', OWNER)],
          lastCreatedAt: '2026-06-11T10:00:00.000Z',
          hasUnviewed: true,
        },
      ],
    });
    ensureStatusWired(SELF);

    mockSocket.emit('statusDeleted', { statusId: 'a1', ownerId: OWNER });
    expect(useStatusStore.getState().groups).toHaveLength(0);
  });

  it('ignores a malformed statusCreated payload', () => {
    mockSocket = new FakeSocket('s-malformed', true);
    ensureStatusWired(SELF);

    mockSocket.emit('statusCreated', {});
    mockSocket.emit('statusCreated', { status: null });
    expect(useStatusStore.getState().groups).toHaveLength(0);
  });

  it('does not stack duplicate listeners when wired twice on the same socket', () => {
    mockSocket = new FakeSocket('s-idempotent', true);
    ensureStatusWired(SELF);
    ensureStatusWired(SELF); // second mount, same socket id

    expect(mockSocket.handlerCount('statusCreated')).toBe(1);
  });

  it('re-wires when the socket reconnects with a new id', () => {
    // Socket exists but is not yet connected (no id) on first wire attempt.
    mockSocket = new FakeSocket(undefined, false);
    ensureStatusWired(SELF);
    expect(mockSocket.handlerCount('statusCreated')).toBe(0);

    // It connects with a fresh id → the `connect` handler wires the listeners.
    mockSocket.connect('s-reconnect');
    expect(mockSocket.handlerCount('statusCreated')).toBe(1);
    expect(mockSocket.handlerCount('statusDeleted')).toBe(1);
  });
});
