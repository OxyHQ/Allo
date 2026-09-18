/**
 * The paths the shell reasons about. Every path here is served by a file under
 * `app/`; `__tests__/routes/navigationTargets.test.ts` checks each one.
 */
export const ROUTES = {
  HOME: '/',
  NEW_CHAT: '/new',
  SETTINGS: '/settings',
} as const;

const CONVERSATION = /^\/c\/([^/]+)(\/info)?$/;

/** The conversation a path shows, or `null` when it shows none. */
export function conversationIdFromPath(pathname: string | null | undefined): string | null {
  return pathname?.match(CONVERSATION)?.[1] ?? null;
}

/** Whether a path is inside settings, where the list pane holds the settings menu. */
export function isSettingsPath(pathname: string | null | undefined): boolean {
  return pathname === ROUTES.SETTINGS || Boolean(pathname?.startsWith(`${ROUTES.SETTINGS}/`));
}
