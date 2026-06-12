import type { BridgeEvent, BridgeExternalSelf, BridgeMediaRef } from "@allo/shared-types";
import { BRIDGE_PROTOCOL_VERSION } from "@allo/shared-types";
import type { ExternalSelf } from "../models/BridgeSession";

/**
 * Pure normalization from gramjs message shapes to the wire `BridgeEvent`.
 *
 * Kept dependency-free (no `TelegramClient`, no network) so it is exhaustively
 * unit-testable: a test feeds a plain object shaped like a gramjs `NewMessageEvent`
 * and asserts the exact `BridgeEvent` produced. The Telegram MANAGER does the
 * impure parts (resolving ids, downloading + re-hosting media) and then calls
 * these builders with already-resolved primitives.
 */

/** The wire protocol version literal, narrowed to satisfy `BridgeEvent.v`. */
const PROTOCOL_V = BRIDGE_PROTOCOL_VERSION as 1;

/** Minimal view of the message fields the normalizer needs (no gramjs types). */
export interface NormalizableMessage {
  /** Telegram message id (numeric). */
  id: number;
  /** Resolved external chat/peer id, as a string. */
  externalChatId: string;
  /** Resolved external sender id, as a string. */
  externalSenderId: string;
  /** Message text (may be empty for media-only messages). */
  text?: string;
  /** Unix seconds from Telegram (`message.date`). */
  dateSeconds?: number;
  /** Already-rehosted media refs (Allo-hosted URLs), if any. */
  media?: BridgeMediaRef[];
  /** Sender display fields for contact upsert. */
  senderDisplayName?: string;
  senderUsername?: string;
  senderAvatarUrl?: string;
}

/** Convert Telegram's unix-seconds date to an ISO string (or undefined). */
export function toIsoTimestamp(dateSeconds: number | undefined): string | undefined {
  if (typeof dateSeconds !== "number" || !Number.isFinite(dateSeconds)) return undefined;
  return new Date(dateSeconds * 1000).toISOString();
}

/**
 * Build an inbound `message` BridgeEvent. Returns null when the message carries
 * neither text nor media (Allo's route rejects such events, so we never send
 * them — e.g. a service message or an unsupported media type we couldn't rehost).
 */
export function buildMessageEvent(
  ownerUserId: string,
  msg: NormalizableMessage
): BridgeEvent | null {
  const hasText = typeof msg.text === "string" && msg.text.length > 0;
  const hasMedia = Array.isArray(msg.media) && msg.media.length > 0;
  if (!hasText && !hasMedia) return null;

  return {
    v: PROTOCOL_V,
    type: "message",
    network: "telegram",
    ownerUserId,
    externalChatId: msg.externalChatId,
    externalSenderId: msg.externalSenderId,
    externalMessageId: String(msg.id),
    text: hasText ? msg.text : undefined,
    media: hasMedia ? msg.media : undefined,
    timestamp: toIsoTimestamp(msg.dateSeconds),
    senderDisplayName: msg.senderDisplayName,
    senderUsername: msg.senderUsername,
    senderAvatarUrl: msg.senderAvatarUrl,
  };
}

/** Build an inbound `edit` BridgeEvent (new text/media for an existing message). */
export function buildEditEvent(
  ownerUserId: string,
  msg: NormalizableMessage
): BridgeEvent {
  const hasText = typeof msg.text === "string" && msg.text.length > 0;
  const hasMedia = Array.isArray(msg.media) && msg.media.length > 0;
  return {
    v: PROTOCOL_V,
    type: "edit",
    network: "telegram",
    ownerUserId,
    externalChatId: msg.externalChatId,
    externalMessageId: String(msg.id),
    text: hasText ? msg.text : undefined,
    media: hasMedia ? msg.media : undefined,
    timestamp: toIsoTimestamp(msg.dateSeconds),
  };
}

/** Build an inbound `delete` BridgeEvent for one deleted Telegram message id. */
export function buildDeleteEvent(
  ownerUserId: string,
  externalChatId: string,
  deletedMessageId: number
): BridgeEvent {
  return {
    v: PROTOCOL_V,
    type: "delete",
    network: "telegram",
    ownerUserId,
    externalChatId,
    externalMessageId: String(deletedMessageId),
  };
}

/**
 * Build a `send_result` BridgeEvent correlating an Allo-originated send. The
 * connector responds 200 to `/commands` FAST, then fires this so Allo can flip
 * the message's delivery status and record the external message id.
 */
export function buildSendResultEvent(params: {
  ownerUserId: string;
  externalChatId: string;
  messageId?: string;
  clientMessageId?: string;
  status: "sent" | "failed";
  externalMessageId?: string;
  error?: string;
}): BridgeEvent {
  return {
    v: PROTOCOL_V,
    type: "send_result",
    network: "telegram",
    ownerUserId: params.ownerUserId,
    externalChatId: params.externalChatId,
    messageId: params.messageId,
    clientMessageId: params.clientMessageId,
    status: params.status,
    externalMessageId: params.externalMessageId,
    error: params.error,
  };
}

/** How many trailing phone digits to keep visible in a masked hint. */
const PHONE_HINT_VISIBLE_TRAILING = 2;

/** Minimum length before masking adds bullets (shorter strings are kept as-is). */
const PHONE_HINT_MIN_LENGTH = 3;

/**
 * Mask a phone number into a privacy-preserving hint like `+34•••••12`: keep a
 * leading `+` (if present) and the last {@link PHONE_HINT_VISIBLE_TRAILING}
 * digits, replace the middle with bullets. We never send the full phone over the
 * wire — only a hint the user can recognise. Returns undefined for empty input.
 */
export function maskPhoneHint(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  const trimmed = phone.trim();
  if (trimmed.length === 0) return undefined;

  const hasPlus = trimmed.startsWith("+");
  const digits = hasPlus ? trimmed.slice(1) : trimmed;
  const prefix = hasPlus ? "+" : "";

  if (digits.length <= PHONE_HINT_MIN_LENGTH) {
    // Too short to mask meaningfully; reveal only the last digit.
    const last = digits.slice(-1);
    return `${prefix}•••${last}`;
  }

  const visible = digits.slice(-PHONE_HINT_VISIBLE_TRAILING);
  const hiddenCount = digits.length - PHONE_HINT_VISIBLE_TRAILING;
  return `${prefix}${"•".repeat(hiddenCount)}${visible}`;
}

/**
 * Map the connector's stored `ExternalSelf` (Telegram id/username/firstName/phone)
 * to the wire {@link BridgeExternalSelf} (externalId/username/displayName/phoneHint).
 * The phone is masked to a hint; the raw phone is NEVER put on the wire.
 */
export function toBridgeExternalSelf(self: ExternalSelf): BridgeExternalSelf {
  return {
    externalId: self.id,
    username: self.username,
    displayName: self.firstName,
    phoneHint: maskPhoneHint(self.phone),
  };
}

/**
 * Build a `session_status` BridgeEvent (how an account becomes/leaves active).
 * For the `active` status the connector includes `externalSelf` so the backend can
 * persist the user's external identity onto `LinkedAccount.externalSelf`.
 */
export function buildSessionStatusEvent(
  ownerUserId: string,
  sessionStatus: NonNullable<BridgeEvent["sessionStatus"]>,
  externalSelf?: BridgeExternalSelf,
  externalChatId = ""
): BridgeEvent {
  return {
    v: PROTOCOL_V,
    type: "session_status",
    network: "telegram",
    ownerUserId,
    // `session_status` is account-scoped, not chat-scoped, but the wire shape
    // requires a string `externalChatId`; an empty string is the documented
    // sentinel for "not applicable".
    externalChatId,
    sessionStatus,
    externalSelf,
  };
}
