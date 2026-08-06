/**
 * THE LIST OF WORDS A READER DOES NOT WANT TO SEE.
 *
 * Stored as a plain string array on the privacy document. The rules below are
 * the ones a list of words needs in order to behave the way the person editing
 * it expects, and they are here rather than in the screen because "did adding
 * `Spoilers` twice make two rows" is a question with a right answer that no
 * amount of rendering can be asked.
 *
 *   - Space around a word is typing, not part of it.
 *   - Case is not part of it either: somebody who hid `spoilers` did not mean to
 *     leave `Spoilers` showing. Comparison is case-insensitive; the WORD IS KEPT
 *     AS TYPED, because it is drawn back to the person who typed it.
 *   - An empty entry is not a word, and one that matched everything would hide
 *     the whole app.
 *   - Order is the order they were added, oldest first, so the list does not
 *     rearrange itself under the reader's finger.
 *
 * Comparison uses `toLocaleLowerCase()` with no locale argument, i.e. the
 * device's. That is deliberate for a per-device list of the reader's own words:
 * a Turkish reader who hides `İstanbul` should not find `istanbul` treated as a
 * different word by an English casing table.
 */

/**
 * How long a hidden word may be.
 *
 * Not a storage limit — the field is unbounded — but a UI one: the list draws
 * each entry on one row, and a pasted paragraph is not a word anybody meant to
 * add.
 */
export const HIDDEN_WORD_MAX_LENGTH = 64;

/** What went wrong when a word could not be added. */
export type HiddenWordRejection = 'empty' | 'too-long' | 'duplicate';

export type AddHiddenWordResult =
  | { readonly ok: true; readonly words: readonly string[] }
  | { readonly ok: false; readonly reason: HiddenWordRejection };

function fold(word: string): string {
  return word.trim().toLocaleLowerCase();
}

/**
 * The list with `candidate` added, or why it was refused.
 *
 * Returns a NEW list rather than mutating, so a caller can hand the result
 * straight to a mutation and keep the old one for a rollback.
 */
export function addHiddenWord(
  words: readonly string[],
  candidate: string,
): AddHiddenWordResult {
  const word = candidate.trim();
  if (word.length === 0) return { ok: false, reason: 'empty' };
  if (word.length > HIDDEN_WORD_MAX_LENGTH) return { ok: false, reason: 'too-long' };

  const folded = fold(word);
  if (words.some((existing) => fold(existing) === folded)) {
    return { ok: false, reason: 'duplicate' };
  }

  return { ok: true, words: [...words, word] };
}

/**
 * The list with `target` removed.
 *
 * Matched case-insensitively for the same reason adding is: the row the reader
 * tapped is the row that goes, whatever case the stored copy happens to be in.
 * Every match is removed, so a list that already contained a duplicate pair —
 * written by an older build, or by another client — can still be emptied.
 */
export function removeHiddenWord(
  words: readonly string[],
  target: string,
): readonly string[] {
  const folded = fold(target);
  return words.filter((existing) => fold(existing) !== folded);
}
