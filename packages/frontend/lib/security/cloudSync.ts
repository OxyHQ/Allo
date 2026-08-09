/**
 * WHETHER THIS ACCOUNT'S MESSAGES GO THROUGH ALLO'S SERVER.
 *
 * One field of the settings document — `security.cloudSyncEnabled` — and the
 * rule for reading it, which is not the obvious one and is the whole reason this
 * module exists rather than a line at each call site.
 *
 * ## Which client
 *
 * `api`, the linked client pointed at Allo's own backend. NOT the Oxy client:
 * Oxy mounts `/profiles`, Allo mounts `/profile`
 * (`packages/backend/src/server.ts`), and this document is Allo's
 * (`routes/profileSettings.ts`). `lib/appInitializer.ts` asked the Oxy client for
 * it and had been getting a 404 on every launch since the line was written —
 * the same mistake #102 fixed for the privacy screens, in the one file it did
 * not reach. `lib/privacy/api.ts` and `stores/appearanceStore.ts` already read
 * neighbouring fields of this very document through `api`.
 *
 * ## What the document says, and what it means
 *
 * The backend's schema gives the field a default of `false`, and the default is
 * not notional: `new UserSettings({ oxyUserId })` persists
 * `security: { cloudSyncEnabled: false, … }`, and `ensureUserSettings` creates
 * exactly that document on the first `GET`. Every account that has ever opened
 * Allo has one, because the appearance store fetches this endpoint at boot.
 *
 * The field is therefore `false` on the server for very nearly everybody, and
 * for **nobody** is that `false` a decision: the only screen that can set it
 * wrote to the Oxy client too, so no value a person chose has ever reached the
 * server. It is absent only in documents written before `security` was added to
 * the schema, because `.lean()` applies no defaults.
 *
 * ## The rule
 *
 * > The document is trusted to turn cloud sync **on**. It is not trusted to turn
 * > it **off**, and an absent field leaves it on.
 *
 * So {@link CLOUD_SYNC_ENABLED_BY_DEFAULT} — `true`, the value
 * `stores/messagesStore.ts` starts with and the value the app has actually run
 * with for its whole life — wins for both `false` and absent.
 *
 * `settings?.security?.cloudSyncEnabled || false` did the opposite, and repairing
 * only the URL under it would have turned cloud sync off for every account at
 * boot. That is not a small thing: with it off, `fetchMessages` does not ask the
 * server at all, so a message that arrived while the app was closed is never
 * backfilled and a reinstalled device opens to empty conversations. A bug fix
 * that loses messages is not a fix.
 *
 * **The exit condition, stated so nobody has to guess it.** This rule is
 * asymmetric because the server's `false` is undecidable, not because off is a
 * worse answer than on. When `securityCloudSyncEnabled` in
 * `packages/backend/src/db/schema/social.ts` no longer defaults to a value
 * nobody asked for, a `false` from the server becomes a decision and this
 * becomes a plain "a boolean wins, absent means on".
 */

import { api } from '@/utils/api';

/**
 * What cloud sync is when the account's document does not decide it.
 *
 * The same value `stores/messagesStore.ts` initialises the store with. They are
 * two statements of one fact and they must not drift: this is what a launch
 * settles on, that is what the app runs with until a launch settles anything.
 */
export const CLOUD_SYNC_ENABLED_BY_DEFAULT = true;

/** The part of the settings document this module reads. */
interface SecurityDocument {
  security?: {
    cloudSyncEnabled?: unknown;
  };
}

/**
 * The `{ data: … }` envelope Allo's endpoints wrap their answers in.
 *
 * `api.get` unwraps its own layer, so what arrives here is the parsed body —
 * which has a `data` of its own from `sendSuccessResponse`. Unwrapped
 * defensively rather than assumed, the same way `lib/privacy/api.ts` and
 * `stores/appearanceStore.ts` do it for neighbouring fields of the same
 * document.
 */
function unwrapEnvelope(body: unknown): SecurityDocument | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const record: Record<string, unknown> = { ...body };
  const inner = 'data' in record ? record.data : record;
  return typeof inner === 'object' && inner !== null ? (inner as SecurityDocument) : null;
}

/**
 * Reads the setting out of whatever the endpoint returned.
 *
 * Exported because the rule at the top of this file is the interesting part and
 * it should be assertable without a network. See there for why `false` and
 * absent are the same answer here and `true` is not.
 */
export function readCloudSyncEnabled(body: unknown): boolean {
  const stored = unwrapEnvelope(body)?.security?.cloudSyncEnabled;
  return stored === true ? true : CLOUD_SYNC_ENABLED_BY_DEFAULT;
}

/** What this account's document says cloud sync should be on this launch. */
export async function fetchMyCloudSyncEnabled(): Promise<boolean> {
  const response = await api.get<unknown>('profile/settings/me');
  return readCloudSyncEnabled(response.data);
}

/**
 * Writes the choice to the account's document.
 *
 * A PATCH in everything but name: the backend builds a `$set` of only the keys
 * it recognises, so sending this one leaves `encryptionEnabled`,
 * `peerToPeerEnabled` and every other part of the document exactly as they were.
 */
export async function updateMyCloudSyncEnabled(enabled: boolean): Promise<void> {
  await api.put('profile/settings', { security: { cloudSyncEnabled: enabled } });
}
