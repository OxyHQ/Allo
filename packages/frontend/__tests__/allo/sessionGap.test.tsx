import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { createAlloClient, testing, type AlloClient } from '@allo/core';

const { createFakeAlloServer, MemorySecrets, MemoryStorage, FakeSession } = testing;

const ACCOUNT = 'acc-session-gap';

// One server and one pair of stores for the whole file: they are the device's
// disk, and the point of the test is what survives on it.
const mockServer = createFakeAlloServer();
const mockStorage = new MemoryStorage();
const mockSecrets = new MemorySecrets();

let mockBuilt = 0;
const mockBuildClient = (): AlloClient => {
  mockBuilt += 1;
  return createAlloClient({
    baseUrl: mockServer.baseUrl,
    appId: 'allo',
    platform: 'web',
    displayName: 'Chrome',
    session: FakeSession.for(ACCOUNT),
    storage: mockStorage,
    secrets: mockSecrets,
    transport: { fetch: mockServer.fetch, socketFactory: mockServer.socketFactory },
    syncIntervalMs: 60_000,
  });
};

jest.mock('@/lib/allo/client', () => ({
  APP_ID: 'allo',
  createAppAlloClient: async () => mockBuildClient(),
}));
jest.mock('@/lib/allo/push', () => ({
  registerPushToken: async () => false,
  clearPushToken: async () => undefined,
  onPushPermissionGranted: () => () => undefined,
}));
jest.mock('@/lib/allo/RestoreHistoryPrompt', () => ({ RestoreHistoryPrompt: () => null }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en-US' },
  }),
}));

const mockSession: { user: { id: string } | null; isLoading: boolean } = {
  user: { id: ACCOUNT },
  isLoading: false,
};
const mockLogout = jest.fn();
jest.mock('@oxy.so/services', () => ({
  useOxy: () => ({ ...mockSession, oxyServices: {}, logout: mockLogout }),
}));

// Imported after the mocks, the way jest requires.
const { AlloRoot } = require('@/lib/allo/AlloRoot') as typeof import('@/lib/allo/AlloRoot');

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

const registrations = () =>
  mockServer.requestLog.filter((entry) => entry.method === 'POST' && entry.path === '/v1/instances')
    .length;

describe('a session that goes away', () => {
  it('keeps this device enrolled and enrols nothing new when the session comes back', async () => {
    let tree: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <AlloRoot>
          <Text>app</Text>
        </AlloRoot>,
      );
    });
    await settle();
    expect(registrations()).toBe(1);
    const enrolled = await mockStorage.get(`allo/allo/${ACCOUNT}/self`);
    expect(enrolled).toBeDefined();
    const signingKey = await mockSecrets.get(`allo.instance-key.${ACCOUNT}.allo`);
    expect(signingKey).toBeDefined();

    // The bearer 401s somewhere and Oxy reports a signed-out session. This is
    // the moment that used to wipe the device.
    await act(async () => {
      mockSession.user = null;
      tree!.update(
        <AlloRoot>
          <Text>app</Text>
        </AlloRoot>,
      );
    });
    await settle();

    // Nothing of this device may have been destroyed, and nothing revoked.
    expect(await mockSecrets.get(`allo.instance-key.${ACCOUNT}.allo`)).toEqual(signingKey);
    expect(await mockStorage.get(`allo/allo/${ACCOUNT}/self`)).toEqual(enrolled);
    expect(mockServer.requestLog.some((e) => e.path.includes('/revoke'))).toBe(false);

    // Oxy restores the session, as it was always going to.
    await act(async () => {
      mockSession.user = { id: ACCOUNT };
      tree!.update(
        <AlloRoot>
          <Text>app</Text>
        </AlloRoot>,
      );
    });
    await settle();

    // The same instance, still active, and the server was never asked to
    // enrol a second one — which is what the "approve this device" screen is.
    expect(registrations()).toBe(1);
    expect(await mockStorage.get(`allo/allo/${ACCOUNT}/self`)).toEqual(enrolled);
    expect(mockBuilt).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
