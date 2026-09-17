/**
 * Starting a conversation, in words that do not depend on who answers.
 *
 * The New Chat screen knows people by their Oxy id and knows nothing else: not
 * conversation ids, not participant documents. What it can say is "these
 * people, and this name if they are a group", and that is this module. A
 * creator (`alloApiConversations.ts` today) takes it from here, and
 * {@link planConversation} is the part no creator may decide for itself:
 * whether one person is a direct message, and what a group is called.
 *
 * A creator answers with a conversation id, because that is the only thing the
 * screen does next: `router.replace('/c/' + id)`.
 */

export interface NewConversationRequest {
  /**
   * Oxy user ids of the people to talk to, never including the viewer.
   *
   * The viewer is added by whoever is being asked — the API puts the caller in
   * the participant list — so passing them here would be asking to talk to
   * oneself twice.
   */
  readonly participantIds: readonly string[];
  /** What the user called the group. Ignored for a one-to-one conversation. */
  readonly name: string | undefined;
}

/**
 * Creating a conversation.
 *
 * Answers with the id of the conversation to open. What kind of id that is,
 * nothing above this line is allowed to care about, which is what keeps the
 * screen free of a second code path.
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
 * The shape a creator starts from, so that "two people is a direct message" is
 * decided once. If each creator decided for itself, the same tap could make a
 * direct conversation in one place and a two-person group in another — and that
 * difference is permanent, because it is what every client uses to draw a
 * conversation with the other person's name and avatar instead of a generated
 * title.
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
  // arriving from anywhere else would turn a conversation with one person into
  // a "group" of two entries naming one.
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
