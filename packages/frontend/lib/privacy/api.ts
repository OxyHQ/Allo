/**
 * THE PRIVACY SETTINGS ALLO ACTUALLY HAS: the two the platform enforces.
 *
 *   - whether this account's presence is published (`showOnlineStatus`, which
 *     the presence layer honours in both directions),
 *   - who this account has blocked (no new direct messages or invitations
 *     either way, and no presence either way).
 *
 * The stored row (`packages/backend/src/db/schema/social.ts`, the `privacy*`
 * columns) carries more than that: Mention's feed fields (`allowTags`,
 * `hide*Counts`) and three Allo once showed without anything acting on them
 * (`profileVisibility`, `hiddenWords`, `restrictedUsers`, plus the `restricts`
 * table). This module names none of them, reads none of them and writes none of
 * them; the backend keeps the columns until a post-phase migration drops them.
 *
 * Blocks are NOT in that document. They are their own collection with their own
 * endpoint (`/profile/blocks`), which answers with a list of Oxy ACCOUNT IDS —
 * not handles. Turning those into people is `oxyServices.users.getMany`, one
 * request rather than one per row.
 *
 * ## Which client
 *
 * `api`, the linked client pointed at Allo's own backend — NOT `authenticatedClient`,
 * which is the Oxy API. Every privacy call in this app used the latter, and the
 * Oxy API mounts `/profiles`, not `/profile`: the reads 404ed and fell back to
 * defaults, and the writes went nowhere. Same client the appearance store
 * already uses for the neighbouring fields of the very same document.
 */

import { api } from '@/utils/api';

/** The part of the stored privacy document Allo reads and writes. */
export interface AlloPrivacySettings {
  readonly showOnlineStatus: boolean;
}

/**
 * What a reader gets before their own settings arrive, and when the account has
 * never had any.
 *
 * Mirrors the schema's own default so the screen does not draw one thing while
 * the server holds another: present, because that is what the server creates a
 * new document with.
 */
export const DEFAULT_PRIVACY_SETTINGS: AlloPrivacySettings = {
  showOnlineStatus: true,
};

/** The document shape as it comes back, with everything optional. */
interface StoredPrivacy {
  showOnlineStatus?: unknown;
}

interface SettingsDocument {
  privacy?: StoredPrivacy;
}

/**
 * Reads the field out of whatever the endpoint returned.
 *
 * Checked rather than trusted: this document is written by more than one app,
 * and a value of an unexpected type must degrade to the default rather than
 * reach a `<Switch>` as a string.
 */
function toPrivacySettings(document: SettingsDocument | null | undefined): AlloPrivacySettings {
  const privacy = document?.privacy;
  return {
    showOnlineStatus:
      typeof privacy?.showOnlineStatus === 'boolean'
        ? privacy.showOnlineStatus
        : DEFAULT_PRIVACY_SETTINGS.showOnlineStatus,
  };
}

/**
 * The `{ data: … }` envelope every Allo endpoint wraps its answer in.
 *
 * `api.get` already unwraps one layer (its own `{ data }`), so what arrives here
 * is the parsed body — which has a `data` of its own, from
 * `sendSuccessResponse`. Unwrapped defensively rather than assumed, the same way
 * `lib/profile/appearance.ts` does it for the neighbouring fields.
 */
function unwrapEnvelope(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'object' || body === null) return null;
  const record: Record<string, unknown> = { ...body };
  const inner = 'data' in record ? record.data : record;
  return typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>) : null;
}

export async function fetchMyPrivacySettings(): Promise<AlloPrivacySettings> {
  const response = await api.get<unknown>('profile/settings/me');
  return toPrivacySettings(unwrapEnvelope(response.data) as SettingsDocument | null);
}

/**
 * Writes the fields it is given and answers with them as stored.
 *
 * A PATCH in everything but name: the backend builds an update of only the
 * keys it recognises in the body, so sending `showOnlineStatus` leaves every
 * other column of the row exactly as it was.
 */
export async function updateMyPrivacySettings(
  patch: Partial<AlloPrivacySettings>,
): Promise<AlloPrivacySettings> {
  const response = await api.put<unknown>('profile/settings', {
    privacy: {
      ...(patch.showOnlineStatus !== undefined && { showOnlineStatus: patch.showOnlineStatus }),
    },
  });
  return toPrivacySettings(unwrapEnvelope(response.data) as SettingsDocument | null);
}

export async function fetchBlockedUserIds(): Promise<string[]> {
  const response = await api.get<unknown>('profile/blocks');
  const list = unwrapEnvelope(response.data)?.blockedUsers;
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
}

export async function blockUser(userId: string): Promise<void> {
  await api.post('profile/blocks', { blockedId: userId });
}

export async function unblockUser(userId: string): Promise<void> {
  await api.delete(`profile/blocks/${encodeURIComponent(userId)}`);
}
