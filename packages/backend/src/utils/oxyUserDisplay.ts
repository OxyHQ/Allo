import type { User } from "@oxyhq/core";
import type { ConversationParticipant } from "../models/Conversation";

export interface ParticipantDisplayName {
  first: string;
  last: string;
}

export interface EnrichedConversationParticipant extends ConversationParticipant {
  name?: ParticipantDisplayName;
  username?: string;
  avatar?: string;
}

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
  return participant.name ?? { first: "Unknown", last: "" };
}

function resolveDisplayName(oxyUser: User): ParticipantDisplayName {
  const name = oxyUser.name;
  const fullName = trimToUndefined(name?.full);
  const fallback = trimToUndefined(oxyUser.username) ?? "Unknown";

  if (name?.first || name?.last) {
    return {
      first: trimToUndefined(name.first) ?? firstFromFullName(fullName) ?? fallback,
      last: trimToUndefined(name.last) ?? lastFromFullName(fullName),
    };
  }

  if (fullName) {
    return {
      first: firstFromFullName(fullName) ?? fallback,
      last: lastFromFullName(fullName),
    };
  }

  return { first: fallback, last: "" };
}

function firstFromFullName(fullName: string | undefined): string | undefined {
  return fullName?.split(/\s+/)[0];
}

function lastFromFullName(fullName: string | undefined): string {
  const [, ...rest] = fullName?.split(/\s+/) ?? [];
  return rest.join(" ");
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
