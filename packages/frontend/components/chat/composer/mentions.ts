/**
 * The `@fragment` a draft is naming somebody with, and how to replace it.
 *
 * Pure, and deliberately conservative about what a handle may contain: the
 * fragment ends at the first space, so `@ana res` is a mention of `ana`
 * followed by prose rather than a two-word handle that Oxy has no concept of.
 * A second `@` starts a new fragment, which is what makes `@@` (and a typo the
 * person is backing out of) stop matching the one before it.
 *
 * No unicode property escapes: Hermes is not guaranteed to have them, and
 * "anything that is not a space or an `@`" is the same rule for Oxy's handles
 * without betting on the engine.
 */

/** Where the fragment sits in the draft, and what has been typed after the `@`. */
export interface MentionFragment {
  /** Index of the `@` itself. */
  readonly start: number;
  /** One past the last character typed — the caret. */
  readonly end: number;
  /** What follows the `@`, without it. Empty right after typing `@`. */
  readonly query: string;
}

/** `@` at the start of the draft or after a space, then the fragment, then the caret. */
const FRAGMENT = /(?:^|\s)@([^\s@]*)$/;

/**
 * The fragment the caret is inside, or `null`.
 *
 * `caret` is where the insertion point is. On a platform that cannot report one
 * the end of the draft is the honest answer — that is where somebody typing is.
 */
export function mentionFragment(text: string, caret: number): MentionFragment | null {
  const at = Math.max(0, Math.min(caret, text.length));
  const match = FRAGMENT.exec(text.slice(0, at));
  if (!match) return null;
  const query = match[1];
  return { start: at - query.length - 1, end: at, query };
}

/** The draft with the fragment replaced by `@name `, and where the caret lands. */
export function applyMention(
  text: string,
  fragment: MentionFragment,
  name: string,
): { readonly value: string; readonly caret: number } {
  const insert = `@${name} `;
  return {
    value: text.slice(0, fragment.start) + insert + text.slice(fragment.end),
    caret: fragment.start + insert.length,
  };
}
