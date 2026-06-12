import crypto from "crypto";
import type { Namespace } from "socket.io";
import type { BridgeEvent, BridgeMediaRef, Network } from "@allo/shared-types";
import Conversation, { type IConversation } from "../models/Conversation";
import Message, { type IMessage, type MediaItem } from "../models/Message";
import ExternalContact from "../models/ExternalContact";
import LinkedAccount, {
  type LinkedAccountStatus,
  type ILinkedAccount,
} from "../models/LinkedAccount";
import BridgeOutbox from "../models/BridgeOutbox";
import { logger } from "../utils/logger";

/**
 * BridgeInboundService — the INBOUND half of the interop seam (external -> Allo).
 *
 * Consumes `BridgeEvent`s delivered to `POST /internal/bridge/events` and projects
 * them onto Allo's existing data model:
 *  - external people never enter `participants[]` (they go in `externalParticipants`);
 *  - inbound content reuses the LEGACY plaintext path (`text`/`media`), which the
 *    frontend already renders from any sender — so no frontend change is needed.
 *
 * Every `handleEvent` branch is wrapped in try/catch: a processing error is logged
 * and swallowed so the internal route returns 200 (the connector must not retry a
 * poison event; genuine malformed-shape errors are rejected by the route as 400
 * BEFORE this service runs).
 */

const DUPLICATE_KEY_CODE = 11000;

/** True when a thrown error is a MongoDB duplicate-key (E11000) error. */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: number }).code === DUPLICATE_KEY_CODE
  );
}

/**
 * Resolve the Socket.IO `/messaging` namespace, or null when sockets aren't
 * wired (e.g. unit tests). Resolved the same way the message routes do.
 */
function getMessagingNamespace(): Namespace | null {
  const io = (global as { io?: { of: (nsp: string) => Namespace } }).io;
  return io ? io.of("/messaging") : null;
}

/** Sentinel sender id for a bridged-in message: `ext:<network>:<externalId>`. */
function externalSenderId(network: Network, externalId: string): string {
  return `ext:${network}:${externalId}`;
}

/** Map wire BridgeMediaRef[] to stored MediaItem[] (generating ids if absent). */
function toMediaItems(media: BridgeMediaRef[] | undefined): MediaItem[] | undefined {
  if (!media || media.length === 0) return undefined;
  return media.map((m) => ({
    id: m.id ?? crypto.randomUUID(),
    type: m.type,
    url: m.url,
    fileName: m.fileName,
    fileSize: m.fileSize,
    mimeType: m.mimeType,
    width: m.width,
    height: m.height,
    duration: m.duration,
  }));
}

interface FindOrCreateBridgedConversationParams {
  network: Network;
  ownerUserId: string;
  externalChatId: string;
  contact?: {
    externalId: string;
    displayName?: string;
    username?: string;
    avatar?: string;
  };
}

/**
 * Find the bridged conversation for (network, owner, external chat), or create
 * it. ONE implementation, shared by inbound `message` handling and the
 * user-facing `POST /api/bridge/conversations` route.
 *
 * The created conversation has the OWNER as its sole `participant` and the
 * external contact in `externalParticipants` — keeping external people out of
 * the participant array (which drives Oxy enrichment, unread counts, etc.).
 * Handles the unique-index race (E11000) by re-reading.
 */
export async function findOrCreateBridgedConversation(
  params: FindOrCreateBridgedConversationParams
): Promise<IConversation> {
  const { network, ownerUserId, externalChatId, contact } = params;
  const query = {
    "bridge.network": network,
    "bridge.ownerUserId": ownerUserId,
    "bridge.externalChatId": externalChatId,
  };

  const existing = await Conversation.findOne(query);
  if (existing) return existing;

  try {
    return await Conversation.create({
      type: "direct",
      participants: [{ userId: ownerUserId, role: "admin", joinedAt: new Date() }],
      externalParticipants: [
        {
          network,
          externalId: contact?.externalId ?? externalChatId,
          displayName: contact?.displayName,
          username: contact?.username,
          avatar: contact?.avatar,
        },
      ],
      bridge: { network, ownerUserId, externalChatId },
      createdBy: ownerUserId,
      unreadCounts: {},
    });
  } catch (err) {
    // Lost the create race: another request inserted the same triple. Re-read.
    if (isDuplicateKeyError(err)) {
      const raced = await Conversation.findOne(query);
      if (raced) return raced;
    }
    throw err;
  }
}

/** Map an inbound session status onto the LinkedAccount status enum. */
function mapSessionStatus(status: BridgeEvent["sessionStatus"]): LinkedAccountStatus {
  switch (status) {
    case "active":
      return "active";
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    default:
      return "error";
  }
}

/** Emit an arbitrary message event to a conversation room (no-op without sockets). */
function emitToConversation(conversationId: string, event: string, payload: unknown): void {
  const ns = getMessagingNamespace();
  if (!ns) return;
  ns.to(`conversation:${conversationId}`).emit(event, payload);
}

/**
 * Handle an inbound `message` event: upsert the contact, find/create the bridged
 * conversation, dedup, persist a plaintext Message, bump conversation state, and
 * fan out `newMessage`. Replicates the messages-route emit lines (to the
 * conversation room AND the owner's user room) rather than refactoring the core
 * POST path — keeping that path untouched.
 */
async function handleInboundMessage(event: BridgeEvent): Promise<void> {
  const { network, ownerUserId, externalChatId } = event;
  const senderExternalId = event.externalSenderId;
  const externalMessageId = event.externalMessageId;
  if (!senderExternalId || !externalMessageId) {
    logger.warn("Inbound bridge message missing sender/message id; skipping");
    return;
  }

  // 0. Require an ACTIVE link for (owner, network). Without it, a spoofed or
  // leftover event could materialize contacts/conversations/messages for an
  // account the owner never actually linked (or has since unlinked). The
  // connector should only emit `message` for live sessions; this is the
  // server-side enforcement of that contract. `session_status` stays UNGATED —
  // it is how an account BECOMES active in the first place.
  const link = await LinkedAccount.findOne({ userId: ownerUserId, network, status: "active" });
  if (!link) {
    logger.warn("Inbound bridge message with no active linked account; skipping");
    return;
  }

  // 1. Upsert the external contact.
  await ExternalContact.findOneAndUpdate(
    { ownerUserId, network, externalId: senderExternalId },
    {
      $set: {
        displayName: event.senderDisplayName,
        username: event.senderUsername,
        avatarUrl: event.senderAvatarUrl,
      },
    },
    { upsert: true, new: true }
  );

  // 2. Find or create the bridged conversation.
  const conversation = await findOrCreateBridgedConversation({
    network,
    ownerUserId,
    externalChatId,
    contact: {
      externalId: senderExternalId,
      displayName: event.senderDisplayName,
      username: event.senderUsername,
      avatar: event.senderAvatarUrl,
    },
  });
  const conversationId = String(conversation._id);

  // 3. Dedup: idempotent replay of the same external message is a no-op.
  const duplicate = await Message.findOne({
    conversationId,
    "external.externalMessageId": externalMessageId,
  });
  if (duplicate) return;

  const media = toMediaItems(event.media);
  const senderId = externalSenderId(network, senderExternalId);

  // 4. Persist the plaintext Message (legacy path the frontend already renders).
  let message: IMessage;
  try {
    message = await Message.create({
      conversationId,
      senderId,
      senderDeviceId: 0, // bridge origin
      text: event.text,
      media,
      external: {
        network,
        externalSenderId: senderExternalId,
        externalMessageId,
        externalTimestamp: event.timestamp ? new Date(event.timestamp) : undefined,
      },
      deliveredTo: [ownerUserId],
      messageType: media && media.length > 0 ? "media" : "text",
      encryptionVersion: 1,
    });
  } catch (err) {
    // A concurrent insert of the same external message id is benign (the unique
    // index did its job) — treat as a successful idempotent replay.
    if (isDuplicateKeyError(err)) return;
    throw err;
  }

  // 5. Bump conversation state; increment unread ONLY for the owner.
  conversation.lastMessageAt = new Date();
  conversation.lastMessage = {
    text: event.text ?? (media ? `Sent ${media.length} media file(s)` : ""),
    senderId,
    timestamp: new Date(),
  };
  const unreadCounts = conversation.unreadCounts as Map<string, number>;
  unreadCounts.set(ownerUserId, (unreadCounts.get(ownerUserId) ?? 0) + 1);
  await conversation.save();

  // 6. Fan out `newMessage` to the conversation room AND the owner's user room
  // (mirrors routes/messages.ts; external people have no user room).
  const ns = getMessagingNamespace();
  if (ns) {
    const payload = message.toObject();
    ns.to(`conversation:${conversationId}`).emit("newMessage", payload);
    ns.to(`user:${ownerUserId}`).emit("newMessage", payload);
  }
}

/** Locate the Message a `message`-scoped event refers to, via the dedup index. */
async function findBridgedMessage(
  event: BridgeEvent
): Promise<{ conversationId: string; message: IMessage } | null> {
  const conversation = await Conversation.findOne({
    "bridge.network": event.network,
    "bridge.ownerUserId": event.ownerUserId,
    "bridge.externalChatId": event.externalChatId,
  });
  if (!conversation) return null;
  const conversationId = String(conversation._id);
  const message = await Message.findOne({
    conversationId,
    "external.externalMessageId": event.externalMessageId,
  });
  if (!message) return null;
  return { conversationId, message };
}

/** Handle an inbound `edit` event: update text/media and mark edited. */
async function handleInboundEdit(event: BridgeEvent): Promise<void> {
  const found = await findBridgedMessage(event);
  if (!found) {
    logger.warn("Inbound bridge edit for unknown message; skipping");
    return;
  }
  const { conversationId, message } = found;
  if (event.text !== undefined) message.text = event.text;
  const media = toMediaItems(event.media);
  if (media) message.media = media;
  message.editedAt = new Date();
  await message.save();
  emitToConversation(conversationId, "messageUpdated", message.toObject());
}

/** Handle an inbound `delete` event: soft-delete (tombstone) like delete-for-everyone. */
async function handleInboundDelete(event: BridgeEvent): Promise<void> {
  const found = await findBridgedMessage(event);
  if (!found) {
    logger.warn("Inbound bridge delete for unknown message; skipping");
    return;
  }
  const { conversationId, message } = found;
  message.deletedAt = new Date();
  message.text = undefined;
  message.media = undefined;
  message.ciphertext = undefined;
  message.encryptedMedia = undefined;
  message.envelopeCount = 0;
  await message.save();
  emitToConversation(conversationId, "messageDeleted", { id: message._id, scope: "everyone" });
}

/**
 * Handle a `send_result` event: correlate the Allo message we sent, record the
 * delivery outcome, update the outbox, and notify the conversation.
 *
 * Ownership is enforced WITHOUT a racy check-then-save:
 *  1. Resolve the message's conversation and verify its bridge (owner + network)
 *     matches the event — this authorizes the connector against the conversation.
 *  2. Apply the delivery result as a SINGLE atomic `findOneAndUpdate` whose FILTER
 *     re-asserts the message-level invariant (`external.network === event.network`).
 *     If a concurrent change has since broken that invariant, the update matches
 *     nothing and returns null, so we skip the outbox update and emit too.
 *
 * Dotted `$set` paths update fields in place, preserving the rest of the
 * `external` subdoc (set by `dispatchSend`). The emit uses the document RETURNED
 * by the update (`new: true`) so the payload reflects the persisted state.
 */
async function handleSendResult(event: BridgeEvent): Promise<void> {
  const messageId = event.messageId ?? event.clientMessageId;
  if (!messageId) {
    logger.warn("send_result without a correlatable message id; skipping");
    return;
  }

  // Step 1: resolve the target message's conversation so we can authorize the
  // connector against the conversation's bridge (owner + network). A connector
  // for network A (or a different owner) must not be able to flip the delivery
  // status of an unrelated message by guessing/replaying its id.
  const target = await Message.findById(messageId).select("conversationId external");
  if (!target) {
    logger.warn("send_result for unknown message; skipping");
    return;
  }
  if (target.external?.network !== event.network) {
    logger.warn("send_result network does not match the target message; skipping");
    return;
  }
  const conversation = await Conversation.findById(target.conversationId);
  if (
    conversation?.bridge?.ownerUserId !== event.ownerUserId ||
    conversation?.bridge?.network !== event.network
  ) {
    logger.warn("send_result owner/network does not match the message's conversation; skipping");
    return;
  }

  const status = event.status === "sent" ? "sent" : "failed";

  // Step 2: atomic mutation. The filter re-asserts the message-level ownership
  // invariant (`external.network`), so a concurrent change can't slip a write
  // through. Dotted paths preserve the rest of the `external` subdoc; `new: true`
  // returns the persisted document for the emit.
  const updated = await Message.findOneAndUpdate(
    { _id: messageId, "external.network": event.network },
    {
      $set: {
        "external.network": event.network,
        "external.bridgeStatus": status,
        ...(event.externalMessageId ? { "external.externalMessageId": event.externalMessageId } : {}),
      },
    },
    { new: true }
  );
  if (!updated) {
    // The invariant failed under a race between step 1 and step 2 — skip cleanly.
    logger.warn("send_result lost the ownership race; skipping update");
    return;
  }

  await BridgeOutbox.findOneAndUpdate(
    { messageId: String(updated._id) },
    { $set: { status } }
  );

  emitToConversation(String(updated.conversationId), "messageUpdated", updated.toObject());
}

/**
 * Handle a `session_status` event: update the LinkedAccount status, and when the
 * event carries the user's external identity (`externalSelf`, populated once the
 * session is active) persist it too.
 *
 * The `$set` is built conditionally: when `event.externalSelf` is ABSENT we only
 * set `status`, so a later lifecycle event (e.g. `expired`) does NOT clobber the
 * `externalSelf` captured by an earlier `active` event. The event's
 * `BridgeExternalSelf` has no `avatarUrl`, so that schema field is left untouched.
 */
async function handleSessionStatus(event: BridgeEvent): Promise<void> {
  const update: { status: LinkedAccountStatus; externalSelf?: ILinkedAccount["externalSelf"] } = {
    status: mapSessionStatus(event.sessionStatus),
  };
  if (event.externalSelf) {
    update.externalSelf = {
      externalId: event.externalSelf.externalId,
      username: event.externalSelf.username,
      displayName: event.externalSelf.displayName,
      phoneHint: event.externalSelf.phoneHint,
    };
  }
  await LinkedAccount.findOneAndUpdate(
    { userId: event.ownerUserId, network: event.network },
    { $set: update }
  );
}

/**
 * Dispatch a BridgeEvent to its handler. Each branch is independently guarded so
 * a processing failure is logged and swallowed (the internal route returns 200).
 */
export async function handleEvent(event: BridgeEvent): Promise<void> {
  try {
    switch (event.type) {
      case "message":
        await handleInboundMessage(event);
        return;
      case "edit":
        await handleInboundEdit(event);
        return;
      case "delete":
        await handleInboundDelete(event);
        return;
      case "send_result":
        await handleSendResult(event);
        return;
      case "session_status":
        await handleSessionStatus(event);
        return;
      default:
        logger.warn(`Unhandled bridge event type: ${String(event.type)}`);
    }
  } catch (error) {
    logger.error(`Failed to handle bridge event '${event.type}'`, error);
  }
}
