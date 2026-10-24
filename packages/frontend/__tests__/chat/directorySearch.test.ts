import {
  canBeConversationMember,
  type DirectoryProfile,
  searchedUsersFrom,
} from '@/lib/people/directorySearch';

/**
 * New chat is a directory search, so what it offers is exactly what these say:
 * only accounts a conversation can be started with, in the directory's order.
 * Both rules were broken on a device: "nate" listed federated namesakes, A–Z,
 * above the account somebody typed.
 */

const local = (id: string, username: string, extra: Partial<DirectoryProfile> = {}) =>
  ({ id, username, name: { displayName: username }, type: 'local', ...extra }) as const;

describe('canBeConversationMember', () => {
  it('offers a local Oxy account of any kind', () => {
    expect(canBeConversationMember(local('1', 'nate'))).toBe(true);
    expect(canBeConversationMember({ id: '2', username: 'oxy' })).toBe(true);
  });

  it('refuses a federated profile, however it says so', () => {
    expect(canBeConversationMember(local('3', 'animeita', { type: 'federated' }))).toBe(false);
    expect(canBeConversationMember(local('4', 'cgaedt', { isFederated: true }))).toBe(false);
  });

  it('refuses an account driven by software', () => {
    expect(canBeConversationMember(local('5', 'helper', { type: 'agent' }))).toBe(false);
    expect(canBeConversationMember(local('6', 'digest', { type: 'automated' }))).toBe(false);
  });
});

describe('searchedUsersFrom', () => {
  it("keeps the directory's order instead of sorting by name", () => {
    const rows = searchedUsersFrom([
      local('n', 'nate'),
      local('a', 'aaron'),
      local('z', 'zoe'),
      local('b', 'beatriz'),
    ]);
    expect(rows.map((row) => row.handle)).toEqual(['nate', 'aaron', 'zoe', 'beatriz']);
  });

  it('drops who cannot be messaged and keeps everybody else where they were', () => {
    const rows = searchedUsersFrom([
      local('f1', 'animeita@mastodon.uno', { type: 'federated' }),
      local('n', 'nate'),
      local('f2', 'cgaedt@troet.cafe', { isFederated: true }),
      local('m', 'natalia'),
    ]);
    expect(rows.map((row) => row.id)).toEqual(['n', 'm']);
  });

  it('names a row by display name, else by handle, and carries the avatar', () => {
    expect(
      searchedUsersFrom([
        { id: '1', username: 'soliddeer428', name: { displayName: '' }, avatar: 'file-1' },
        { id: '2', handle: 'ana', name: { displayName: 'Ana Restrepo' } },
      ]),
    ).toEqual([
      { id: '1', displayName: 'soliddeer428', handle: 'soliddeer428', avatar: 'file-1' },
      { id: '2', displayName: 'Ana Restrepo', handle: 'ana' },
    ]);
  });
});
