/**
 * The message wire shape, composed in ONE place — including for socket
 * emissions.
 *
 * That last part is the reason this is a module and not an inline spread.
 * `routes/messages.ts` emits the same message twice: once as an HTTP response
 * and once over Socket.IO, to the conversation room and to every participant's
 * user room. Under Mongoose the socket path used `message.toObject()` while the
 * HTTP path returned the document, so the two shapes agreed by accident. Two
 * spellings of one payload can disagree, and a client that receives a message
 * over the socket and the same message over HTTP would then see two different
 * objects for one row.
 */

import type { MessageDto } from "@allo/shared-types";
import type { MessageRecord } from "../db/messaging/messageRepository";

/**
 * One message, as the API returns it and as the socket emits it.
 *
 * Absent optional fields are OMITTED rather than emitted as `null`, matching
 * what the Mongo `.lean()` documents did — clients test them for truthiness.
 * The three keyed collections are always present, even when empty: `readBy`
 * and `reactions` as `{}` and `deliveredTo` as `[]`, which is what the Maps and
 * the array serialized to. `stores/messagesStore.ts` reads `msg.readBy ?? {}`
 * either way, but a receipt count that silently changes shape when it reaches
 * zero is not a thing to make a client handle.
 */
export function toMessageDto(message: MessageRecord): MessageDto {
  return {
    id: message.id,
    // Derived from `id`, so the two spellings cannot disagree. See the note on
    // MessageDto for the shipped reader that still needs it.
    _id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    senderDeviceId: message.senderDeviceId,
    ...(message.ciphertext !== null ? { ciphertext: message.ciphertext } : {}),
    encryptedMedia: [...message.encryptedMedia],
    ...(message.text !== null ? { text: message.text } : {}),
    media: [...message.media],
    encryptionVersion: message.encryptionVersion,
    messageType: message.messageType,
    ...(message.replyTo !== null ? { replyTo: message.replyTo } : {}),
    ...(message.fontSize !== null ? { fontSize: message.fontSize } : {}),
    ...(message.editedAt !== null ? { editedAt: message.editedAt } : {}),
    ...(message.deletedAt !== null ? { deletedAt: message.deletedAt } : {}),
    readBy: { ...message.readBy },
    deliveredTo: [...message.deliveredTo],
    reactions: Object.fromEntries(
      Object.entries(message.reactions).map(([emoji, userIds]) => [emoji, [...userIds]]),
    ),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}
