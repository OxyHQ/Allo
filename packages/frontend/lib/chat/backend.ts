/**
 * Which system the chat screens get their data from.
 *
 * Allo is being moved off its own Express/Socket.IO/Signal stack and onto Matrix
 * (`docs/matrix/data-model.md`). The two live side by side for as long as the move
 * takes, and this flag is the single place that decides which one a build talks
 * to. Nothing else in the app is allowed to sniff the environment for it.
 *
 * The rule that makes the migration reversible: **with the flag unset, the app
 * behaves exactly as it did before Matrix existed.** Every switch on this value
 * has the legacy path as its untouched branch, and the Matrix modules are reached
 * through a dynamic import so that a build with the flag off never loads a Matrix
 * SDK at all — not to save bytes, but so that a crash inside one cannot happen in
 * a configuration that is supposed to be the old app.
 */

export type ChatBackend =
  /** The Express API, Socket.IO and the Signal Protocol implementation. */
  | 'allo-api'
  /** The Matrix homeserver, through the port in `lib/matrix`. */
  | 'matrix';

/** The environment variable that selects the backend. */
export const CHAT_BACKEND_VARIABLE = 'EXPO_PUBLIC_CHAT_BACKEND';

const CHAT_BACKENDS: readonly ChatBackend[] = ['allo-api', 'matrix'];

/**
 * Reads the flag, refusing anything that is neither backend.
 *
 * Unset means `allo-api`, because a build that says nothing wants the app it had.
 * A *misspelt* value is the case worth being loud about: someone who writes
 * `EXPO_PUBLIC_CHAT_BACKEND=Matrix` and gets the legacy backend has no way to see
 * that from inside the app — every screen works, and it is the wrong app. Failing
 * at import turns that into a message at the moment the mistake is made.
 */
export function parseChatBackend(raw: string | undefined): ChatBackend {
  if (raw === undefined || raw === '') {
    return 'allo-api';
  }
  const backend = CHAT_BACKENDS.find((candidate) => candidate === raw);
  if (backend === undefined) {
    throw new Error(
      `${CHAT_BACKEND_VARIABLE} is "${raw}", which is not a chat backend. ` +
        `Use one of ${CHAT_BACKENDS.join(', ')}, or leave it unset for ` +
        'allo-api.',
    );
  }
  return backend;
}

/**
 * The backend this build talks to.
 *
 * A constant and not a function: Expo's bundler substitutes the literal for
 * `process.env.EXPO_PUBLIC_*` at build time, so the value cannot change while the
 * app is running and pretending otherwise would invite code that re-reads it and
 * gets a different answer halfway through a screen.
 */
export const CHAT_BACKEND: ChatBackend = parseChatBackend(
  process.env.EXPO_PUBLIC_CHAT_BACKEND,
);
