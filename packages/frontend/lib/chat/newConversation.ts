/**
 * Starting a conversation, in words that are true on both backends.
 *
 * The New Chat screen knows people by their Oxy id and knows nothing else: not
 * room ids, not MXIDs, not participant documents. What it can say is "these
 * people, and this name if they are a group", and that is this module. The two
 * creators — `alloApiConversations.ts` and `matrixConversations.ts` — take it
 * from here in completely different directions, and {@link planConversation} is
 * the part they must not each decide for themselves: whether one person is a
 * direct message, and what a group is called.
 *
 * Both of them answer with a conversation id, because that is the only thing the
 * screen does next: `router.replace('/c/' + id)`.
 */

export interface NewConversationRequest {
  /**
   * Oxy user ids of the people to talk to, never including the viewer.
   *
   * The viewer is added by whoever is being asked — the Express API puts the
   * caller in the participant list, and a Matrix room's creator is in it by
   * construction — so passing them here would be asking to talk to oneself
   * twice.
   */
  readonly participantIds: readonly string[];
  /** What the user called the group. Ignored for a one-to-one conversation. */
  readonly name: string | undefined;
}

/**
 * Creating a conversation, whichever backend this build talks to.
 *
 * Answers with the id of the conversation to open. It is not the same kind of id
 * on the two backends — a Mongo ObjectId on one, a Matrix room id on the other —
 * and nothing above this line is allowed to care, which is what keeps the screen
 * free of a second code path.
 */
export type ConversationCreator = (request: NewConversationRequest) => Promise<string>;

/** The user asked to start a conversation with nobody in it. */
export class NoParticipantsError extends Error {
  constructor() {
    super('A conversation needs somebody to talk to. Choose at least one person.');
    this.name = 'NoParticipantsError';
  }
}

/**
 * The request, checked and reduced to the facts both backends need.
 *
 * The shape both creators start from, so that "two people is a direct message"
 * is decided once. If each decided for itself, the same tap would make a direct
 * conversation on one backend and a two-person group on the other — and on
 * Matrix that difference is permanent, because `m.direct` is what every client
 * uses to draw a room with the other person's name and avatar instead of a
 * generated title.
 */
export interface PlannedConversation {
  /** Deduplicated, in the order they were chosen. Never empty. */
  readonly participantIds: readonly string[];
  readonly isDirect: boolean;
  /** Absent for a direct conversation, and for a name that is only spaces. */
  readonly name: string | undefined;
}

export function planConversation(request: NewConversationRequest): PlannedConversation {
  // Deduplicated rather than trusted. The screen holds a Set, but a duplicate
  // arriving from anywhere else would be an invitation sent to the same person
  // twice on Matrix, and — worse — would turn a conversation with one person
  // into a "group" of two entries naming one.
  const participantIds = [...new Set(request.participantIds)];
  if (participantIds.length === 0) {
    throw new NoParticipantsError();
  }

  const isDirect = participantIds.length === 1;
  const name = request.name?.trim();
  return {
    participantIds,
    isDirect,
    // A one-to-one conversation is named after the other person by every client
    // that draws it, so a name here would be a title nobody asked for. A name of
    // nothing but spaces is not a name either.
    name: isDirect || name === undefined || name === '' ? undefined : name,
  };
}
