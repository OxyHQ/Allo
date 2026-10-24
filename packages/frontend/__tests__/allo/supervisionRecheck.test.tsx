/**
 * A FAILED RE-CHECK OF SUPERVISION IS NOT A NEW ANSWER.
 *
 * `useSupervision()` hides its retained value whenever a fetch fails (ADR 0041
 * in the Oxy repo), so returning to the foreground offline used to read as
 * "nobody knows yet": `AlloRoot` stopped the client — dropping a live call,
 * the socket and sync — drew "checking", and built a new client once the
 * check came back. The last answer for the same account and session now
 * stands until a NEW successful answer differs; first load still waits, and
 * an account that becomes supervised switches at once.
 */
import type React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('@/components/calls/CallNotice', () => ({ CallNotice: () => null }));
jest.mock('@/components/calls/CallAudio', () => ({ CallAudio: () => null }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/lib/allo/nativeCallBridge', () => ({ nativeCallBridge: null }));
jest.mock('@/lib/allo/nativeCalls', () => ({ startNativeCalls: () => () => undefined }));
jest.mock('@/lib/allo/push', () => ({
  registerPushToken: async () => false,
  onPushPermissionGranted: () => () => undefined,
}));
jest.mock('@/lib/allo/people', () => ({ configurePeople: jest.fn() }));
jest.mock('@/lib/allo/RestoreHistoryPrompt', () => ({ RestoreHistoryPrompt: () => null }));
jest.mock('@/lib/allo/signOut', () => ({ signOutOfAllo: jest.fn() }));
jest.mock('@/lib/allo/EnrollmentGate', () => ({
  EnrollmentGate: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/lib/allo/ConversationAccessState', () => {
  const { Text: MockText } = require('react-native');
  return {
    ConversationAccessState: ({ state }: { state: string }) => (
      <MockText>{`access:${state}`}</MockText>
    ),
  };
});
jest.mock('@allo/react', () => ({
  AlloProvider: ({ children }: { children: React.ReactNode }) => children,
  useAlloClient: () => null,
  useInstanceState: () => ({ state: 'pending' }),
}));

interface MockClient {
  id: number;
  supervised: boolean;
  start: jest.Mock<Promise<void>, []>;
  stop: jest.Mock<Promise<void>, []>;
}
const mockClients: MockClient[] = [];
jest.mock('@/lib/allo/client', () => ({
  APP_ID: 'allo',
  createAppAlloClient: async ({ supervised }: { supervised: boolean }) => {
    const client: MockClient = {
      id: mockClients.length + 1,
      supervised,
      start: jest.fn(async () => undefined),
      stop: jest.fn(async () => undefined),
    };
    mockClients.push(client);
    return client;
  },
}));

type Supervision = {
  data: { self: { status: string } | null } | undefined;
  isError: boolean;
  error: unknown;
  errorUpdatedAt: number;
};
const offline = Object.assign(new Error('offline'), { status: 0 });
const answered = (self: { status: string } | null): Supervision => ({
  data: { self },
  isError: false,
  error: null,
  errorUpdatedAt: 0,
});
const failed = (at: number): Supervision => ({
  data: undefined,
  isError: true,
  error: offline,
  errorUpdatedAt: at,
});
const pending: Supervision = { data: undefined, isError: false, error: null, errorUpdatedAt: 0 };

let mockSupervision: Supervision = pending;
const mockSession = { user: { id: 'acc-recheck', kind: 'personal' }, activeSessionId: 's-1' };
const mockRefetch = jest.fn(async () => undefined);
jest.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ ...mockSession, isLoading: false, oxyServices: {}, logout: jest.fn() }),
  useSupervision: () => ({ ...mockSupervision, refetch: mockRefetch }),
}));

const { AlloRoot } = require('@/lib/allo/AlloRoot') as typeof import('@/lib/allo/AlloRoot');

let tree: TestRenderer.ReactTestRenderer | null = null;
const shown = () => {
  if (!tree) throw new Error('nothing rendered yet');
  return tree.root
    .findAllByType(Text)
    .map((node) => node.props.children)
    .join('|');
};
const app = () => (
  <AlloRoot>
    <Text>app</Text>
  </AlloRoot>
);
/** Sets what the hook answers and lets the effects and the client build settle. */
async function answer(next: Supervision) {
  mockSupervision = next;
  await act(async () => {
    if (tree) tree.update(app());
    else tree = TestRenderer.create(app());
  });
  await act(async () => undefined);
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  mockClients.length = 0;
  mockRefetch.mockClear();
  mockSupervision = pending;
  mockSession.user = { id: 'acc-recheck', kind: 'personal' };
  mockSession.activeSessionId = 's-1';
});
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = null;
  jest.useRealTimers();
});

describe('a supervision re-check', () => {
  it('that fails keeps the same client running and never says "checking"', async () => {
    await answer(answered(null));
    expect(shown()).toBe('app');
    expect(mockClients).toHaveLength(1);
    const [client] = mockClients;
    expect(client.supervised).toBe(false);
    expect(client.start).toHaveBeenCalledTimes(1);

    // Back in the foreground offline: the hook drops its data and reports the error.
    await answer(failed(1));
    expect(shown()).toBe('app');
    // The automatic retries run and fail too; still nothing moves.
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
    expect(mockRefetch).toHaveBeenCalled();
    await answer(failed(2));
    await answer(failed(3));
    await answer(failed(4));
    expect(shown()).toBe('app');

    // The same answer comes back: still the same client.
    await answer(answered(null));
    expect(shown()).toBe('app');
    expect(mockClients).toHaveLength(1);
    expect(client.stop).not.toHaveBeenCalled();
    expect(client.start).toHaveBeenCalledTimes(1);
  });

  it('that fails keeps a supervised account supervised', async () => {
    await answer(answered({ status: 'active' }));
    expect(mockClients.map((c) => c.supervised)).toEqual([true]);
    await answer(failed(1));
    expect(shown()).toBe('app');
    expect(mockClients).toHaveLength(1);
    expect(mockClients[0].stop).not.toHaveBeenCalled();
  });

  it('that answers differently rebuilds the client in the new mode at once', async () => {
    await answer(answered(null));
    await answer(failed(1));
    await answer(answered({ status: 'active' }));
    expect(mockClients.map((c) => c.supervised)).toEqual([false, true]);
    expect(mockClients[0].stop).toHaveBeenCalledTimes(1);
    expect(shown()).toBe('app');
  });
});

describe('without an answer for this account and session', () => {
  it('a first load that fails waits, then says it cannot check, and builds nothing', async () => {
    await answer(failed(1));
    expect(shown()).toBe('access:checking');
    await answer(failed(2));
    await answer(failed(3));
    await answer(failed(4));
    expect(shown()).toBe('access:unavailable');
    expect(mockClients).toHaveLength(0);
    await answer(answered(null));
    expect(shown()).toBe('app');
    expect(mockClients).toHaveLength(1);
  });

  it("a new session does not inherit the previous one's answer", async () => {
    await answer(answered(null));
    expect(mockClients).toHaveLength(1);
    mockSession.activeSessionId = 's-2';
    await answer(failed(1));
    expect(shown()).toBe('access:checking');
    expect(mockClients[0].stop).toHaveBeenCalledTimes(1);
    expect(mockClients).toHaveLength(1);
  });

  it('a session that went away and came back is asked afresh', async () => {
    await answer(answered(null));
    mockSession.user = null as unknown as typeof mockSession.user;
    await answer(pending);
    mockSession.user = { id: 'acc-recheck', kind: 'personal' };
    await answer(failed(1));
    expect(shown()).toBe('access:checking');
  });
});
