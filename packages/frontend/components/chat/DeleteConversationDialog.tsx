/**
 * "Delete conversation", with Telegram's checkbox and without its promise.
 *
 * Telegram can offer "also delete for X" because the message sits on its
 * server and it can take it away. Allo's does not: the other copy is on the
 * other person's device, decrypted with keys only they hold. What the checkbox
 * sends is a `clear_history` control message their app obeys — which is the
 * whole truth, so the dialog says it in the description rather than implying
 * something it cannot do.
 *
 * Offered for a DM only. In a group it would mean asking a room full of people
 * to delete their copy on one person's say-so, which is a different feature
 * with a different argument behind it.
 *
 * Bloom draws all of it: a confirm with a checkbox under its description is
 * Bloom's `confirmWithSuppression`, whose checkbox says whatever its label
 * says. A dismissal is a refusal, like every other surface.
 */
import { confirmWithSuppression } from '@oxy.so/bloom/surfaces';

export interface DeleteConversationAnswer {
  confirmed: boolean;
  forEveryone: boolean;
}

interface DeleteConversationQuestion {
  title: string;
  description: string;
  /** The checkbox label, already naming the person. */
  alsoForThemLabel: string;
  confirmLabel: string;
  cancelLabel: string;
}

/** Asks, and resolves what the person chose. */
export async function askDeleteConversation({
  alsoForThemLabel,
  ...question
}: DeleteConversationQuestion): Promise<DeleteConversationAnswer> {
  const { confirmed, suppressed } = await confirmWithSuppression({
    ...question,
    destructive: true,
    suppressionLabel: alsoForThemLabel,
  });
  return { confirmed, forEveryone: confirmed && suppressed };
}
