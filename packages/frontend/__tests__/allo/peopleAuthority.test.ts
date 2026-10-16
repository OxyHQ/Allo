import { PeopleResolver, configurePeople, people } from '@/lib/allo/people';
import { useUsersStore, type UserEntity } from '@/stores/usersStore';
const mockPublic = jest.fn();
const mockMinimal = jest.fn();
jest.mock('@/lib/oxy', () => ({
  oxyServices: {
    users: { getMany: (ids: string[]) => mockPublic(ids) },
    safety: { people: (input: unknown) => mockMinimal(input) },
  },
}));
beforeEach(() => {
  configurePeople('unknown');
  mockPublic.mockReset();
  mockMinimal.mockReset();
});
it('cannot restore a previous account’s rich profile after the session cache is cleared', async () => {
  let resolve!: (users: UserEntity[]) => void;
  const resolver = new PeopleResolver(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = resolver.load(['person']);
  resolver.clear();
  resolve([
    {
      id: 'person',
      username: 'person',
      name: { displayName: 'Old account view' },
      avatar: 'private-avatar',
      bio: 'private bio',
    },
  ]);
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
