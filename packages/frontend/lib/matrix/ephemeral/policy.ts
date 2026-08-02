import type { AlloEphemeralPolicy } from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

/**
 * Where an ephemeral conversation is written down, and how.
 *
 * This lives above the platform split, beside `roomCreation.ts`, for the same
 * reason: it is a statement about the port's contract rather than about either
 * SDK. Both halves read and write the same document; if they disagreed about its
 * shape, a conversation made ephemeral on a phone would be an ordinary one in
 * the browser and the user would have no way to tell.
 *
 * ## Why account data, and not room state
 *
 * `docs/matrix/data-model.md` §5.2 planned a state event, `so.oxy.allo.room_class`,
 * and gave a good reason: room state is shared with the other participants, so
 * their clients would know to behave the same way. That plan does not survive
 * the native binding. `@unomed/react-native-matrix-sdk` has no API for reading or
 * writing a custom room state event at all — its `StateEventType` is a closed
 * enum of specified types, `RoomInfo` carries no raw state, and `Room.sendRaw`
 * sends message-like events only. What both halves *can* reach is global account
 * data with an arbitrary event type (`Client.accountData` / `Client.setAccountData`
 * on one side, `getAccountData` / `setAccountData` on the other).
 *
 * So the policy is the viewer's own. It reaches their other devices, through the
 * homeserver, and it reaches nobody else. What that costs is written down as a
 * numbered gap in `docs/matrix/ephemeral.md` §3, and it is the largest single
 * limitation of this tier: **the other person's messages are not on a timer
 * unless they set one too.**
 *
 * ## What the homeserver can see
 *
 * The event type and the room ids in it, in the clear — account data is not
 * encrypted. A homeserver therefore knows which of this account's conversations
 * are ephemeral and how long their messages live. That is unavoidable rather
 * than careless: the redactions it is about to receive would tell it the same
 * thing a few hours later.
 */

/** The account data event that holds every ephemeral conversation of this account. */
export const EPHEMERAL_POLICIES_EVENT_TYPE = 'so.oxy.allo.ephemeral_rooms';

/** The key inside it. One map, so one read answers for every conversation. */
export const EPHEMERAL_POLICIES_CONTENT_KEY = 'rooms';

/** The field a room's entry carries. Snake case, as Matrix content is. */
export const EPHEMERAL_LIFETIME_FIELD = 'lifetime_ms';

/**
 * The document itself, as a type.
 *
 * Written out rather than inferred because the web half declares it to
 * `matrix-js-sdk` — see `web/accountData.ts` — so that the account data calls
 * are as type-checked as the spec'd ones the SDK ships with, instead of being
 * cast past the compiler.
 */
export interface EphemeralPolicyDocument {
  readonly [EPHEMERAL_POLICIES_CONTENT_KEY]: Record<
    string,
    { readonly [EPHEMERAL_LIFETIME_FIELD]: number }
  >;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The shortest lifetime this client will act on.
 *
 * Not a matter of taste. A message that expires faster than a phone can plausibly
 * sync, be read and be redacted is one the reader never sees and the sender
 * believes they sent — and the sweep that redacts it runs on a timer, not on an
 * interrupt. Five minutes is short enough to be useful and long enough to be a
 * conversation.
 */
export const MIN_EPHEMERAL_LIFETIME_MS = 5 * MINUTE_MS;

/**
 * The longest.
 *
 * A lifetime beyond this is not a disappearing message, it is an archive policy,
 * and the honest way to have one is to say so rather than to let a number grow
 * until nothing ever expires. It also bounds the arithmetic: `sentAt + lifetime`
 * has to stay a number a `Date` accepts.
 */
export const MAX_EPHEMERAL_LIFETIME_MS = 30 * DAY_MS;

/**
 * What the interface offers, in the order it offers them.
 *
 * Three and not a free field. A duration picker invites a lifetime of eleven
 * minutes, which reads as precision the mechanism does not have: the sweep is
 * periodic, the other person's client may be asleep, and the guarantee is
 * "roughly then, if we are running". Three named durations say that honestly.
 */
export const EPHEMERAL_LIFETIME_CHOICES: readonly number[] = [HOUR_MS, DAY_MS, 7 * DAY_MS];

/**
 * Whether a number is a lifetime this client will act on.
 *
 * Every caller of this is looking at external input: the account data comes back
 * from a homeserver, and another client — or an older Allo — may have written
 * anything into it.
 */
export function isUsableEphemeralLifetime(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_EPHEMERAL_LIFETIME_MS &&
    value <= MAX_EPHEMERAL_LIFETIME_MS
  );
}

/**
 * The account's ephemeral conversations, from the account data content.
 *
 * Tolerant of everything except a lifetime it cannot act on. A document with a
 * shape nobody here recognises yields an empty map — treating an unreadable
 * policy as "no policy" is the only safe direction, because the other one would
 * put an arbitrary timer on a conversation the user never asked to be ephemeral.
 * An entry with an unusable lifetime is dropped **and logged**: it is the case
 * where the user did ask, and silently ignoring it would be a conversation the
 * app promised to expire and never does.
 *
 * @param content the parsed content of {@link EPHEMERAL_POLICIES_EVENT_TYPE}, or
 * `undefined` when the account has none.
 */
export function parseEphemeralPolicies(
  content: unknown,
): ReadonlyMap<string, AlloEphemeralPolicy> {
  const policies = new Map<string, AlloEphemeralPolicy>();
  const rooms = readRooms(content);
  if (rooms === undefined) {
    return policies;
  }

  for (const [roomId, entry] of Object.entries(rooms)) {
    if (roomId === '' || !isRecord(entry)) {
      continue;
    }
    const lifetimeMs = entry[EPHEMERAL_LIFETIME_FIELD];
    if (!isUsableEphemeralLifetime(lifetimeMs)) {
      logger.warn(
        `[matrix] ${roomId} is marked ephemeral with a lifetime this build will ` +
          'not act on, so it is being drawn as an ordinary conversation',
      );
      continue;
    }
    policies.set(roomId, { lifetimeMs });
  }
  return policies;
}

/**
 * The same thing, from the JSON text the native binding hands account data over
 * as.
 *
 * The binding's `Client.accountData` answers with a string; `matrix-js-sdk`
 * answers with a parsed object. This is where that difference stops, so that
 * only one of the two halves carries a `JSON.parse` and neither carries a
 * `catch` that shrugs: text that is not JSON is text this build cannot act on,
 * and it is reported before being discarded.
 */
export function parseEphemeralPoliciesDocument(
  json: string | undefined,
): ReadonlyMap<string, AlloEphemeralPolicy> {
  if (json === undefined) {
    return new Map();
  }
  try {
    return parseEphemeralPolicies(JSON.parse(json));
  } catch (error) {
    logger.error(
      `[matrix] the ${EPHEMERAL_POLICIES_EVENT_TYPE} account data is not JSON, so ` +
        'no conversation is being treated as ephemeral',
      error,
    );
    return new Map();
  }
}

/**
 * The content to write back.
 *
 * The whole document every time, because that is what account data is: there is
 * no partial update, and a write that carried only the room being changed would
 * delete every other one. What makes that safe here is that the caller has just
 * read the current document — see {@link withEphemeralPolicy}.
 */
export function encodeEphemeralPolicies(
  policies: ReadonlyMap<string, AlloEphemeralPolicy>,
): EphemeralPolicyDocument {
  const rooms: Record<string, { [EPHEMERAL_LIFETIME_FIELD]: number }> = {};
  for (const [roomId, policy] of policies) {
    rooms[roomId] = { [EPHEMERAL_LIFETIME_FIELD]: policy.lifetimeMs };
  }
  return { [EPHEMERAL_POLICIES_CONTENT_KEY]: rooms };
}

/**
 * The document with one conversation changed, added or removed.
 *
 * A pure function over the map, so the read-modify-write in each half of the
 * port is three lines with nothing to get wrong, and the interesting part — that
 * removing is `undefined` rather than a lifetime of zero — is tested here.
 */
export function withEphemeralPolicy(
  policies: ReadonlyMap<string, AlloEphemeralPolicy>,
  roomId: string,
  policy: AlloEphemeralPolicy | undefined,
): ReadonlyMap<string, AlloEphemeralPolicy> {
  const next = new Map(policies);
  if (policy === undefined) {
    next.delete(roomId);
  } else {
    next.set(roomId, policy);
  }
  return next;
}

/** A lifetime the caller chose, refused rather than clamped if it is not one. */
export function ephemeralPolicyOf(lifetimeMs: number): AlloEphemeralPolicy {
  if (!isUsableEphemeralLifetime(lifetimeMs)) {
    throw new RangeError(
      `${lifetimeMs}ms is not a usable message lifetime. It has to be a whole ` +
        `number of milliseconds between ${MIN_EPHEMERAL_LIFETIME_MS} and ` +
        `${MAX_EPHEMERAL_LIFETIME_MS}.`,
    );
  }
  return { lifetimeMs };
}

function readRooms(content: unknown): Record<string, unknown> | undefined {
  if (!isRecord(content)) {
    return undefined;
  }
  const rooms = content[EPHEMERAL_POLICIES_CONTENT_KEY];
  return isRecord(rooms) ? rooms : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
