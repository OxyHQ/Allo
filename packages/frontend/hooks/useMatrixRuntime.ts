import { useSyncExternalStore } from 'react';

import { CHAT_BACKEND } from '@/lib/chat/backend';
import { IDLE_RUNTIME_STATE, matrixRuntime, type MatrixRuntimeState } from '@/lib/chat/matrixRuntime';
import type { AlloUnsubscribe } from '@/lib/matrix/types';

/**
 * The state of the app's Matrix client.
 *
 * `useSyncExternalStore` and not an Effect: the runtime is an external store —
 * it exists before React and outlives every component — and this is the hook
 * React provides for exactly that. Subscribing is also what starts the runtime,
 * so no screen has to remember to kick it off.
 *
 * With the chat backend set to `allo-api` the hook subscribes to nothing and
 * answers `idle` forever, which is what keeps a build with the flag off from
 * building a Matrix client because a screen rendered.
 */

const NO_UNSUBSCRIBE: AlloUnsubscribe = () => {};
const subscribeToNothing = (): AlloUnsubscribe => NO_UNSUBSCRIBE;
const alwaysIdle = (): MatrixRuntimeState => IDLE_RUNTIME_STATE;

const enabled = CHAT_BACKEND === 'matrix';

export function useMatrixRuntime(): MatrixRuntimeState {
  return useSyncExternalStore(
    enabled ? matrixRuntime.subscribe : subscribeToNothing,
    enabled ? matrixRuntime.getState : alwaysIdle,
    // The web export is prerendered, and prerendering never subscribes. Reporting
    // the idle state there is right: there is no client in a build step.
    alwaysIdle,
  );
}

/** Starts a sign-in. Does nothing at all when the backend is `allo-api`. */
export function signInToMatrix(): void {
  if (!enabled) {
    return;
  }
  // The runtime reports its own failures through the state this module's hook
  // reads, so there is nothing for a caller to catch.
  void matrixRuntime.signIn();
}

/**
 * Ends the session: on the homeserver, and everywhere it was kept on this
 * device.
 *
 * Awaitable, unlike {@link signInToMatrix}, because a caller usually has
 * something to do afterwards — navigating away from screens that were drawing a
 * conversation the app no longer has. It does not reject: the runtime reports
 * what went wrong through the state this module's hook reads, the same way a
 * sign-in does.
 *
 * With the backend set to `allo-api` this resolves without doing anything, which
 * is what lets a screen call it unconditionally.
 */
export async function signOutOfMatrix(): Promise<void> {
  if (!enabled) {
    return;
  }
  await matrixRuntime.signOut();
}
