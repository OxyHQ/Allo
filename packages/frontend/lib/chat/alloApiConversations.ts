import type { Conversation, ConversationParticipant, ConversationType } from '@/app/(chat)/index';

import { planConversation, type NewConversationRequest, type PlannedConversation } from './newConversation';

/**
 * Starting a conversation on Allo's own backend.
 *
 * This is the path the app has always taken, moved out of `app/(chat)/new.tsx`
 * so that both backends are reached the same way — one call, one conversation
 * id — and so that the mapping from the API's answer to what the list draws can
 * be tested. It is deliberately unchanged in what it does: a POST to
 * `/conversations`, the response into the store, and the id to navigate to.
 *
 * The dependencies are injected rather than imported so that this module has no
 * opinion about React and no way to reach the network in a test.
 */

const CONVERSATIONS_ENDPOINT = '/conversations';

/** What the backend calls a conversation nobody named. */
const UNNAMED_GROUP = 'Group Chat';
const UNNAMED_DIRECT = 'Direct Chat';
const UNKNOWN_PARTICIPANT = 'Unknown';

export interface AlloApiConversationDependencies {
  /** POSTs to the Express API and answers with the body it sent back. */
  readonly post: (endpoint: string, body: unknown) => Promise<{ data: unknown }>;
  /**
   * The conversations this device already knows.
   *
   * Read to avoid asking for a direct conversation that exists. The backend
   * deduplicates them as well — it looks for a two-person conversation with the
   * same pair before creating one — so this changes nothing about the outcome,
   * only whether a round trip happens.
   */
  readonly known: readonly Conversation[];
  /** The viewer's Oxy id, to tell the other participant from themselves. */
  readonly viewerId: string | undefined;
  /** Puts the new conversation into the store the list draws from. */
  readonly remember: (conversation: Conversation) => void;
}

/** The API answered without a conversation in it. */
export class ConversationNotCreatedError extends Error {
  constructor() {
    super('The server did not say which conversation it created.');
    this.name = 'ConversationNotCreatedError';
  }
}

export async function createAlloApiConversation(
  request: NewConversationRequest,
  dependencies: AlloApiConversationDependencies,
): Promise<string> {
  const plan = planConversation(request);

  const existing = plan.isDirect
    ? findDirectConversation(dependencies.known, plan.participantIds[0], dependencies.viewerId)
    : undefined;
  if (existing !== undefined) {
    return existing.id;
  }

  const response = await dependencies.post(CONVERSATIONS_ENDPOINT, {
    type: conversationType(plan),
    participantIds: [...plan.participantIds],
    name: plan.name,
  });

  const conversation = toCreatedConversation(response.data, plan);
  dependencies.remember(conversation);
  return conversation.id;
}

function conversationType(plan: PlannedConversation): ConversationType {
  return plan.isDirect ? 'direct' : 'group';
}

/**
 * The direct conversation with one person, if this device already has it.
 *
 * Matched on the *other* participant, which is why the viewer's id is needed: a
 * direct conversation holds both of them, and the one that identifies it is the
 * one who is not you. Without a viewer id there is nothing to compare against
 * and the honest answer is "not found" — the backend will say so definitively.
 */
function findDirectConversation(
  known: readonly Conversation[],
  participantId: string,
  viewerId: string | undefined,
): Conversation | undefined {
  if (viewerId === undefined) {
    return undefined;
  }
  return known.find((conversation) => {
    if (conversation.type !== 'direct') {
      return false;
    }
    const other = conversation.participants?.find((participant) => participant.id !== viewerId);
    return other?.id === participantId;
  });
}

/**
 * The API's answer, as the conversation list draws it.
 *
 * Parsed from `unknown` rather than asserted into a shape, because this is a
 * system boundary: what comes back is whatever the server sent. The one thing
 * that cannot be defaulted is the id — a conversation with no id is a row
 * nothing can open and a route that leads nowhere — so its absence is an error
 * rather than an empty string.
 *
 * The response may be the conversation itself or wrapped in a `data` envelope,
 * and both have been seen from this endpoint.
 */
export function toCreatedConversation(
  payload: unknown,
  plan: PlannedConversation,
): Conversation {
  const body = asRecord(payload);
  const created = asRecord(body?.data) ?? body;
  if (created === undefined) {
    throw new ConversationNotCreatedError();
  }

  const id = asNonEmptyString(created._id) ?? asNonEmptyString(created.id);
  if (id === undefined) {
    throw new ConversationNotCreatedError();
  }

  const type = asConversationType(created.type) ?? conversationType(plan);
  const participants = toParticipants(created.participants);
  const name =
    asNonEmptyString(created.name) ?? (type === 'group' ? UNNAMED_GROUP : UNNAMED_DIRECT);
  const avatar = asNonEmptyString(created.avatar);

  return {
    id,
    type,
    name,
    lastMessage: '',
    timestamp: toTimestamp(created.createdAt),
    unreadCount: 0,
    avatar,
    participants,
    groupName: asNonEmptyString(created.name),
    groupAvatar: avatar,
    participantCount: participants.length,
  };
}

function toParticipants(value: unknown): ConversationParticipant[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const participants: ConversationParticipant[] = [];
  for (const entry of value) {
    const participant = asRecord(entry);
    const id = participant === undefined ? undefined : asNonEmptyString(participant.userId);
    if (participant === undefined || id === undefined) {
      continue;
    }
    const username = asNonEmptyString(participant.username);
    const name = asRecord(participant.name);
    participants.push({
      id,
      name: {
        displayName:
          (name === undefined ? undefined : asNonEmptyString(name.displayName)) ??
          username ??
          UNKNOWN_PARTICIPANT,
        first: (name === undefined ? undefined : asNonEmptyString(name.first)) ?? '',
        last: (name === undefined ? undefined : asNonEmptyString(name.last)) ?? '',
      },
      username,
      avatar: asNonEmptyString(participant.avatar),
    });
  }
  return participants;
}

/**
 * When the conversation was created, as the list's rows compare them.
 *
 * A conversation the server did not date, or dated in a way `Date` cannot read,
 * is dated now: it was created a moment ago, which is the one time that is
 * certainly close to true here and nowhere else in the list.
 */
function toTimestamp(value: unknown): string {
  const parsed = typeof value === 'string' ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asConversationType(value: unknown): ConversationType | undefined {
  return value === 'direct' || value === 'group' ? value : undefined;
}
