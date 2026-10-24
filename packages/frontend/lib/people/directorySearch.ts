/**
 * WHAT A PEOPLE SEARCH MAY OFFER, AND IN WHAT ORDER.
 *
 * Allo has no address book: "new chat" is a search of the Oxy directory, so
 * every row it offers must be somebody a conversation can be started with,
 * and the rows keep the order the directory ranked them in.
 *
 * WHO. Any Oxy account is a valid participant (one with no Allo device yet is
 * held as "waiting for them to join"). An account that is not an Oxy account
 * is not: a FEDERATED profile (`@user@mastodon.social`) lives on another
 * server and can never hold this platform's MLS keys, so a conversation with
 * it would wait forever; an AGENT or AUTOMATED account is driven by software,
 * not by somebody who installs Allo. That is the profile's `type` (where it
 * lives and how it is driven). Its `kind` (personal, organization, project,
 * channel, bot) is deliberately NOT a filter: every local kind is an Oxy
 * account a person signs into, which is what joining a conversation needs.
 *
 * ORDER. The directory already ranks by relevance (its own accounts first).
 * Re-sorting the rows by name put federated namesakes above the exact handle
 * somebody typed, so nothing here sorts.
 */

/** One person a search found, ready for a row. */
export interface SearchedUser {
  readonly id: string;
  readonly displayName: string;
  readonly handle: string;
  readonly avatar?: string;
}

/** The fields of an Oxy profile this reads; a `User` from the SDK satisfies it. */
export interface DirectoryProfile {
  readonly id: string;
  readonly username?: string | null;
  readonly handle?: unknown;
  readonly name?: { readonly displayName?: string | null } | null;
  readonly avatar?: string | null;
  readonly type?: 'local' | 'federated' | 'agent' | 'automated' | null;
  readonly isFederated?: boolean | null;
}

/** Whether a conversation can be started with this account. Absent `type` is a local account. */
export function canBeConversationMember(profile: DirectoryProfile): boolean {
  if (profile.isFederated) return false;
  return profile.type == null || profile.type === 'local';
}

/** The directory's answer as rows: who may be messaged, in the directory's order. */
export function searchedUsersFrom(profiles: readonly DirectoryProfile[]): SearchedUser[] {
  return profiles.filter(canBeConversationMember).map((profile) => {
    const handle = profile.username ?? (typeof profile.handle === 'string' ? profile.handle : '');
    return {
      id: profile.id,
      displayName: profile.name?.displayName || handle,
      handle,
      ...(profile.avatar ? { avatar: profile.avatar } : {}),
    };
  });
}
