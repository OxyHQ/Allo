/**
 * THE PRIVACY SETTINGS ALLO ACTUALLY HAS.
 *
 * The stored row (`packages/backend/src/db/schema/social.ts`, the `privacy*`
 * columns) is inherited from Mention and carries fields that mean nothing in a
 * messenger: `allowTags`, `allowallos`, `hideLikeCounts`, `hideShareCounts`,
 * `hideReplyCounts`, `hideSaveCounts`. Allo has no posts, no likes and no
 * shares, so there is nothing for a reader to turn off. Those fields are left in
 * the schema — other apps share it, and it is the backend's business — and
 * simply not named here. The API still nests them under `privacy`, which is a
 * wire shape the backend preserves; only where they are stored has changed.
 * What this module names is what Allo can honestly offer:
 *
 *   - who may see the profile,
 *   - whether this account's presence is published,
 *   - the words the reader does not want to see.
 *
 * Blocks and restricts are NOT in that document. They are their own collections
 * with their own endpoints (`/profile/blocks`, `/profile/restricts`), and each
 * answers with a list of Oxy ACCOUNT IDS — not handles. Turning those into people
 * is `oxyServices.getUsersByIds`, one request rather than one per row.
 *
 * ## Which client
 *
 * `api`, the linked client pointed at Allo's own backend — NOT `authenticatedClient`,
 * which is the Oxy API. Every privacy call in this app used the latter, and the
 * Oxy API mounts `/profiles`, not `/profile`: the reads 404ed and fell back to
 * defaults, and the writes went nowhere. Nothing on this screen has been saved
 * since it was written. Same client the appearance store already uses for the
 * neighbouring fields of the very same document.
 */

import { api } from '@/utils/api';

/** How visible a profile is. The three values the backend's enum accepts. */
export const PROFILE_VISIBILITIES = ['public', 'followers_only', 'private'] as const;

export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];

/** The part of the stored privacy document Allo reads and writes. */
export interface AlloPrivacySettings {
  readonly profileVisibility: ProfileVisibility;
  readonly showOnlineStatus: boolean;
  readonly hiddenWords: readonly string[];
}

/**
 * What a reader gets before their own settings arrive, and when the account has
 * never had any.
 *
 * Mirrors the schema's own defaults so the screen does not draw one thing while
 * the server holds another. Visible and present, because that is what the server
 * creates a new document with; a client that guessed "private" here would show a
 * padlock the account does not have.
 */
export const DEFAULT_PRIVACY_SETTINGS: AlloPrivacySettings = {
  profileVisibility: 'public',
  showOnlineStatus: true,
  hiddenWords: [],
};

/** The document shape as it comes back, with everything optional. */
interface StoredPrivacy {
  profileVisibility?: unknown;
  showOnlineStatus?: unknown;
  hiddenWords?: unknown;
}

interface SettingsDocument {
  privacy?: StoredPrivacy;
}

function isProfileVisibility(value: unknown): value is ProfileVisibility {
  return PROFILE_VISIBILITIES.some((candidate) => candidate === value);
}

/**
 * Reads the three fields out of whatever the endpoint returned.
 *
 * Field by field rather than by trusting the payload: this document is written
 * by more than one app and read here by one screen, and a value of an unexpected
 * type must degrade to the default rather than reach a `<Switch>` as a string.
 */
function toPrivacySettings(document: SettingsDocument | null | undefined): AlloPrivacySettings {
  const privacy = document?.privacy;
  return {
    profileVisibility: isProfileVisibility(privacy?.profileVisibility)
      ? privacy.profileVisibility
      : DEFAULT_PRIVACY_SETTINGS.profileVisibility,
    showOnlineStatus:
      typeof privacy?.showOnlineStatus === 'boolean'
        ? privacy.showOnlineStatus
        : DEFAULT_PRIVACY_SETTINGS.showOnlineStatus,
    hiddenWords: Array.isArray(privacy?.hiddenWords)
      ? privacy.hiddenWords.filter((word): word is string => typeof word === 'string')
      : DEFAULT_PRIVACY_SETTINGS.hiddenWords,
  };
}

/**
 * The `{ data: … }` envelope every Allo endpoint wraps its answer in.
 *
 * `api.get` already unwraps one layer (its own `{ data }`), so what arrives here
 * is the parsed body — which has a `data` of its own, from
 * `sendSuccessResponse`. Unwrapped defensively rather than assumed, the same way
 * `stores/appearanceStore.ts` does it for the neighbouring fields.
 */
function unwrapEnvelope(body: unknown): SettingsDocument | null {
  if (typeof body !== 'object' || body === null) return null;
  const record: Record<string, unknown> = { ...body };
  const inner = 'data' in record ? record.data : record;
  return typeof inner === 'object' && inner !== null ? (inner as SettingsDocument) : null;
}

export async function fetchMyPrivacySettings(): Promise<AlloPrivacySettings> {
  const response = await api.get<unknown>('profile/settings/me');
  return toPrivacySettings(unwrapEnvelope(response.data));
}

/**
 * Writes some of the three fields and answers with all three, as stored.
 *
 * A PATCH in everything but name: the backend builds a `$set` of only the keys
 * it recognises in the body, so sending one field leaves the others — including
 * the six this app deliberately never shows — exactly as they were.
 */
export async function updateMyPrivacySettings(
  patch: Partial<AlloPrivacySettings>,
): Promise<AlloPrivacySettings> {
  const response = await api.put<unknown>('profile/settings', {
    privacy: {
      ...(patch.profileVisibility !== undefined && {
        profileVisibility: patch.profileVisibility,
      }),
      ...(patch.showOnlineStatus !== undefined && { showOnlineStatus: patch.showOnlineStatus }),
      ...(patch.hiddenWords !== undefined && { hiddenWords: [...patch.hiddenWords] }),
    },
  });
  return toPrivacySettings(unwrapEnvelope(response.data));
}

/**
 * The two lists of people, which differ in nothing but their endpoint and the
 * sentence the screen puts above them.
 *
 * Named as a pair because the screens are one screen: a second copy of "list,
 * add, remove" is a second place the removal confirmation can be forgotten.
 */
export type ModerationList = 'blocks' | 'restricts';

/** How each endpoint spells the id, in the body it takes and the list it gives. */
const LIST_FIELDS = {
  blocks: { idField: 'blockedId', listField: 'blockedUsers' },
  restricts: { idField: 'restrictedId', listField: 'restrictedUsers' },
} as const satisfies Record<ModerationList, { idField: string; listField: string }>;

function toIdList(body: unknown, listField: string): string[] {
  const envelope = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  const inner = envelope !== null && 'data' in envelope ? envelope.data : envelope;
  const record = typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>) : null;
  const list = record?.[listField];
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
}

export async function fetchModeratedUserIds(list: ModerationList): Promise<string[]> {
  const response = await api.get<unknown>(`profile/${list}`);
  return toIdList(response.data, LIST_FIELDS[list].listField);
}

export async function addModeratedUser(list: ModerationList, userId: string): Promise<void> {
  await api.post(`profile/${list}`, { [LIST_FIELDS[list].idField]: userId });
}

export async function removeModeratedUser(list: ModerationList, userId: string): Promise<void> {
  await api.delete(`profile/${list}/${encodeURIComponent(userId)}`);
}
