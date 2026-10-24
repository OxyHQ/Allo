import {
  blockUser,
  fetchBlockedUserIds,
  fetchMyPrivacySettings,
  unblockUser,
  updateMyPrivacySettings,
} from '@/lib/privacy/api';

/**
 * What the privacy client sends and reads: online status and blocks, and
 * nothing else.
 *
 * The stored row still has `profileVisibility`, `hiddenWords` and
 * `restrictedUsers` columns until a post-phase migration drops them. Nothing on
 * the frontend acts on them, so nothing on the frontend may write them either:
 * a write would be a setting the app shows no row for and enforces nowhere.
 */

const mockGet = jest.fn();
const mockPut = jest.fn();
const mockPost = jest.fn();
const mockDelete = jest.fn();

jest.mock('@/utils/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
    post: (...args: unknown[]) => mockPost(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

const STORED = {
  data: {
    privacy: {
      showOnlineStatus: false,
      profileVisibility: 'private',
      hiddenWords: ['spoilers'],
      restrictedUsers: ['someone'],
    },
  },
};

beforeEach(() => {
  jest.resetAllMocks();
});

describe('the privacy settings client', () => {
  it('reads only the online status out of the stored document', async () => {
    mockGet.mockResolvedValue({ data: STORED });

    await expect(fetchMyPrivacySettings()).resolves.toEqual({ showOnlineStatus: false });
    expect(mockGet).toHaveBeenCalledWith('profile/settings/me');
  });

  it('writes the online status and no other privacy field', async () => {
    mockPut.mockResolvedValue({ data: STORED });

    await updateMyPrivacySettings({ showOnlineStatus: false });

    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledWith('profile/settings', {
      privacy: { showOnlineStatus: false },
    });
  });

  it('falls back to the schema default for a value of the wrong type', async () => {
    mockGet.mockResolvedValue({ data: { data: { privacy: { showOnlineStatus: 'no' } } } });

    await expect(fetchMyPrivacySettings()).resolves.toEqual({ showOnlineStatus: true });
  });
});

describe('the blocks client', () => {
  it('lists blocked account ids, dropping anything that is not a string', async () => {
    mockGet.mockResolvedValue({ data: { data: { blockedUsers: ['a', 2, 'b'] } } });

    await expect(fetchBlockedUserIds()).resolves.toEqual(['a', 'b']);
    expect(mockGet).toHaveBeenCalledWith('profile/blocks');
  });

  it('blocks and unblocks through the blocks endpoint', async () => {
    await blockUser('user/1');
    await unblockUser('user/1');

    expect(mockPost).toHaveBeenCalledWith('profile/blocks', { blockedId: 'user/1' });
    expect(mockDelete).toHaveBeenCalledWith('profile/blocks/user%2F1');
  });
});
