import type { BridgeCommand } from "@allo/shared-types";
import { logger } from "./logger";
import { outboundRateLimiter } from "./rateLimiter";
import { sendDeduplicator } from "./sendDedup";
import { TelegramManager, SendFloodWaitError } from "./telegram/manager";
import { FLOOD_WAIT_RETRYABLE_CAP_SECONDS } from "./config";
import * as alloClient from "./alloClient";

/**
 * Outbound command handling (Allo -> connector -> Telegram).
 *
 * `/commands` validates + rate-checks synchronously, then performs the send and
 * maps the outcome to an HTTP status the backend's outbox understands:
 *  - 2xx  -> delivered (or terminally handled via a `send_result`); outbox done.
 *  - non-2xx -> the outbox leaves the row pending and RETRIES with backoff.
 * A Telegram FLOOD_WAIT is the key case the status code matters for: a SHORT wait
 * is retryable (respond non-2xx so the outbox paces the resend), a wait beyond
 * {@link FLOOD_WAIT_RETRYABLE_CAP_SECONDS} is not worth holding the row open, so
 * we accept (2xx) and fire a terminal `send_result: failed`. End-to-end delivery
 * confirmation still flows via `send_result` on success/terminal-failure.
 *
 * Because the send is AWAITED, the backend's request timeout (~10s) can fire
 * mid-send and trigger an outbox RETRY of the same command while we are still
 * sending. An in-process {@link sendDeduplicator} keyed by `messageId` guards
 * against delivering the same message to Telegram twice: a duplicate seen while
 * the first send is in-flight (or recently completed) is acknowledged WITHOUT
 * re-sending. A genuinely retryable outcome (short FLOOD_WAIT) RELEASES the id so
 * the legitimate outbox retry can proceed.
 */

/** Synchronous admission outcome the route turns into an HTTP status. */
export type CommandAccept =
  | { accepted: true }
  | { accepted: false; status: 400 | 429; reason: string };

/**
 * Outcome of executing a `send`, mapped by the route to a status code:
 *  - `done`      -> 200 (delivered, or terminal failure already reported).
 *  - `retryable` -> non-2xx (e.g. a short FLOOD_WAIT); the outbox retries. Carries
 *                   the wait hint purely for logging/headers.
 */
export type ExecuteResult =
  | { kind: "done" }
  | { kind: "retryable"; reason: string; retryAfterSeconds?: number };

const SEND: BridgeCommand["type"] = "send";

/**
 * Validate + admit a command. For `send`, applies the per-account outbound rate
 * cap (429 when exceeded → Allo retries via its outbox). `typing`/`read` are
 * accepted but not yet acted upon (the seam declares them; Telegram support is a
 * later refinement — they are no-ops here, never an error). Returns synchronously.
 */
export function admitCommand(command: BridgeCommand): CommandAccept {
  if (command.network !== "telegram") {
    return { accepted: false, status: 400, reason: "unsupported_network" };
  }
  if (!command.ownerUserId || !command.externalChatId) {
    return { accepted: false, status: 400, reason: "missing_owner_or_chat" };
  }
  if (command.type === SEND) {
    const hasText = typeof command.text === "string" && command.text.length > 0;
    const hasMedia = Array.isArray(command.media) && command.media.length > 0;
    if (!hasText && !hasMedia) {
      return { accepted: false, status: 400, reason: "send_requires_text_or_media" };
    }
    if (!outboundRateLimiter.tryConsume(command.ownerUserId)) {
      return { accepted: false, status: 429, reason: "rate_limited" };
    }
  }
  return { accepted: true };
}

/**
 * Execute an admitted command. For `send`, performs the Telegram send and fires a
 * `send_result` back to Allo (sent + externalMessageId, or terminal failed). For a
 * SHORT FLOOD_WAIT it returns `retryable` (no send_result) so the route responds
 * non-2xx and the outbox backs off; for a long FLOOD_WAIT it fires a terminal
 * `send_result: failed` and returns `done`. `typing`/`read` are no-ops. Never throws.
 *
 * Idempotency: a `send` carrying a `messageId` is guarded by the in-process
 * deduplicator. The id is CLAIMED before the send starts; a duplicate seen while
 * the first send is in-flight (or completed within the dedup TTL) returns `done`
 * WITHOUT re-sending (the original `send_result` covers it). A `retryable` outcome
 * RELEASES the id so the legitimate outbox retry isn't suppressed.
 */
export async function executeCommand(
  manager: TelegramManager,
  command: BridgeCommand
): Promise<ExecuteResult> {
  if (command.type !== SEND) {
    // typing/read: declared by the seam, not yet bridged to Telegram. No-op.
    return { kind: "done" };
  }

  const { messageId } = command;
  // A `send` without a messageId cannot be correlated/deduped (the seam should
  // always provide one). Proceed without the guard, but record it — a missing id
  // means a timeout-retry of this command could duplicate.
  if (!messageId) {
    logger.warn(
      `Outbound send for owner ${command.ownerUserId} has no messageId; cannot dedup`
    );
    return performSend(manager, command);
  }

  // Claim BEFORE sending. If we can't, an identical send is already in-flight or
  // completed within the TTL — acknowledge without re-sending.
  if (!sendDeduplicator.claim(messageId)) {
    logger.info(
      `Duplicate send for message ${messageId} (owner ${command.ownerUserId}) suppressed; original in-flight/recent`
    );
    return { kind: "done" };
  }

  const result = await performSend(manager, command);
  // A retryable failure means the message was NOT delivered and the outbox WILL
  // retry — release the claim so that retry can actually re-send. Done outcomes
  // (sent or terminally failed) keep the claim for the TTL so a stale
  // timeout-retry is deduped.
  if (result.kind === "retryable") {
    sendDeduplicator.release(messageId);
  }
  return result;
}

/**
 * Perform the actual Telegram send and fire the resulting `send_result`. Split out
 * of {@link executeCommand} so the dedup bookkeeping wraps it cleanly. Never throws.
 */
async function performSend(
  manager: TelegramManager,
  command: BridgeCommand
): Promise<ExecuteResult> {
  try {
    const { externalMessageId } = await manager.sendMessage({
      ownerUserId: command.ownerUserId,
      externalChatId: command.externalChatId,
      text: command.text,
      media: command.media,
    });
    await alloClient.postEvent(
      manager.buildSendResult({
        ownerUserId: command.ownerUserId,
        externalChatId: command.externalChatId,
        messageId: command.messageId,
        status: "sent",
        externalMessageId,
      })
    );
    return { kind: "done" };
  } catch (error) {
    if (error instanceof SendFloodWaitError) {
      return handleSendFlood(manager, command, error);
    }
    const reason = error instanceof Error ? error.message : "send_failed";
    logger.error(
      `Outbound send failed for owner ${command.ownerUserId} (message ${command.messageId ?? "?"})`,
      error as Error
    );
    await alloClient.postEvent(
      manager.buildSendResult({
        ownerUserId: command.ownerUserId,
        externalChatId: command.externalChatId,
        messageId: command.messageId,
        status: "failed",
        error: reason,
      })
    );
    return { kind: "done" };
  }
}

/**
 * Map a send-path FLOOD_WAIT to an execute result. A wait within the retryable cap
 * is surfaced as `retryable` (route -> non-2xx -> outbox backs off and resends).
 * A wait beyond the cap is terminal: fire `send_result: failed` and return `done`
 * so the message fails fast rather than holding an outbox row open for a long ban.
 */
async function handleSendFlood(
  manager: TelegramManager,
  command: BridgeCommand,
  error: SendFloodWaitError
): Promise<ExecuteResult> {
  if (error.seconds <= FLOOD_WAIT_RETRYABLE_CAP_SECONDS) {
    logger.warn(
      `Outbound send for owner ${command.ownerUserId} hit FLOOD_WAIT (${error.seconds}s); retryable`
    );
    return { kind: "retryable", reason: "flood_wait", retryAfterSeconds: error.seconds };
  }
  logger.error(
    `Outbound send for owner ${command.ownerUserId} hit FLOOD_WAIT (${error.seconds}s) beyond cap; failing`
  );
  await alloClient.postEvent(
    manager.buildSendResult({
      ownerUserId: command.ownerUserId,
      externalChatId: command.externalChatId,
      messageId: command.messageId,
      status: "failed",
      error: `flood_wait_${error.seconds}`,
    })
  );
  return { kind: "done" };
}
