import type { User } from '@oxyhq/core';

import { logger } from '@/utils/logger';

import {
  matrixServerNameOf,
  matrixUserIdsIn,
  oxyUserIdFrom,
  parseMatrixUserId,
} from './matrixIdentity';
import { ghostNetworkFor, type GhostNamespace } from './roomOrigin';

/**
 * WHO SOMEBODY IN A CONVERSATION IS.
 *
 * The one place that turns a Matrix user id into a person, and the only place in
 * chat that asks Oxy anything about one.
 *
 * ## Why it is one module
 *
 * Five `oxyServices.*` calls are all the frontend makes about people, and they
 * are moving behind `api.allo.you`. Every surface that draws somebody in a
 * conversation — the room list's titles, the conversation header, the member
 * list, the sender of a message in a group, an invitation, the ephemeral send
 * warning — goes through {@link ChatPeopleGateway} and nothing else, so that
 * move is a change to one implementation of one interface and not to twenty call
 * sites. The gateway is deliberately the narrowest thing that works: two methods,
 * both of which the replacement will have to provide anyway.
 *
 * ## Why the classification comes before the lookup
 *
 * Not every member of a room is an Oxy account, and the ones that are not must
 * never reach an Oxy lookup:
 *
 * - **A bridge's puppet** is a WhatsApp or Telegram contact wearing an MXID.
 *   `roomOrigin.ts` already owns the rule for recognising one and is asked
 *   FIRST — before the localpart is examined at all — because that ordering is
 *   what stops a namespace ever being mistaken for an account.
 * - **Somebody on another homeserver** has a localpart that means whatever their
 *   server decided, and it is not an Oxy id even when it is shaped like one.
 * - **A localpart that is not a well-formed Oxy id** is refused rather than
 *   repaired, which is the mirror of the rule in `matrixIdentity.ts`: coercing
 *   one and looking it up puts a stranger's name and face on somebody's
 *   messages.
 *
 * All three are drawn from what Matrix itself says about them, and Matrix
 * usually says nothing, so all three can end up as {@link ChatPersonState
 * `unresolved`}. That is a state with words of its own — see
 * {@link chatPersonFrom} — and never the id.
 *
 * ## Why "not yet" and "not ever" are different states
 *
 * A lookup takes a round trip. Drawing "Unknown person" for that moment and then
 * replacing it with a name is a flicker that says something false in between, so
 * a person still being looked up is `pending` and every surface draws nothing for
 * them. A person the lookup finished and failed on is `unresolved`, and *that* is
 * where the honest sentence goes.
 */

/** Where somebody in a conversation comes from. */
export type ChatPersonOrigin =
  /** An Oxy account on the viewer's own homeserver. The only kind Oxy is asked about. */
  | { readonly kind: 'oxy'; readonly oxyUserId: string }
  /** A remote network's contact, carried by a bridge. Never an Oxy lookup. */
  | { readonly kind: 'bridged'; readonly networkId: string }
  /**
   * Nobody Allo can name from an id: another homeserver's user, or a localpart
   * on ours that is not an Oxy id. Whatever Matrix says about them is all there
   * is.
   */
  | { readonly kind: 'foreign' };

/** How far Allo has got with finding out who somebody is. */
export type ChatPersonState =
  /** Their name is known, from Oxy or from Matrix. */
  | 'resolved'
  /** The lookup has not answered yet. Surfaces draw nothing rather than a guess. */
  | 'pending'
  /** The lookup finished and nobody could be named. */
  | 'unresolved';

/**
 * Somebody, ready to be drawn.
 *
 * {@link displayName} is **never a Matrix user id**. That is the invariant this
 * whole module exists to hold, and `__tests__/chat/noMatrixIdsOnScreen.test.ts`
 * is what keeps it holding.
 */
export interface ChatPerson {
  /** The Matrix user id this is about. For keys and lookups, never for drawing. */
  readonly userId: string;
  readonly origin: ChatPersonOrigin;
  readonly state: ChatPersonState;
  /** Never an MXID. Empty only while {@link state} is `pending`. */
  readonly displayName: string;
  /** The Oxy handle, without its `@`. Absent for anybody who is not an Oxy account. */
  readonly handle: string | undefined;
  /** An image URL a view can fetch. Never an id and never an `mxc://` URI. */
  readonly avatarUrl: string | undefined;
  readonly verified: boolean;
}

/**
 * What a surface knows about somebody before anything is looked up.
 *
 * `matrixDisplayName` travels with the id because for a bridged or foreign
 * person it is the *only* name there will ever be, and the surface asking has it
 * already — `AlloRoomMember.displayName`, `AlloTimelineItem.senderDisplayName`.
 * Fetching it separately would be a second round trip for something already in
 * hand.
 */
export interface ChatPersonRequest {
  readonly userId: string;
  /** The name Matrix itself has for them, if any. */
  readonly matrixDisplayName?: string | undefined;
}

/** Somebody by their Matrix user id, or `undefined` if nobody asked about them. */
export type ChatPeopleLookup = (matrixUserId: string) => ChatPerson | undefined;

/** A lookup that knows nobody, so a caller with no people to draw needs no branch. */
export const NO_CHAT_PEOPLE: ChatPeopleLookup = () => undefined;

/**
 * Everything chat asks about a person, and the whole of what moves to
 * `api.allo.you`.
 *
 * Structurally typed against `OxyServices` rather than importing it, for the
 * same reason `lib/matrix/web/` types the Matrix SDK structurally: it keeps this
 * module — and its tests — free of a client that needs a session to exist.
 */
export interface ChatPeopleGateway {
  /**
   * Several accounts in one round trip.
   *
   * Plural, and there is no singular version on purpose: a group of thirty must
   * not be thirty requests, and an interface that offered one at a time would be
   * the thing that made it so. The SDK deduplicates, chunks and drops ids it
   * cannot use, and answers only with the accounts it found — an id that names
   * nobody is simply absent, which is what {@link ChatPersonState `unresolved`}
   * is for.
   */
  getUsersByIds(ids: string[]): Promise<readonly User[]>;
  /** Turns an Oxy Cloud file id into a URL a view can fetch. */
  getFileDownloadUrl(fileId: string, variant?: string): string;
}

/** What one Oxy account contributes to a {@link ChatPerson}. */
export interface OxyPersonProfile {
  readonly displayName: string;
  readonly handle: string | undefined;
  readonly avatarUrl: string | undefined;
  readonly verified: boolean;
}

/**
 * The homeserver the viewer's own account is on, or `undefined`.
 *
 * `matrixServerNameOf` throws, and here it must not. Every caller is a screen
 * drawing people: with no server name nothing is claimed to be an Oxy account,
 * every id stays foreign, and the screen still renders — whereas a throw takes
 * the conversation list away over a session that cannot exist unless an SDK
 * produced a malformed one. Worth a log line, not a crash.
 */
export function viewerServerNameOf(viewerUserId: string | undefined): string | undefined {
  if (viewerUserId === undefined) {
    return undefined;
  }
  try {
    return matrixServerNameOf(viewerUserId);
  } catch (error: unknown) {
    logger.error('[chat] the signed-in session does not name a homeserver', error);
    return undefined;
  }
}

/**
 * Which of the three kinds of person an MXID names.
 *
 * `serverName` is the viewer's own homeserver, read from their session — see
 * `matrixServerNameOf`. `undefined` means nobody is signed in, in which case
 * nothing can be claimed about anybody and every id is `foreign`.
 */
export function chatPersonOriginOf(
  matrixUserId: string,
  serverName: string | undefined,
  namespaces: readonly GhostNamespace[],
): ChatPersonOrigin {
  // First, and not as an optimisation. A bridge's namespace is a prefix on the
  // localpart, so asking Oxy before asking `roomOrigin.ts` would be asking about
  // a WhatsApp contact — and the day a namespace produces something that parses
  // as an Oxy id, it would be answered.
  const networkId = ghostNetworkFor(matrixUserId, namespaces);
  if (networkId !== undefined) {
    return { kind: 'bridged', networkId };
  }
  if (serverName === undefined) {
    return { kind: 'foreign' };
  }
  const oxyUserId = oxyUserIdFrom(matrixUserId, serverName);
  return oxyUserId === undefined ? { kind: 'foreign' } : { kind: 'oxy', oxyUserId };
}

/**
 * An Oxy account, reduced to what a conversation draws of somebody.
 *
 * `name.displayName` before `username`, matching `useProfileData`: the API
 * resolves the first one and consumers render it rather than recomposing a name
 * from its parts. A handle is a last resort for the *name* and always the
 * `handle`, which is why the two fields can hold the same string.
 */
export function oxyPersonProfileOf(
  user: User,
  gateway: ChatPeopleGateway,
): OxyPersonProfile {
  const handle = user.username === '' ? undefined : user.username;
  return {
    displayName: user.name?.displayName || handle || '',
    handle,
    avatarUrl: avatarUrlOf(user.avatar, gateway),
    verified: user.verified === true,
  };
}

/**
 * A URL for an avatar, from whatever the account happens to carry.
 *
 * An Oxy avatar is normally a Cloud file id and occasionally an absolute URL
 * already. Anything that is neither — an `mxc://` URI most of all — is dropped
 * rather than handed to the file endpoint, which would answer with a 404 that
 * the view draws as a broken image.
 */
function avatarUrlOf(
  avatar: string | null | undefined,
  gateway: ChatPeopleGateway,
): string | undefined {
  if (avatar === null || avatar === undefined || avatar === '') {
    return undefined;
  }
  if (avatar.startsWith('http://') || avatar.startsWith('https://')) {
    return avatar;
  }
  if (avatar.includes('://')) {
    // A scheme Oxy Cloud does not serve. `mxc://` is the one that turns up, and
    // there is no id in it that the file endpoint could resolve.
    return undefined;
  }
  return gateway.getFileDownloadUrl(avatar, 'thumb');
}

/**
 * Somebody, from everything now known about them.
 *
 * @param profile the Oxy account, `null` when the lookup finished and found
 * nobody, and `undefined` while it has not finished. The three are different
 * answers and the distinction is the whole reason this takes three arguments
 * instead of one optional profile.
 * @param unknownPersonLabel what to call somebody nobody could name. Passed in
 * rather than looked up here so this stays a pure function of its arguments and
 * the sentence stays in the user's own language.
 */
export function chatPersonFrom(
  request: ChatPersonRequest,
  origin: ChatPersonOrigin,
  profile: OxyPersonProfile | null | undefined,
  unknownPersonLabel: string,
): ChatPerson {
  const matrixName = nonEmpty(request.matrixDisplayName);

  if (origin.kind === 'oxy') {
    if (profile === undefined) {
      // Still being looked up. Nothing is drawn: a name that appears and then
      // changes is worse than one that appears a moment late.
      return placeholder(request.userId, origin, 'pending', '', matrixName);
    }
    if (profile !== null && profile.displayName !== '') {
      return {
        userId: request.userId,
        origin,
        state: 'resolved',
        displayName: profile.displayName,
        handle: profile.handle,
        avatarUrl: profile.avatarUrl,
        verified: profile.verified,
      };
    }
    // The account exists on the homeserver and Oxy could not describe it. What
    // Matrix says is worth more than nothing, and the honest sentence is the
    // last resort.
    return placeholder(request.userId, origin, 'unresolved', unknownPersonLabel, matrixName);
  }

  // Bridged and foreign people are never looked up, so there is nothing to wait
  // for: whatever Matrix said is the answer, and it is final either way.
  return placeholder(request.userId, origin, 'unresolved', unknownPersonLabel, matrixName);
}

function placeholder(
  userId: string,
  origin: ChatPersonOrigin,
  state: ChatPersonState,
  label: string,
  matrixDisplayName: string | undefined,
): ChatPerson {
  // Matrix's own name is preferred over the label, and refused when it is itself
  // a user id: `matrix-js-sdk` answers `RoomMember.name` with the MXID when
  // somebody has set no display name, and disambiguates a duplicate by appending
  // it, so a name arriving from there is not automatically a name.
  const fromMatrix =
    matrixDisplayName !== undefined && parseMatrixUserId(matrixDisplayName) === undefined
      ? matrixDisplayName
      : undefined;
  return {
    userId,
    origin,
    state: fromMatrix === undefined ? state : 'resolved',
    displayName: fromMatrix ?? label,
    handle: undefined,
    avatarUrl: undefined,
    verified: false,
  };
}

/**
 * The title of a conversation, with the people in it named instead of numbered.
 *
 * A room with an `m.room.name` comes back unchanged; there is nothing here for
 * one. What this is for is the other kind, whose title both SDKs compute from its
 * members — see {@link matrixUserIdsIn} for why that title is made of MXIDs on
 * Allo's homeserver, and why it cannot be reconstructed from anything else the
 * summary carries.
 *
 * **Only ids on the viewer's own homeserver are rewritten.** An id belonging to
 * somebody else's server is left exactly as it was found, because at that point
 * the string is far more likely to be something a person typed into a group's
 * name than a member of it — and a title the user chose must survive this
 * function byte for byte.
 *
 * An empty string when a person in the title is still being looked up: half a
 * title is not a title, and the alternative is the id.
 */
export function conversationTitleFrom(
  roomTitle: string | undefined,
  serverName: string | undefined,
  people: ChatPeopleLookup,
): string {
  if (roomTitle === undefined || roomTitle === '') {
    return '';
  }
  let title = roomTitle;
  for (const userId of matrixUserIdsIn(roomTitle)) {
    if (parseMatrixUserId(userId)?.serverName !== serverName) {
      continue;
    }
    const person = people(userId);
    if (person === undefined || person.displayName === '') {
      return '';
    }
    title = title.split(userId).join(person.displayName);
  }
  return title;
}

/**
 * Whether a room title is the name the room was GIVEN, rather than one computed
 * from the people in it.
 *
 * The two are the same field everywhere the port reports a title, and only one
 * of them may be offered back to the user in the box that renames the room:
 * writing a computed title into `m.room.name` turns "the people in this
 * conversation" into a permanent, server-readable string — which for an unnamed
 * group on Allo's homeserver would be a list of MXIDs, saved for everyone.
 *
 * Decided by whether the title contains an id from the viewer's own homeserver,
 * which is what a computed one is made of here and what a name somebody typed
 * has no reason to contain.
 */
export function isOwnRoomName(
  roomTitle: string | undefined,
  serverName: string | undefined,
): boolean {
  if (roomTitle === undefined || roomTitle === '') {
    return false;
  }
  return !matrixUserIdsIn(roomTitle).some(
    (userId) => parseMatrixUserId(userId)?.serverName === serverName,
  );
}

/**
 * Everybody a list of conversation titles needs resolved.
 *
 * Deduplicated across the whole list, because one person is in several
 * conversations and the point of asking here — rather than inside each row — is
 * that the list makes one request and not one per row.
 */
export function peopleInConversationTitles(
  titles: readonly (string | undefined)[],
): readonly ChatPersonRequest[] {
  const seen = new Set<string>();
  const requests: ChatPersonRequest[] = [];
  for (const title of titles) {
    if (title === undefined || title === '') {
      continue;
    }
    for (const userId of matrixUserIdsIn(title)) {
      if (!seen.has(userId)) {
        seen.add(userId);
        requests.push({ userId });
      }
    }
  }
  return requests;
}

/** Nothing to ask about, as one identity so a memo does not see a new array. */
export const NO_CHAT_PERSON_REQUESTS: readonly ChatPersonRequest[] = [];

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/* ---------------------------------------------------------------------------
 * Batching
 * ------------------------------------------------------------------------- */

/**
 * How long a batch waits for company.
 *
 * Zero: the point is not to wait but to let the current tick finish. React
 * renders a whole list before anything it started can settle, so every row's
 * request is already in hand by the time a timer of zero fires — and a real
 * delay would only make the names appear later.
 */
const BATCH_WINDOW_MS = 0;

/**
 * Turns many concurrent one-person questions into few many-person requests.
 *
 * The caching layer above this is React Query, one entry per person, which is
 * what makes a member list that was already drawn in the conversation list cost
 * nothing. But per-person cache entries mean per-person fetches, and thirty of
 * those is the M+1 that `getUsersByIds` exists to prevent. This closes the gap:
 * every id asked for within one tick is answered by one request.
 *
 * A failed request rejects every waiter in its batch rather than resolving them
 * as "nobody". React Query is then free to retry, and — more importantly — a
 * network blip does not get cached as thirty people who do not exist.
 */
export class ChatPeopleDirectory {
  readonly #gateway: ChatPeopleGateway;
  readonly #schedule: (flush: () => void) => void;
  #waiting = new Map<string, Resolver[]>();
  #scheduled = false;

  /**
   * @param schedule when to flush. Injectable so a test can drive the batching
   * itself rather than sleeping, which is the only way to assert that thirty ids
   * became one request and not thirty.
   */
  constructor(
    gateway: ChatPeopleGateway,
    schedule: (flush: () => void) => void = (flush) => {
      setTimeout(flush, BATCH_WINDOW_MS);
    },
  ) {
    this.#gateway = gateway;
    this.#schedule = schedule;
  }

  /** The account with this Oxy id, or `null` if there is none. */
  load(oxyUserId: string): Promise<OxyPersonProfile | null> {
    return new Promise<OxyPersonProfile | null>((resolve, reject) => {
      const waiters = this.#waiting.get(oxyUserId);
      if (waiters === undefined) {
        this.#waiting.set(oxyUserId, [{ resolve, reject }]);
      } else {
        waiters.push({ resolve, reject });
      }
      if (!this.#scheduled) {
        this.#scheduled = true;
        this.#schedule(() => {
          void this.#flush();
        });
      }
    });
  }

  async #flush(): Promise<void> {
    const batch = this.#waiting;
    // Taken before the request, not after: anything asked for while it is in
    // flight belongs to the next batch, and must not be dropped by the answer to
    // this one.
    this.#waiting = new Map();
    this.#scheduled = false;
    if (batch.size === 0) {
      return;
    }

    try {
      const users = await this.#gateway.getUsersByIds([...batch.keys()]);
      const byId = new Map(users.map((user) => [user.id, user]));
      for (const [oxyUserId, waiters] of batch) {
        const user = byId.get(oxyUserId);
        const profile = user === undefined ? null : oxyPersonProfileOf(user, this.#gateway);
        for (const waiter of waiters) {
          waiter.resolve(profile);
        }
      }
    } catch (error: unknown) {
      for (const waiters of batch.values()) {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
      }
    }
  }
}

interface Resolver {
  readonly resolve: (profile: OxyPersonProfile | null) => void;
  readonly reject: (error: unknown) => void;
}
