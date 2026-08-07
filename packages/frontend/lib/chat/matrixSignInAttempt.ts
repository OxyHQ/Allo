import { Platform } from 'react-native';

import { logger } from '@/utils/logger';

/**
 * Whether this run of Allo has already started a Matrix sign-in on its own.
 *
 * `shouldAutoSignIn` has always allowed one attempt per run and no more, because
 * a sign-in that re-triggers itself is a loop that takes the browser with it.
 * What changed is what "a run" is on web: the authorization is now a top-level
 * redirect, so the page that started it is destroyed and the page that comes back
 * is a fresh one with fresh memory. A flag held in a variable would be false
 * again on the way back in, and an authorization server that answered without a
 * code — a user pressing Back, a redirect that bounced — would be met with
 * another automatic redirect, and another, forever.
 *
 * So on web the marker outlives the page, in `sessionStorage`: it survives the
 * trip to the authorization server, it is scoped to the one tab making the trip,
 * and it dies with that tab. A new tab is a new run and may try again.
 *
 * A successful login does not clear it, and neither does a sign-out. That is
 * deliberate on both platforms: clearing it after a login would let the automatic
 * sign-in fire again the moment somebody deliberately signed out, which is the
 * second thing this decision exists to prevent. The button on the sign-in screen
 * does not consult it: a person asking to sign in is not an automatic retry.
 */

export interface MatrixSignInAttempt {
  /** Whether an automatic sign-in has already been started in this run. */
  started(): boolean;
  /** Records that one has been. Called before the sign-in, never after. */
  record(): void;
  /**
   * Forgets the attempt, so the next render may start a fresh one.
   *
   * There is exactly one caller and it is not "the login finished": it is
   * `matrixRuntime.ts` refusing a stored session because the store on disk is
   * not that session's, which is what an account switch looks like from
   * underneath. The attempt being forgotten there is not the retry the paragraph
   * above refuses — the run that recorded it was signing somebody else in, and
   * the app has just thrown away everything of theirs. Leaving the marker set
   * would show whoever is here now a button offering to do the thing the app
   * could have done by itself.
   *
   * It is NOT called for an ordinary sign-out, where there is a session to
   * discard but no foreign store: that case is the one the marker is for.
   */
  forget(): void;
}

/** The one key. Namespaced so it cannot collide with anything else on the origin. */
export const SIGN_IN_ATTEMPT_KEY = 'allo.matrix.signin.attempted';

/**
 * A phone or a tablet, where a run is the process.
 *
 * Nothing on native destroys the app to sign in — the authorization happens in an
 * in-app browser tab that hands control back — so the process is exactly the
 * right lifetime, and module scope is the whole implementation.
 */
export function createProcessAttempt(): MatrixSignInAttempt {
  let attempted = false;
  return {
    started: () => attempted,
    record: () => {
      attempted = true;
    },
    forget: () => {
      attempted = false;
    },
  };
}

/**
 * A browser tab, where a run spans the trip to the authorization server.
 *
 * The in-memory mirror is not an optimisation: a browser that refuses
 * `sessionStorage` — a sandboxed frame, a few embedded webviews — must still not
 * be sent round the loop twice within one page. It cannot be sent round it at all
 * in that case, because the port refuses to start a redirect it cannot write the
 * login context for (`lib/matrix/web/oidcContext.ts`), and that failure ends at
 * the explanation rather than at another attempt.
 */
export function createTabAttempt(): MatrixSignInAttempt {
  const process = createProcessAttempt();
  return {
    started: () => {
      if (process.started()) {
        return true;
      }
      const storage: Storage | undefined = globalThis.sessionStorage;
      if (storage === undefined) {
        return false;
      }
      return storage.getItem(SIGN_IN_ATTEMPT_KEY) !== null;
    },
    record: () => {
      process.record();
      const storage: Storage | undefined = globalThis.sessionStorage;
      if (storage === undefined) {
        logger.warn(
          '[chat] this browser exposes no sessionStorage, so a sign-in that leaves the ' +
            'page cannot be remembered across it',
        );
        return;
      }
      storage.setItem(SIGN_IN_ATTEMPT_KEY, 'true');
    },
    forget: () => {
      process.forget();
      // Both halves, and the in-memory one first: a browser with no
      // `sessionStorage` still has the mirror set, and forgetting only the half
      // that can be written would leave the tab refusing to try again for a
      // reason nothing on screen could explain.
      globalThis.sessionStorage?.removeItem(SIGN_IN_ATTEMPT_KEY);
    },
  };
}

/**
 * The marker a platform needs.
 *
 * A function taking the platform rather than a branch on `Platform.OS` at module
 * scope, because the branch is the interesting part and the test run only ever
 * has one platform: a decision made inline here would be checked on iOS and
 * assumed on web, which is the half that had to change.
 */
export function selectSignInAttempt(platform: string): MatrixSignInAttempt {
  return platform === 'web' ? createTabAttempt() : createProcessAttempt();
}

/** The marker for the platform this build runs on. */
export const matrixSignInAttempt: MatrixSignInAttempt = selectSignInAttempt(Platform.OS);
