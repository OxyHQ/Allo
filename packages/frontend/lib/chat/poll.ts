/**
 * WHAT MAKES A SENDABLE POLL, decided away from the sheet that collects it.
 *
 * The SDK takes two to twelve options and will not be talked out of it, so the
 * composer has to refuse before it sends rather than after. Keeping the rule
 * here means the button's disabled state and the draft that is actually sent
 * are computed by the same function — a sheet that enables "Send" on one rule
 * and builds the draft on another is how an empty option reaches a
 * conversation.
 */
import type { PollDraft } from '@allo/core';

/** The SDK's floor. One option is not a question, it is a statement. */
export const POLL_MIN_OPTIONS = 2;
/** The SDK's ceiling. */
export const POLL_MAX_OPTIONS = 12;
/** What the sheet starts with: the smallest poll there is, ready to type into. */
export const POLL_INITIAL_OPTIONS: readonly string[] = ['', ''];

/** How long a question may be, and an option. Both are drawn in a bubble, not in a document. */
export const POLL_QUESTION_MAX_LENGTH = 300;
export const POLL_OPTION_MAX_LENGTH = 100;

export interface PollForm {
  question: string;
  options: readonly string[];
  multiple: boolean;
  anonymous: boolean;
}

/**
 * The draft a form would send, or `undefined` when it would not send at all.
 *
 * Blank options are DROPPED rather than rejected: the sheet always shows at
 * least two fields and adding a third that is then left empty is a normal way
 * to write a two-option poll, not a mistake to report. What is rejected is a
 * poll with no question, or one that has fewer than two options once the blanks
 * are gone.
 *
 * `multiple` and `anonymous` are only sent when they are ON. They default to
 * false in the SDK, and a draft that states every default is a draft whose
 * defaults cannot change.
 */
export function pollDraft(form: PollForm): PollDraft | undefined {
  const question = form.question.trim();
  if (question.length === 0) return undefined;
  const options = form.options.map((option) => option.trim()).filter((option) => option.length > 0);
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) return undefined;
  return {
    question,
    options,
    ...(form.multiple ? { multiple: true } : {}),
    ...(form.anonymous ? { anonymous: true } : {}),
  };
}

/** Whether "Send" is pressable. The same rule, so the button never promises a send that is refused. */
export function canSendPoll(form: PollForm): boolean {
  return pollDraft(form) !== undefined;
}
