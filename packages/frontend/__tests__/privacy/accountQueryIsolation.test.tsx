/**
 * Allo's React Query cache stays strictly per account on Services 15, where the
 * app owns its client and its account scoping (`lib/query/accountQueryCache.ts`).
 *
 * This runs the app's own wiring: the module `queryClient`, the
 * `accountQueryCache` it is scoped by, `followOxyRuntime`, and the real privacy
 * hooks. Only the session runtime (published, then every subscriber woken in
 * one pass, as Services' runtime does) and the privacy endpoints are fakes.
 *
 * The story: A reads its settings; a read for A is still in flight when the
 * session switches to B; A's late answer lands; a write A started lands after
 * the switch; a write A queued offline would resume under B; B reads its own;
 * sign-out leaves nothing.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClientProvider, onlineManager } from '@tanstack/react-query';

let mockAccount: string | null = 'A';
jest.mock('@oxy.so/services/ui/client', () => ({
  useOxy: () => ({ user: mockAccount ? { id: mockAccount } : null }),
}));

type Settings = { showOnlineStatus: boolean; owner: string };
const mockApi = {
  fetchMyPrivacySettings: jest.fn<Promise<Settings>, []>(),
  updateMyPrivacySettings: jest.fn<Promise<Settings>, [Partial<Settings>]>(),
};
jest.mock('@/lib/privacy/api', () => ({
  DEFAULT_PRIVACY_SETTINGS: { showOnlineStatus: true, owner: 'default' },
  fetchMyPrivacySettings: () => mockApi.fetchMyPrivacySettings(),
  updateMyPrivacySettings: (patch: Partial<Settings>) => mockApi.updateMyPrivacySettings(patch),
  fetchBlockedUserIds: jest.fn(),
  blockUser: jest.fn(),
  unblockUser: jest.fn(),
}));

const { useMyPrivacySettings, useUpdatePrivacySettings } =
  require('@/hooks/usePrivacySettings') as typeof import('@/hooks/usePrivacySettings');
const { followOxyRuntime } =
  require('@/lib/query/accountQueryCache') as typeof import('@/lib/query/accountQueryCache');
const { accountQueryCache, queryClient } =
  require('@/lib/query/queryClient') as typeof import('@/lib/query/queryClient');
// No garbage-collection timers: a query or a mutation left for gc would keep Jest
// running for its gcTime after the last test (5 and 30 minutes).
queryClient.setDefaultOptions({
  queries: { ...queryClient.getDefaultOptions().queries, gcTime: Number.POSITIVE_INFINITY },
  mutations: { ...queryClient.getDefaultOptions().mutations, gcTime: Number.POSITIVE_INFINITY },
});

/** Services' runtime, reduced to what the cache follows: publish, then wake every subscriber in order. */
function createRuntime(account: string | null) {
  const listeners = new Set<() => void>();
  let snapshot = { account: account ? { id: account } : null };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    become(next: string | null) {
      snapshot = { account: next ? { id: next } : null };
      for (const listener of listeners) listener();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Everything the client holds right now, whatever key it sits under. */
const held = () =>
  JSON.stringify([
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => [query.queryKey, query.state.data]),
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.variables),
  ]);

type Update = ReturnType<typeof useUpdatePrivacySettings>;
let update: Update | null = null;
const holdUpdate = (next: Update) => {
  update = next;
};
/** Draws whose settings are on screen (the fakes add `owner`), and hands the test the save. */
function Probe({ onUpdate }: { onUpdate: (next: Update) => void }) {
  const { settings, saved } = useMyPrivacySettings();
  const save = useUpdatePrivacySettings();
  React.useEffect(() => onUpdate(save));
  return <>{saved ? (settings as unknown as { owner: string }).owner : ''}</>;
}

/** Lets React Query's batched notifications and React's renders run. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

afterEach(() => {
  queryClient.clear();
  onlineManager.setOnline(true);
});

it('never lets account A’s data be read, rendered or written for B: switch, late answers, sign-out', async () => {
  mockAccount = 'A';
  const runtime = createRuntime('A');
  // React hears the session first; the cache's listener comes second and
  // still runs before anything renders for the new account.
  runtime.subscribe(() => {
    mockAccount = runtime.getSnapshot().account?.id ?? null;
  });
  const unfollow = followOxyRuntime(accountQueryCache, runtime);

  mockApi.fetchMyPrivacySettings.mockResolvedValueOnce({ showOnlineStatus: true, owner: 'A-own' });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Probe onUpdate={holdUpdate} />
      </QueryClientProvider>,
    );
  });
  await settle();
  expect(tree.toJSON()).toBe('A-own');

  // A refreshes (still in flight) and saves a change (its answer still pending).
  const lateRead = deferred<Settings>();
  mockApi.fetchMyPrivacySettings.mockReturnValueOnce(lateRead.promise);
  const lateWrite = deferred<Settings>();
  mockApi.updateMyPrivacySettings.mockReturnValueOnce(lateWrite.promise);
  await act(async () => {
    void queryClient.invalidateQueries();
    update?.mutate({ showOnlineStatus: false });
  });
  expect(mockApi.updateMyPrivacySettings).toHaveBeenCalledTimes(1);

  // The session moves to B.
  const bRead = deferred<Settings>();
  mockApi.fetchMyPrivacySettings.mockReturnValue(bRead.promise);
  act(() => runtime.become('B'));
  expect(held()).not.toContain('A-');

  // A's late answers land after the switch: in neither the screen nor B's cache.
  await act(async () => {
    lateRead.resolve({ showOnlineStatus: true, owner: 'A-late-read' });
    lateWrite.resolve({ showOnlineStatus: false, owner: 'A-late-write' });
    await Promise.all([lateRead.promise, lateWrite.promise]);
  });
  await settle();
  expect(held()).not.toContain('A-');
  expect(tree.toJSON()).toBeNull();

  // B reads its own.
  await act(async () => {
    bRead.resolve({ showOnlineStatus: true, owner: 'B-own' });
    await bRead.promise;
  });
  await settle();
  expect(tree.toJSON()).toBe('B-own');
  expect(held()).not.toContain('A-');

  // Sign-out: nothing of anybody's is held.
  act(() => runtime.become(null));
  expect(held()).not.toContain('B-own');

  act(() => tree.unmount());
  unfollow();
});

it('refuses a write A’s screen sends after the session moved to B', async () => {
  mockAccount = 'A';
  const runtime = createRuntime('A');
  runtime.subscribe(() => {
    mockAccount = runtime.getSnapshot().account?.id ?? null;
  });
  const unfollow = followOxyRuntime(accountQueryCache, runtime);
  // Each account's own settings: whoever the session is when the read is sent.
  mockApi.fetchMyPrivacySettings.mockImplementation(async () => ({
    showOnlineStatus: true,
    owner: `${mockAccount}-own`,
  }));
  mockApi.updateMyPrivacySettings.mockClear();

  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Probe onUpdate={holdUpdate} />
      </QueryClientProvider>,
    );
  });
  await settle();
  // The handler A's render holds, pressed after the switch (before React redraws for B).
  const staleUpdate = update;
  act(() => runtime.become('B'));
  await act(async () => {
    staleUpdate?.mutate({ showOnlineStatus: false });
  });
  await settle();
  expect(mockApi.updateMyPrivacySettings).not.toHaveBeenCalled();
  expect(held()).not.toContain('A-');

  act(() => tree.unmount());
  unfollow();
});
