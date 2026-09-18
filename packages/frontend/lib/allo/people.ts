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
 * `getUsersByIds`, so a group of thirty is one request, a list of two hundred
 * rows is one request, and a row asking twice is one entry. An id already in
 * the cache is not asked for again until its TTL passes, and an id that Oxy
 * does not answer (deleted, hidden) is remembered as unresolved for the same
 * TTL so the list does not ask for it on every render.
 */
import { oxyClient, type User } from '@oxy.so/core';
import type { PeopleDirectory, PersonInfo } from '@allo/core';
import { useUsersStore, type UserEntity } from '@/stores/usersStore';

/** What a screen draws for a person. `undefined` for anyone still being looked up. */
export interface Person {
  id: string;
  displayName: string;
  handle?: string;
  /** An Oxy file id or an absolute URL. Resolve with `oxyServices.getFileDownloadUrl` when it is an id. */
  avatar?: string;
  /** What the person says about themselves on Oxy, when they have said anything. */
  bio?: string;
}

/** How long "Oxy said nobody" is believed before being asked again. */
const UNRESOLVED_TTL_MS = 5 * 60 * 1000;

export type UsersLookup = (ids: string[]) => Promise<User[]>;

export class PeopleResolver implements PeopleDirectory {
  private queued = new Set<string>();
  private inFlight = new Map<string, Promise<void>>();
  private unresolvedAt = new Map<string, number>();
  private flushScheduled = false;

  constructor(
    private readonly lookup: UsersLookup,
    private readonly now: () => number = () => Date.now(),
  ) {}

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
    await Promise.all(ids.map((id) => this.inFlight.get(id)).filter((p): p is Promise<void> => p !== undefined));
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
    const request = this.lookup(ids)
      .then((users) => {
        useUsersStore.getState().upsertMany(users);
        const answered = new Set(users.map((u) => String(u.id)));
        for (const id of ids) if (!answered.has(id)) this.unresolvedAt.set(id, this.now());
      })
      .catch(() => {
        // A failed batch is not remembered: the next render asks again, which
        // is the right behaviour for a network blip and harmless for anything else.
      })
      .finally(() => {
        for (const id of ids) this.inFlight.delete(id);
      });
    for (const id of ids) this.inFlight.set(id, request);
    return request;
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
  };
}

/**
 * The app's resolver, over the Oxy client singleton that `OxyProvider` keeps in
 * lockstep with the session. Every underlying route is public, so no session
 * is needed to draw a person; the bearer only widens what is visible.
 */
export const people = new PeopleResolver((ids) => oxyClient.getUsersByIds(ids));
