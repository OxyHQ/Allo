/**
 * Turning read receipts into the answer a message bubble needs.
 *
 * A Matrix read receipt names one event and means *everything up to and
 * including it*. Both SDKs report receipts the way the protocol carries them —
 * attached to the event they name — and in a conversation anybody has actually
 * read, that is the newest event and nothing else. Asking either SDK "who has
 * read this message?" about a message four rows back therefore answers "nobody",
 * for every message except the last one.
 *
 * Reading the timeline backwards is what turns the one into the other, and it is
 * a single pass: a receipt met at row *i* counts for every row before *i*, so
 * carrying the readers seen so far from the newest row to the oldest answers
 * every row at once and does it in one traversal rather than one per row.
 *
 * Shared by both implementations on purpose. It is the only piece of the two
 * timelines that is the same computation on the same shape of data, and having
 * one copy is what stops iOS and the web from disagreeing about whether a message
 * has been read.
 */

/** What the scan needs of a row, in timeline order (oldest first). */
export interface AlloReadRow {
  /** Matrix user id of whoever sent the event. */
  readonly sender: string;
  /** Matrix user ids whose read receipt names this exact event. */
  readonly readers: readonly string[];
}

/**
 * For each row, whether somebody other than its sender has read it.
 *
 * The result is positional: index *i* answers for `rows[i]`.
 *
 * Excluding the sender is not a detail. A client sends a read receipt for the
 * message it has just sent — it has, after all, read it — so counting it would
 * mark every outgoing message as read the moment it arrived back down sync, and
 * the read mark would carry no information at all.
 */
export function markReadByOthers(rows: readonly AlloReadRow[]): readonly boolean[] {
  const flags = new Array<boolean>(rows.length);
  // Everyone whose receipt sits on this row or on a later one. It only ever
  // grows as the scan moves towards the start of the conversation, which is
  // exactly the "up to and including" the protocol means.
  const readers = new Set<string>();

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    for (const reader of row.readers) {
      readers.add(reader);
    }
    // `readers` minus this row's sender is non-empty. Counted rather than
    // filtered: building a second set per row would allocate one for every
    // message in the window on every batch.
    flags[index] = readers.size > (readers.has(row.sender) ? 1 : 0);
  }

  return flags;
}
