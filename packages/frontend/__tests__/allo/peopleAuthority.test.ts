import { PeopleResolver, configurePeople, people, type UsersLookupResult } from '@/lib/allo/people';
import { useUsersStore, type UserEntity } from '@/stores/usersStore';
const mockPublic = jest.fn();
const mockMinimal = jest.fn();
jest.mock('@/lib/oxy', () => ({
  oxyServices: {
    users: {
      getMany: (ids: string[]) => mockPublic(ids),
      lookupMany: (ids: string[]) => mockPublic(ids),
    },
    safety: { people: (input: unknown) => mockMinimal(input) },
  },
}));
beforeEach(() => {
  configurePeople('unknown');
  mockPublic.mockReset();
  mockMinimal.mockReset();
});
it('cannot restore a previous account’s rich profile after the session cache is cleared', async () => {
  let resolve!: (result: UsersLookupResult) => void;
  const resolver = new PeopleResolver(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = resolver.load(['person']);
  resolver.clear();
  resolve({
    users: [
      {
        id: 'person',
        username: 'person',
        name: { displayName: 'Old account view' },
        avatar: 'private-avatar',
        bio: 'private bio',
      },
    ],
    missing: [],
    failed: [],
  });
  await pending;
  expect(useUsersStore.getState().getCachedById('person')).toBeUndefined();
});
it('uses bounded canonical minimal people and never falls back to public profiles', async () => {
  mockMinimal.mockImplementation(async (input: { accountIds: string[] }) => ({
    items: input.accountIds.map((accountId) => ({
      accountId,
      username: accountId,
      displayName: 'Approved person',
    })),
  }));
  configurePeople('supervised');
  const ids = Array.from({ length: 205 }, (_, i) => `person-${i}`);
  await people.load(ids);
  expect(mockMinimal.mock.calls.map(([input]) => input.accountIds.length)).toEqual([100, 100, 5]);
  expect(mockPublic).not.toHaveBeenCalled();
  expect(useUsersStore.getState().getCachedById(ids[0])).toMatchObject({
    id: ids[0],
    name: { displayName: 'Approved person' },
  });
  expect(useUsersStore.getState().getCachedById(ids[0])?.avatar).toBeUndefined();
  configurePeople('supervised');
  mockMinimal.mockRejectedValue(new Error('authority unavailable'));
  await people.load(['person-0']);
  expect(useUsersStore.getState().getCachedById('person-0')).toBeUndefined();
  expect(mockPublic).not.toHaveBeenCalled();
});

describe('a failed lookup is not an answer', () => {
  const person: UserEntity = { id: 'p1', username: 'p1', name: { displayName: 'Person One' } };
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const flush = async () => {
    for (let n = 0; n < 10; n++) await Promise.resolve();
  };

  it('asks again by itself, with no render to prompt it, and fills the name in', async () => {
    const lookup = jest
      .fn<Promise<UsersLookupResult>, [string[]]>()
      .mockResolvedValueOnce({ users: [], missing: [], failed: ['p1'] })
      .mockResolvedValueOnce({ users: [person], missing: [], failed: [] });
    const resolver = new PeopleResolver(lookup);
    resolver.ensure(['p1']);
    await flush();
    expect(useUsersStore.getState().getCachedById('p1')).toBeUndefined();
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(useUsersStore.getState().getCachedById('p1')).toMatchObject({ id: 'p1' });
    resolver.clear();
  });

  it('remembers only what Oxy answered without, and a thrown batch is retried too', async () => {
    const lookup = jest
      .fn<Promise<UsersLookupResult>, [string[]]>()
      .mockResolvedValueOnce({ users: [], missing: ['gone'], failed: [] })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ users: [], missing: [], failed: [] });
    const resolver = new PeopleResolver(lookup);
    resolver.ensure(['gone']);
    await flush();
    resolver.ensure(['gone']); // remembered as unresolved: not asked again
    await flush();
    expect(lookup).toHaveBeenCalledTimes(1);
    resolver.ensure(['flaky']);
    await flush();
    expect(lookup).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1_000);
    await flush();
    expect(lookup).toHaveBeenLastCalledWith(['flaky']);
    resolver.clear();
  });
});
