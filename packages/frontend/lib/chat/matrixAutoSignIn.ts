/**
 * Whether Allo should start the Matrix sign-in on its own.
 *
 * Signing in to Allo already signed the person in — to Oxy. The Matrix session
 * is a second thing only because the homeserver issues its own, through MAS with
 * Oxy upstream; from where the person is sitting there is one account and there
 * should be one sign-in. Presenting a second "Sign in" screen after they are
 * already signed in reads as the app having forgotten them.
 *
 * So when there is an Oxy session to inherit, the flow starts without being
 * asked. What it cannot be is a loop: a failure that re-triggers itself takes
 * the browser with it, and a person who deliberately signed out of chat should
 * not be dragged back in on the next render.
 *
 * ONE ATTEMPT PER RUN, and only from `signed-out`. `failed` is left alone so the
 * screen can say what went wrong and offer the button — an automatic retry there
 * would replace an explanation with a spinner.
 *
 * "Per run" is load-bearing on web, where the authorization is a top-level
 * redirect and the page that started it does not survive it. The caller supplies
 * `alreadyAttempted` from a marker that outlives the navigation
 * (`matrixSignInAttempt.ts`); a flag that reset when the page reloaded would turn
 * a callback with nothing usable in it into an endless round trip.
 *
 * Oxy refuses OIDC `prompt=none` on purpose (`packages/auth/src/pages/authorize.tsx`
 * in OxyHQServices): every gesture-less lane was removed, because a silent
 * redirect from the sign-in origin to an arbitrary target is what those lanes
 * were. So this cannot be invisible, and does not pretend to be. What it removes
 * is the extra screen and the extra decision, not the browser hop.
 */

/** The runtime phases this decision reads. Narrower than the runtime's own union. */
export type AutoSignInPhase =
  | 'idle'
  | 'starting'
  | 'blocked'
  | 'blocked-timed-out'
  | 'authorizing'
  | 'leaving'
  | 'finishing'
  | 'signed-out'
  | 'ready'
  | 'failed';

export interface AutoSignInInput {
  readonly phase: AutoSignInPhase;
  /** Whether an Oxy session exists for the Matrix login to inherit. */
  readonly hasOxySession: boolean;
  /** Whether this run has already started one. */
  readonly alreadyAttempted: boolean;
}

/**
 * True when the sign-in should be started without the person asking for it.
 *
 * Every false case is a deliberate one, so a caller reading this does not have
 * to guess which condition it tripped.
 */
export function shouldAutoSignIn({
  phase,
  hasOxySession,
  alreadyAttempted,
}: AutoSignInInput): boolean {
  // Nothing to inherit: the browser would land on a sign-in form, which is the
  // second login this exists to avoid.
  if (!hasOxySession) {
    return false;
  }
  // Once. A second attempt is either a retry of something that failed, which is
  // the button's job, or a loop.
  if (alreadyAttempted) {
    return false;
  }
  // `idle` and `starting` have not finished deciding; `blocked` is waiting on
  // another window of Allo to close and `blocked-timed-out` has stopped waiting,
  // and starting a sign-in in front of either would put a browser hop on top of
  // a screen that is asking the reader for something; `authorizing` is already
  // in the browser, `leaving` is on its way there and `finishing` is on its way
  // back; `ready` needs nothing; `failed` owes an explanation.
  return phase === 'signed-out';
}
