import type { DirectoryUser } from "@allo/shared-types";
import type { SearchProfilesResponse, User } from "@oxyhq/core";

/**
 * The five Oxy lookups the app makes today, moved behind this backend.
 *
 * ## Why they move at all
 *
 * Allo is collapsing to one sign-in. Once the app authenticates only through
 * Matrix Authentication Service it holds no Oxy session, so an Oxy SDK call
 * from a screen has nothing to authenticate with — and the app should not carry
 * a second identity provider's client just to draw an avatar. These five are
 * the whole of what it asks Oxy for: `getProfileByUsername` (6 call sites),
 * `getUserById` (5), `getUsersByIds` (2), `searchProfiles` (2) and
 * `getFileDownloadUrl` (15, all avatars).
 *
 * **The app still calls Oxy directly today.** This is the surface it moves to,
 * built and tested before anything depends on it.
 *
 * ## Why no service credential is required
 *
 * All five underlying Oxy routes are public. `GET /profiles/username/:username`,
 * `GET /users/:userId` and `GET /profiles/search` carry no auth middleware at
 * all; `POST /users/by-ids` is `optionalUserOrServiceAuth` and returns the same
 * public payload to an anonymous caller; and an avatar URL is a pure string
 * built against the Oxy CDN with no network call in it. So this service works
 * with no provisioning step, and configuring a service credential
 * (`config/oxyService.ts`) only changes HOW the by-ids call authenticates, not
 * whether it works.
 *
 * ## Why it projects instead of forwarding
 *
 * See `@allo/shared-types`' `directory.ts`. The Oxy `User` carries `email`,
 * `phone`, `address` and `birthday`; this backend asks Oxy AS ITSELF, so
 * whatever it forwards, it forwards to every signed-in user. {@link toDirectoryUser}
 * is the only way a user leaves this module, and it names its fields
 * one at a time.
 */

/**
 * What this service needs of the Oxy SDK, and no more.
 *
 * A structural type rather than `OxyServices`: the real client satisfies it, a
 * test can satisfy it in ten lines, and the compiler still checks every call.
 */
export interface OxyDirectoryClient {
  getProfileByUsername(username: string, options?: { cache?: boolean }): Promise<User>;
  getUserById(userId: string, options?: { cache?: boolean }): Promise<User>;
  getUsersByIds(ids: string[]): Promise<User[]>;
  searchProfiles(
    query: string,
    pagination?: { limit?: number; offset?: number },
  ): Promise<SearchProfilesResponse>;
  getFileDownloadUrl(fileId: string, variant?: string, expiresIn?: number): string;
}

/**
 * The avatar size every Allo surface asks for.
 *
 * One constant because every one of the fifteen call sites in the app passes
 * `'thumb'`, and a directory that resolved a different variant than the app
 * asks for would silently double the bytes on every conversation row.
 */
export const AVATAR_VARIANT = "thumb";

export interface OxyDirectoryService {
  profileByUsername(username: string): Promise<DirectoryUser>;
  userById(userId: string): Promise<DirectoryUser>;
  usersByIds(ids: readonly string[]): Promise<DirectoryUser[]>;
  searchProfiles(
    query: string,
    pagination: { limit: number; offset: number },
  ): Promise<{ users: DirectoryUser[]; total: number; hasMore: boolean }>;
  assetUrl(fileId: string, variant: string | undefined): string;
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * One Oxy user, projected onto what Allo draws.
 *
 * `displayName` comes straight from Oxy's canonical `name.displayName` and is
 * NOT recomposed from the parts when it is missing — `utils/oxyUserDisplay.ts`
 * already settled that argument for the conversation participants, and a second
 * answer here would mean the same person is named differently on the two
 * screens they appear on. The handle is the fallback, then the literal
 * "Unknown", which is what the participant enrichment does.
 */
export function toDirectoryUser(user: User, client: OxyDirectoryClient): DirectoryUser {
  const avatar = trimToUndefined(user.avatar);
  const displayName =
    trimToUndefined(user.name?.displayName) ?? trimToUndefined(user.username) ?? "Unknown";

  return {
    id: user.id,
    username: user.username,
    displayName,
    firstName: trimToUndefined(user.name?.first) ?? "",
    lastName: trimToUndefined(user.name?.last) ?? "",
    ...(avatar === undefined
      ? {}
      : { avatar, avatarUrl: client.getFileDownloadUrl(avatar, AVATAR_VARIANT) }),
    ...(trimToUndefined(user.bio) === undefined ? {} : { bio: user.bio }),
  };
}

export function createOxyDirectoryService(client: OxyDirectoryClient): OxyDirectoryService {
  return {
    async profileByUsername(username: string): Promise<DirectoryUser> {
      return toDirectoryUser(await client.getProfileByUsername(username), client);
    },

    async userById(userId: string): Promise<DirectoryUser> {
      return toDirectoryUser(await client.getUserById(userId), client);
    },

    async usersByIds(ids: readonly string[]): Promise<DirectoryUser[]> {
      /**
       * `getUsersByIds` deduplicates, chunks at 100 and drops a chunk that
       * fails rather than the whole call, so the answer can legitimately be
       * shorter than the request. The route says so; nothing here pads it back
       * out with placeholders, because a placeholder is indistinguishable from
       * a real answer at the point it is drawn.
       */
      const users = await client.getUsersByIds([...ids]);
      return users.map((user) => toDirectoryUser(user, client));
    },

    async searchProfiles(
      query: string,
      pagination: { limit: number; offset: number },
    ): Promise<{ users: DirectoryUser[]; total: number; hasMore: boolean }> {
      const response = await client.searchProfiles(query, pagination);
      return {
        users: response.data.map((user) => toDirectoryUser(user, client)),
        total: response.pagination.total,
        hasMore: response.pagination.hasMore,
      };
    },

    assetUrl(fileId: string, variant: string | undefined): string {
      return client.getFileDownloadUrl(fileId, variant ?? AVATAR_VARIANT);
    },
  };
}
