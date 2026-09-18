import type { MessageReadStatus } from '@/lib/chat/model';

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
  // The server has it: one tick.
  sent: 'tick',
  // Their device has it — a delivered receipt came back from a recipient
  // instance: two ticks, in the quiet colour.
  delivered: 'double-tick',
  // They read it: the same two ticks, in the accent colour. Mark and tone
  // together are what tell delivered and read apart.
  read: 'double-tick',
  failed: 'error',
};

export function statusMark(readStatus: MessageReadStatus): MessageStatusMark {
  return MARKS[readStatus];
}

/**
 * Which colour the mark is drawn in.
 *
 * `quiet` is the timestamp's colour; `accent` is the one that says "read" and
 * is the only thing that distinguishes read from delivered, since both draw
 * two ticks; `error` is the one colour that keeps its own even inside a bubble,
 * because a mark the user is meant to act on cannot be quiet.
 */
export type MessageStatusTone = 'quiet' | 'accent' | 'error';

const TONES: Record<MessageReadStatus, MessageStatusTone> = {
  pending: 'quiet',
  sent: 'quiet',
  delivered: 'quiet',
  read: 'accent',
  failed: 'error',
};

export function statusTone(readStatus: MessageReadStatus): MessageStatusTone {
  return TONES[readStatus];
}
