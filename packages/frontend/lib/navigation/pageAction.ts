/**
 * The floating action each page of the pager offers, decided in one place.
 *
 * Bloom's `AppShell` draws ONE primary action (the bar's FAB on a phone),
 * and a destination has no action of its own in Bloom's model, so the shell is
 * handed the action of the page in front:
 *
 * - Chats (and anything pushed over the pages): a new conversation.
 * - Status: add to your status, the same post the "My status" ring makes
 *   (`hooks/usePostStatus.ts`).
 * - Calls: pick somebody to call (`/new?call=voice`). The picker only
 *   NAVIGATES to `/c/:id/call`, which stays the app's one dialler.
 *
 * The rail's compose row is not a floating action and stays "new chat".
 */
export type PageAction = 'new-chat' | 'add-status' | 'new-call';

export function pageActionFor(activePage: string | null): PageAction {
  if (activePage === 'updates') return 'add-status';
  if (activePage === 'calls') return 'new-call';
  return 'new-chat';
}
