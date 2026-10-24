import { createInstance } from 'i18next';

import en from '@/locales/en.json';
import es from '@/locales/es.json';
import itIT from '@/locales/it.json';

/**
 * That every string the privacy screens and the profile screen put on screen
 * exists in all three languages.
 *
 * Nothing here passes a `defaultValue`, so a missing key renders as its own
 * dotted identifier — a row reading `settings.privacy.unblockUserConfirm`. That
 * is loud in English and invisible to whoever ships it, because English is the
 * one language that has the key.
 */

const LOCALES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['en', en as Record<string, unknown>],
  ['es', es as Record<string, unknown>],
  ['it', itIT as Record<string, unknown>],
];

/** Every key the two privacy surfaces and the profile screen ask for. */
const REQUIRED_KEYS: readonly string[] = [
  'settings.privacy.title',
  'settings.privacy.description',
  'settings.privacy.loadError',
  'settings.privacy.updateError',
  'settings.privacy.showOnlineStatus',
  'settings.privacy.showOnlineStatusDesc',
  'settings.privacy.blockedProfiles',
  'settings.privacy.add',
  'settings.privacy.searchTooShort',
  'settings.privacy.noUsersFound',
  'settings.privacy.unknownAccount',
  'settings.privacy.blockedUsers',
  'settings.privacy.blockedUsersDescription',
  'settings.privacy.searchUsersToBlock',
  'settings.privacy.noBlockedUsers',
  'settings.privacy.unblock',
  'settings.privacy.unblockUserConfirm',
  'settings.privacy.userBlocked',
  'settings.privacy.userUnblocked',
  'settings.privacy.failedToBlockUser',
  'settings.privacy.failedToUnblockUser',
  'settings.privacy.cannotBlockYourself',
  'profile.about',
  'profile.message',
  'profile.notFound',
  'profile.notFoundSubtitle',
  'profile.loadFailed',
  'common.cancel',
];

/**
 * The rows that were removed, and every string that only they used.
 *
 * Asserted GONE rather than merely unused: Allo has no posts, no likes and no
 * shares, so a translator who found `settings.privacy.hideLikeCounts` in the
 * bundle would be translating a promise the app cannot keep, and the next person
 * to add a settings row would find a ready-made key inviting them to put it
 * back.
 */
const REMOVED_KEYS: readonly string[] = [
  'settings.privacy.tagsAndallos',
  'settings.privacy.allowTags',
  'settings.privacy.allowTagsDesc',
  'settings.privacy.allowallos',
  'settings.privacy.allowallosDesc',
  'settings.privacy.hideLikeShareCounts',
  'settings.privacy.hideAllCounts',
  'settings.privacy.hideAllCountsDesc',
  'settings.privacy.hideLikeCounts',
  'settings.privacy.hideShareCounts',
  'settings.privacy.hideReplyCounts',
  'settings.privacy.hideSaveCounts',
  'settings.privacy.blockedUsersComingSoon',
  'settings.privacy.restrictedUsersComingSoon',
  'settings.privacy.hiddenWordsComingSoon',
  // Profile visibility, restricted profiles and hidden words: stored, never
  // enforced, so the rows went rather than promise what the app does not do.
  'settings.privacy.privateProfile',
  'settings.privacy.profileVisibilityUpdated',
  'settings.privacy.public',
  'settings.privacy.publicDescription',
  'settings.privacy.followersOnly',
  'settings.privacy.followersOnlyDescription',
  'settings.privacy.private',
  'settings.privacy.privateDescription',
  'settings.privacy.restrictedProfiles',
  'settings.privacy.restrictedUsers',
  'settings.privacy.restrictedUsersDescription',
  'settings.privacy.searchUsersToRestrict',
  'settings.privacy.noRestrictedUsers',
  'settings.privacy.unrestrict',
  'settings.privacy.unrestrictUserConfirm',
  'settings.privacy.userRestricted',
  'settings.privacy.userUnrestricted',
  'settings.privacy.failedToRestrictUser',
  'settings.privacy.failedToUnrestrictUser',
  'settings.privacy.cannotRestrictYourself',
  'settings.privacy.hiddenWords',
  'settings.privacy.hiddenWordsDescription',
  'settings.privacy.noHiddenWords',
  'settings.privacy.hiddenWordLabel',
  'settings.privacy.hiddenWordPlaceholder',
  'settings.privacy.hiddenWordAdded',
  'settings.privacy.hiddenWordRemoved',
  'settings.privacy.hiddenWordRemove',
  'settings.privacy.hiddenWordRemoveConfirm',
  'settings.privacy.hiddenWordEmpty',
  'settings.privacy.hiddenWordTooLong',
  'settings.privacy.hiddenWordDuplicate',
];

/** Every placeholder a string interpolates, sorted so two can be compared. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
}

for (const [name, bundle] of LOCALES) {
  describe(`the ${name} translations`, () => {
    it('has every string the privacy and profile screens ask for', () => {
      const missing = REQUIRED_KEYS.filter(
        (key) => typeof bundle[key] !== 'string' || (bundle[key] as string).length === 0,
      );

      expect(missing).toEqual([]);
    });

    it('no longer carries the strings for rows Allo does not have', () => {
      const remaining = REMOVED_KEYS.filter((key) => key in bundle);

      expect(remaining).toEqual([]);
    });

    it('keeps every interpolation placeholder English uses', () => {
      const english = en as Record<string, unknown>;
      const mismatched: string[] = [];

      for (const key of REQUIRED_KEYS) {
        const source = english[key];
        const translated = bundle[key];
        if (typeof source !== 'string' || typeof translated !== 'string') continue;
        if (placeholders(translated).join() !== placeholders(source).join()) {
          mismatched.push(key);
        }
      }

      expect(mismatched).toEqual([]);
    });

    it('renders the string that interpolates', () => {
      const i18n = createInstance();
      void i18n.init({
        lng: name,
        resources: { [name]: { translation: bundle } },
        interpolation: { escapeValue: false },
      });

      const handle = i18n.t('profile.notFoundSubtitle', { handle: 'alice' });
      expect(handle).not.toContain('{{');
      expect(handle).toContain('alice');
    });
  });
}
