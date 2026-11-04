import type { DirectoryUser } from '@allo/shared-types';
import type { BatchLookup, SearchProfilesResponse, User } from '@oxy.so/core';

/**
 * The five Oxy lookups the app makes today, moved behind this backend.
 *
 * ## Why they move at all
 *
 * The app draws a person through this backend rather than by calling Oxy from
 * a screen, so a client that holds an Allo session and nothing else — an SDK
 * consumer that is not the Allo app — can still resolve who somebody is. These
 * five are the whole of what the app asks Oxy for: `users.byUsername`,
 * `users.get`, `users.getMany` (answered here with `users.lookupMany`, which
 * tells a failure from an absence), `users.search` and `assets.publicUrl`
 * (avatars).
 *
 * ## Who it asks as
 *
 * Itself. All five underlying Oxy routes answer the same public payload to
 * anybody, so no person's session is needed, and the shared client in `oxy.ts`
 * (`serviceIdentity: 'when-anonymous'`) sends them with Allo's workload service
 * token: an anonymous read from this fleet would be charged to its shared NAT
 * address and slowed down. An avatar URL is a pure string built against the
 * Oxy CDN with no network call in it.
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
  readonly users: {
    byUsername(username: string, options?: { cache?: boolean }): Promise<User>;
    get(userId: string, options?: { cache?: boolean }): Promise<User>;
    lookupMany(ids: string[]): Promise<BatchLookup<User>>;
    search(
      query: string,
      pagination?: { limit?: number; offset?: number },
    ): Promise<SearchProfilesResponse>;
  };
  readonly assets: {
    publicUrl(fileId: string, variant?: string, expiresIn?: number): string;
  };
}

/**
 * The avatar size every Allo surface asks for.
 *
 * One constant because every one of the fifteen call sites in the app passes
 * `'thumb'`, and a directory that resolved a different variant than the app
 * asks for would silently double the bytes on every conversation row.
 */
export const AVATAR_VARIANT = 'thumb';

/**
 * Oxy could not answer for some of what was asked. Never "no such account": the
 * route maps it to 502, and the caller asks again.
 */
export class DirectoryUnavailableError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`${operation}: Oxy did not answer for every requested account`, { cause });
    this.name = 'DirectoryUnavailableError';
  }
}

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
    trimToUndefined(user.name?.displayName) ?? trimToUndefined(user.username) ?? 'Unknown';

  return {
    id: user.id,
    username: user.username,
    displayName,
    firstName: trimToUndefined(user.name?.first) ?? '',
    lastName: trimToUndefined(user.name?.last) ?? '',
    ...(avatar === undefined
      ? {}
      : { avatar, avatarUrl: client.assets.publicUrl(avatar, AVATAR_VARIANT) }),
    ...(trimToUndefined(user.bio) === undefined ? {} : { bio: user.bio }),
  };
}

export function createOxyDirectoryService(client: OxyDirectoryClient): OxyDirectoryService {
  return {
    async profileByUsername(username: string): Promise<DirectoryUser> {
      return toDirectoryUser(await client.users.byUsername(username), client);
    },

    async userById(userId: string): Promise<DirectoryUser> {
      return toDirectoryUser(await client.users.get(userId), client);
    },

    async usersByIds(ids: readonly string[]): Promise<DirectoryUser[]> {
      /**
       * `lookupMany` sorts every id into found, missing (Oxy answered without
       * it: a deleted or unknown account) and failed (its chunk never got an
       * answer). Missing ids are simply absent from the result — the route
       * says so, and nothing pads them out with placeholders. A failed id is
       * NOT absent: answering without it would tell the app that a real
       * person does not exist because Oxy blinked, so any failure fails the
       * whole lookup and the route answers 502.
       */
      const lookup = await client.users.lookupMany([...ids]);
      if (lookup.failed.length > 0) {
        throw new DirectoryUnavailableError('users.lookupMany', lookup.error);
      }
      return lookup.found.map((user) => toDirectoryUser(user, client));
    },

    async searchProfiles(
      query: string,
      pagination: { limit: number; offset: number },
    ): Promise<{ users: DirectoryUser[]; total: number; hasMore: boolean }> {
      const response = await client.users.search(query, pagination);
      return {
        users: response.data.map((user) => toDirectoryUser(user, client)),
        total: response.pagination.total,
        hasMore: response.pagination.hasMore,
      };
    },

    assetUrl(fileId: string, variant: string | undefined): string {
      return client.assets.publicUrl(fileId, variant ?? AVATAR_VARIANT);
    },
  };
}
