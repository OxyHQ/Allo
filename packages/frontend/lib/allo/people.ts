/**
 * WHO SOMEBODY IS, for the chat path — and the only place the chat path asks
 * Oxy about a person.
 *
 * The SDK reports Oxy account ids and nothing else: a conversation is its
 * `memberAccountIds`, a message is its `senderAccountId`, and a title is only
 * there when a group has been named. Every name and every avatar on a chat
 * screen therefore comes through here.
 *
 * Two consumers, one cache:
 *
 * - `@allo/core` takes a `PeopleDirectory` (`resolve(ids)`), used when it
 *   composes something that needs a name.
 * - The screens ask by hook (`usePerson`, `usePeople`) and draw from
 *   `usersStore`, which is what `resolve` fills.
 *
 * Lookups COALESCE: every id asked for in one tick goes out as one
 * `users.lookupMany`, so a group of thirty is one request, a list of two hundred
 * rows is one request, and a row asking twice is one entry. An id already in
 * the cache is not asked for again until its TTL passes, and an id that Oxy
 * ANSWERED without (deleted, hidden) is remembered as unresolved for the same
 * TTL so the list does not ask for it on every render.
 *
 * A request that FAILED is not an answer. `users.lookupMany` keeps the two
 * apart (`missing` vs `failed`); `getMany` did not, and one dropped request on
 * a phone left a conversation's header and list row nameless, with a
 * placeholder avatar, for five minutes. Failed ids are asked again by
 * themselves, with a growing pause, because a screen that is already drawn
 * may never render again to ask.
 */
import type { PeopleDirectory, PersonInfo } from '@allo/core';
import { oxyServices } from '@/lib/oxy';
import { useUsersStore, type UserEntity } from '@/stores/usersStore';

/** What a screen draws for a person. `undefined` for anyone still being looked up. */
export interface Person {
  id: string;
  displayName: string;
  handle?: string;
  /** An Oxy file id or an absolute URL. Bloom's image resolver draws either. */
  avatar?: string;
  /** What the person says about themselves on Oxy, when they have said anything. */
  bio?: string;
  /** Oxy says this account is verified. */
  verified?: boolean;
}

/** How long "Oxy said nobody" is believed before being asked again. */
const UNRESOLVED_TTL_MS = 5 * 60 * 1000;
/** The first pause before a failed lookup is asked again; it doubles up to the cap. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** One batch's three outcomes: answered, answered-without, and not answered at all. */
export interface UsersLookupResult {
  users: UserEntity[];
  /** Oxy answered and these are not there: safe to remember as unresolved. */
  missing: string[];
  /** Their request failed: unknown, to be asked again. */
  failed: string[];
}
export type UsersLookup = (ids: string[]) => Promise<UsersLookupResult>;

export class PeopleResolver implements PeopleDirectory {
  private generation = 0;
  private queued = new Set<string>();
  private inFlight = new Map<string, Promise<void>>();
  private unresolvedAt = new Map<string, number>();
  private flushScheduled = false;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryIds = new Set<string>();

  constructor(
    private readonly lookup: UsersLookup,
    private readonly now: () => number = () => Date.now(),
  ) {}

  clear(): void {
    this.generation += 1;
    this.queued.clear();
    this.inFlight.clear();
    this.unresolvedAt.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryIds.clear();
    this.retryAttempt = 0;
    useUsersStore.getState().clearAll();
  }

  /** Asks for anyone not known, without waiting. Safe to call on every render. */
  ensure(ids: readonly string[]): void {
    for (const id of ids) {
      if (!id || this.isKnown(id) || this.inFlight.has(id)) continue;
      this.queued.add(id);
    }
    if (this.queued.size > 0 && !this.flushScheduled) {
      this.flushScheduled = true;
      Promise.resolve().then(() => this.flush());
    }
  }

  /** `PeopleDirectory`: the SDK's view of the same cache. */
  async resolve(accountIds: string[]): Promise<Map<string, PersonInfo>> {
    await this.load(accountIds);
    const out = new Map<string, PersonInfo>();
    for (const id of accountIds) {
      const person = personFromEntity(useUsersStore.getState().getCachedById(id));
      if (person) out.set(id, { displayName: person.displayName, avatarFileId: person.avatar });
    }
    return out;
  }

  /** Resolves once every id is either cached or known to be unresolvable. */
  async load(ids: readonly string[]): Promise<void> {
    this.ensure(ids);
    if (this.queued.size > 0) await this.flush();
    await Promise.all(
      ids.map((id) => this.inFlight.get(id)).filter((p): p is Promise<void> => p !== undefined),
    );
  }

  private isKnown(id: string): boolean {
    if (useUsersStore.getState().getCachedById(id)) return true;
    const failedAt = this.unresolvedAt.get(id);
    return failedAt !== undefined && this.now() - failedAt < UNRESOLVED_TTL_MS;
  }

  private flush(): Promise<void> {
    this.flushScheduled = false;
    const ids = [...this.queued];
    this.queued.clear();
    if (ids.length === 0) return Promise.resolve();
    const generation = this.generation;
    const request = this.lookup(ids)
      .catch((): UsersLookupResult => ({ users: [], missing: [], failed: ids }))
      .then(({ users, missing, failed }) => {
        if (generation !== this.generation) return;
        useUsersStore.getState().upsertMany(users);
        for (const id of missing) this.unresolvedAt.set(id, this.now());
        if (failed.length > 0) this.scheduleRetry(failed);
        else if (users.length > 0 || missing.length > 0) this.retryAttempt = 0;
      })
      .finally(() => {
        if (generation !== this.generation) return;
        for (const id of ids) this.inFlight.delete(id);
      });
    for (const id of ids) this.inFlight.set(id, request);
    return request;
  }

  /** Asks again for ids whose request failed, after a pause that doubles each time. */
  private scheduleRetry(ids: readonly string[]): void {
    for (const id of ids) this.retryIds.add(id);
    if (this.retryTimer) return;
    const delay = Math.min(RETRY_FIRST_MS * 2 ** this.retryAttempt, RETRY_MAX_MS);
    this.retryAttempt += 1;
    const generation = this.generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (generation !== this.generation) return;
      const again = [...this.retryIds];
      this.retryIds.clear();
      this.ensure(again);
    }, delay);
  }
}

/** `usersStore`'s cached entity as a `Person`, or `undefined` when there is none. */
export function personFromEntity(entity: UserEntity | undefined): Person | undefined {
  if (!entity) return undefined;
  const name = typeof entity.name === 'string' ? entity.name : entity.name?.displayName;
  const handle = entity.username ?? entity.handle;
  const displayName = name || handle;
  if (!displayName) return undefined;
  return {
    id: entity.id,
    displayName,
    handle,
    avatar: entity.avatar ?? undefined,
    bio: entity.bio ?? entity.description,
    verified: entity.verified === true,
  };
}

/**
 * The app's resolver, over the Oxy client `OxyProvider` signs in with
 * (`@/lib/oxy`). Ordinary accounts use public profiles; supervised accounts
 * use the authenticated minimal people projection without public fallback.
 */
let directoryMode: 'unknown' | 'ordinary' | 'supervised' = 'ordinary';
export function configurePeople(mode: typeof directoryMode): void {
  directoryMode = mode;
  people.clear();
}
export const people = new PeopleResolver(async (ids) => {
  if (directoryMode === 'unknown') return { users: [], missing: [], failed: [] };
  if (directoryMode === 'ordinary') {
    const { found, missing, failed } = await oxyServices.users.lookupMany(ids);
    return { users: found, missing, failed };
  }
  const users: UserEntity[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const response = await oxyServices.safety.people({
      accountIds: ids.slice(offset, offset + 100),
    });
    users.push(
      ...response.items.map((person) => ({
        id: person.accountId,
        username: person.username ?? undefined,
        name: { displayName: person.displayName ?? person.username ?? '' },
      })),
    );
  }
  // The supervised projection answers for every id it was asked about: an id
  // it leaves out is one it will not show. A thrown batch is caught by the
  // resolver and becomes `failed`.
  const answered = new Set(users.map((user) => user.id));
  return { users, missing: ids.filter((id) => !answered.has(id)), failed: [] };
});
