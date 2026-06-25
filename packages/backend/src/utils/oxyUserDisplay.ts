import type { User } from "@oxyhq/core";
import type {
  ConversationParticipant,
  EnrichedConversationParticipant,
  ParticipantDisplayName,
} from "@allo/shared-types";

interface OxyUserErrorShape {
  status?: unknown;
  code?: unknown;
}

export function getErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.status === "number" ? error.status : undefined;
}

export function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

export function getErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }

  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.message === "string" ? error.message : undefined;
}

export function isOxyUserNotFound(error: unknown): boolean {
  const shapedError: OxyUserErrorShape = isRecord(error) ? error : {};
  return shapedError.status === 404 || shapedError.code === "ERR_BAD_REQUEST";
}

export function enrichParticipantWithOxyUser(
  participant: ConversationParticipant,
  oxyUser: User | null | undefined
): EnrichedConversationParticipant {
  if (!oxyUser) {
    return {
      ...participant,
      name: participantNameOrFallback(participant),
    };
  }

  return {
    ...participant,
    name: resolveDisplayName(oxyUser),
    username: oxyUser.username,
    avatar: oxyUser.avatar,
  };
}

function participantNameOrFallback(
  participant: ConversationParticipant & { name?: ParticipantDisplayName }
): ParticipantDisplayName {
  return participant.name ?? { displayName: "Unknown", first: "Unknown", last: "" };
}

/**
 * Emit the participant display name straight from the Oxy API's canonical
 * `name.displayName` (core 3.10 types it as required). `first` / `last` are
 * passed through verbatim for callers that need the split parts; they are NOT
 * recomposed into a display string here.
 */
function resolveDisplayName(oxyUser: User): ParticipantDisplayName {
  const name = oxyUser.name;
  const displayName =
    trimToUndefined(name?.displayName) ?? trimToUndefined(oxyUser.username) ?? "Unknown";

  return {
    displayName,
    first: trimToUndefined(name?.first) ?? "",
    last: trimToUndefined(name?.last) ?? "",
  };
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
