import type { MessageReadStatus } from '@/stores/messagesStore';

/**
 * Which mark a message's status draws.
 *
 * Separated from `MessageMetadata` because it is the one part of that component
 * that can be got wrong silently. Four statuses share three marks, so the mapping
 * is not obvious, and the mistake it exists to prevent has a name: drawing a
 * failed send as pending. The clock says "still on its way", and a failed send is
 * precisely the case where nothing is on its way any more — on iOS and Android
 * the queue has given up, and on the web there was never a queue.
 *
 * A lookup table rather than a `switch` with a `default`, for the same reason the
 * translation modules use one: a status nobody handled is a type error here,
 * where a `default` would quietly draw it as the clock.
 */
export type MessageStatusMark = 'clock' | 'tick' | 'double-tick' | 'error';

const MARKS: Record<MessageReadStatus, MessageStatusMark> = {
  pending: 'clock',
  sent: 'tick',
  // One tick each. They differ in what the sender knows — the homeserver has it,
  // versus their device has it — and Allo has never drawn them apart.
  delivered: 'tick',
  read: 'double-tick',
  failed: 'error',
};

export function statusMark(readStatus: MessageReadStatus): MessageStatusMark {
  return MARKS[readStatus];
}
