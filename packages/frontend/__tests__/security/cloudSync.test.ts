import { readFileSync } from 'fs';
import { join } from 'path';

import {
  CLOUD_SYNC_ENABLED_BY_DEFAULT,
  fetchMyCloudSyncEnabled,
  readCloudSyncEnabled,
  updateMyCloudSyncEnabled,
} from '@/lib/security/cloudSync';

const mockGet = jest.fn();
const mockPut = jest.fn();

/**
 * Allo's own backend client, and only it.
 *
 * The bug was which client, so the mock is of the client that must be used: a
 * module that reached for the Oxy one instead would find nothing mocked and
 * these cases would not pass by accident.
 */
jest.mock('@/utils/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
}));

/**
 * WHICH SERVER ANSWERS, AND WHAT ITS ANSWER MEANS.
 *
 * `lib/appInitializer.ts` asked the OXY client for `/profile/settings/me` and
 * got a 404 on every launch the app has ever had — Oxy mounts `/profiles`, and
 * this document is Allo's own. Repairing the URL is one line and it is the
 * smaller half of the change; the larger half is that the line under it read
 * `settings?.security?.cloudSyncEnabled || false`, so the repair on its own
 * would have switched cloud sync off for every account at boot.
 *
 * That is not a cosmetic setting. With cloud sync off `fetchMessages` does not
 * ask the server at all: a message that arrived while the app was closed is
 * never backfilled, and a reinstalled device opens to empty conversations.
 *
 * The backend's `SecuritySchema` writes `cloudSyncEnabled: false` into every
 * document it creates — asserted below against the model itself, because that
 * fact is the reason this rule is asymmetric and a reader who does not know it
 * would delete the asymmetry as a mistake. Nobody chose those falses: the only
 * screen that could set the field wrote to the Oxy client too. So the document
 * is trusted to turn cloud sync on and not to turn it off, and an absent field
 * leaves it on.
 */

describe('what a settings document says about cloud sync', () => {
  it('turns cloud sync on when the account has chosen it', () => {
    expect(readCloudSyncEnabled({ data: { security: { cloudSyncEnabled: true } } })).toBe(true);
  });

  it('leaves cloud sync on when the field is absent', () => {
    // Documents written before `security` existed in the schema. `.lean()`
    // applies no defaults, so they come back without it. Absent is nobody's
    // decision and must not be read as one.
    expect(readCloudSyncEnabled({ data: { privacy: { profileVisibility: 'public' } } })).toBe(
      true,
    );
    expect(readCloudSyncEnabled({ data: { security: {} } })).toBe(true);
    expect(readCloudSyncEnabled({ data: {} })).toBe(true);
  });

  it('leaves cloud sync on when the document says false, because nobody said it', () => {
    // THE CASE THE WHOLE MODULE IS FOR. Every account has this value, written by
    // the schema at document creation; not one person put it there. Acting on it
    // is the silent switch-off a URL fix must not cause.
    expect(readCloudSyncEnabled({ data: { security: { cloudSyncEnabled: false } } })).toBe(true);
  });

  it('agrees with the value the messages store starts with', () => {
    // They are two statements of one fact. When they disagreed — a `true` in the
    // store and a `|| false` in the loader — only a 404 kept the disagreement
    // off the screen.
    expect(CLOUD_SYNC_ENABLED_BY_DEFAULT).toBe(true);
  });

  it('is the only place that value is written down', () => {
    // Asserting the two are equal cannot catch them being written twice, because
    // two literals that happen to agree today pass it. The store has to name the
    // constant, so that changing it is one edit and not two — the second of
    // which nobody would remember.
    const source = readFileSync(
      join(__dirname, '..', '..', 'stores', 'messagesStore.ts'),
      'utf8',
    );

    expect(source).toContain('cloudSyncEnabled: CLOUD_SYNC_ENABLED_BY_DEFAULT');
    expect(source).not.toMatch(/cloudSyncEnabled:\s*(true|false)/);
  });

  it('does not read a string or a number as an answer', () => {
    // This document is written by more than one caller. A value of the wrong
    // type is not a decision either.
    expect(readCloudSyncEnabled({ data: { security: { cloudSyncEnabled: 'true' } } })).toBe(true);
    expect(readCloudSyncEnabled({ data: { security: { cloudSyncEnabled: 1 } } })).toBe(true);
  });

  it('survives a body that is not a document at all', () => {
    expect(readCloudSyncEnabled(undefined)).toBe(true);
    expect(readCloudSyncEnabled(null)).toBe(true);
    expect(readCloudSyncEnabled('not found')).toBe(true);
  });

  it('reads a document that arrives without the envelope', () => {
    // `sendSuccessResponse` wraps its answer in `data`, and `api.get` unwraps a
    // layer of its own. Both shapes have been seen by the neighbouring readers
    // of this document, so both are handled.
    expect(readCloudSyncEnabled({ security: { cloudSyncEnabled: true } })).toBe(true);
  });
});

describe('which server is asked', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
  });

  it('reads the document from Allo, at the path Allo mounts', () => {
    // `/profile`, not `/profiles`. The Oxy API mounts the plural and does not
    // serve this document at all, which is the 404 the owner saw on every boot.
    mockGet.mockResolvedValue({ data: { data: { security: { cloudSyncEnabled: true } } } });

    return fetchMyCloudSyncEnabled().then((enabled) => {
      expect(mockGet).toHaveBeenCalledWith('profile/settings/me');
      expect(enabled).toBe(true);
    });
  });

  it('writes the choice to the same document it reads', () => {
    // A read that persists and a write that does not is worse than neither: the
    // switch would appear to work and undo itself on the next launch.
    mockPut.mockResolvedValue({ data: {} });

    return updateMyCloudSyncEnabled(false).then(() => {
      expect(mockPut).toHaveBeenCalledWith('profile/settings', {
        security: { cloudSyncEnabled: false },
      });
    });
  });

  it('sends nothing but the one field, so the rest of the document survives', () => {
    // The backend builds a `$set` from the keys it recognises. A body carrying
    // more would overwrite settings this screen has no business touching.
    mockPut.mockResolvedValue({ data: {} });

    return updateMyCloudSyncEnabled(true).then(() => {
      const [, body] = mockPut.mock.calls[0] as [string, Record<string, unknown>];
      expect(Object.keys(body)).toEqual(['security']);
      expect(body.security).toEqual({ cloudSyncEnabled: true });
    });
  });
});

describe('the boot path no longer asks Oxy for an Allo document', () => {
  const INITIALIZER = join(__dirname, '..', '..', 'lib', 'appInitializer.ts');
  const SETTINGS_SCREEN = join(
    __dirname,
    '..',
    '..',
    'app',
    '(chat)',
    'settings',
    'index.tsx',
  );

  it('loads the setting through the module that knows which client to use', () => {
    const source = readFileSync(INITIALIZER, 'utf8');

    expect(source).toContain('fetchMyCloudSyncEnabled');
    expect(source).not.toContain('/profile/settings/me');
  });

  it('saves the setting through it too', () => {
    const source = readFileSync(SETTINGS_SCREEN, 'utf8');

    expect(source).toContain('updateMyCloudSyncEnabled');
    expect(source).not.toContain("authenticatedClient.put('/profile/settings'");
  });

  it('does not shout the failure through a banned console call', () => {
    // `console.warn` and `console.error` are banned by the project's standards
    // and this module already imports `logger`.
    const source = readFileSync(INITIALIZER, 'utf8');
    const initializing = source.slice(source.indexOf('async function initializeSignalProtocol'));

    expect(initializing).not.toContain('console.');
  });
});

describe('the backend fact this rule rests on', () => {
  /**
   * The backend's own settings schema, which moved from Mongoose to drizzle when
   * this domain was ported to Postgres.
   *
   * The FACT is unchanged and so is this test's job — only the file that states
   * it moved, along with the spelling. That is exactly why the assertion is
   * pinned to the default rather than to a file existing: a port that had
   * quietly flipped the default to `true` (which reads as the friendlier
   * choice) would have had to change this line, and changing it means reading
   * the paragraph below.
   */
  const SCHEMA = join(
    __dirname,
    '..',
    '..',
    '..',
    'backend',
    'src',
    'db',
    'schema',
    'social.ts',
  );

  it('still defaults cloudSyncEnabled to false in the stored schema', () => {
    // If this fails, the backend has been changed and the asymmetry above has
    // served its purpose: a `false` from the server has become somebody's
    // decision, and `readCloudSyncEnabled` should become a plain "a boolean
    // wins, absent means on". The test is here so that change is noticed by the
    // rule that depends on it rather than by a user losing messages.
    const source = readFileSync(SCHEMA, 'utf8');

    expect(source).toMatch(
      /securityCloudSyncEnabled:\s*boolean\(\)\.notNull\(\)\.default\(false\)/,
    );
  });

  /**
   * The neighbouring two, asserted TOGETHER with it.
   *
   * The whole point of the rule above is that cloud sync is opt-IN while
   * encryption and P2P are opt-OUT, and a flattening that had read one column
   * where it meant another would most plausibly show all three the same way —
   * which the single assertion above cannot see.
   */
  it('still defaults encryption and peer-to-peer to true, which is what makes the asymmetry real', () => {
    const source = readFileSync(SCHEMA, 'utf8');

    expect(source).toMatch(/securityEncryptionEnabled:\s*boolean\(\)\.notNull\(\)\.default\(true\)/);
    expect(source).toMatch(/securityPeerToPeerEnabled:\s*boolean\(\)\.notNull\(\)\.default\(true\)/);
  });
});
