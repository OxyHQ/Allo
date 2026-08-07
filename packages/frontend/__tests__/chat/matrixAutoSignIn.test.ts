import { shouldAutoSignIn, type AutoSignInPhase } from '@/lib/chat/matrixAutoSignIn';

/**
 * The rule that decides whether a person who is already signed in gets asked to
 * sign in again. Every false here is a case where starting on its own would be
 * worse than a button, and the two that matter are a loop and a silent retry
 * over an error the person needs to read.
 */

const base = { phase: 'signed-out' as AutoSignInPhase, hasOxySession: true, alreadyAttempted: false };

describe('shouldAutoSignIn', () => {
  it('starts when there is an Oxy session and chat is signed out', () => {
    expect(shouldAutoSignIn(base)).toBe(true);
  });

  it('does not start without an Oxy session to inherit', () => {
    // The browser would land on a sign-in form — the second login this avoids.
    expect(shouldAutoSignIn({ ...base, hasOxySession: false })).toBe(false);
  });

  it('starts once and not again', () => {
    expect(shouldAutoSignIn({ ...base, alreadyAttempted: true })).toBe(false);
  });

  it('leaves a failure alone so the screen can explain it', () => {
    // An automatic retry replaces the reason with a spinner, and if the cause
    // persists it becomes a loop that takes the browser with it.
    expect(shouldAutoSignIn({ ...base, phase: 'failed' })).toBe(false);
  });

  it.each<AutoSignInPhase>([
    'idle',
    'starting',
    'blocked',
    'blocked-timed-out',
    'authorizing',
    'leaving',
    'finishing',
    'ready',
  ])('does not start from %s', (phase) => {
    expect(shouldAutoSignIn({ ...base, phase })).toBe(false);
  });

  it('does not send a browser away from a screen that is asking for something', () => {
    // Both halves of a launch held up by another window of Allo. `blocked` is
    // waiting for that window to close and `blocked-timed-out` has stopped
    // waiting and is asking the reader to close it — and in neither case is
    // there a client for a sign-in to go through, because the store was never
    // opened. An authorization started over either would put a browser hop on
    // top of the request and come back to the same screen.
    expect(shouldAutoSignIn({ ...base, phase: 'blocked' })).toBe(false);
    expect(shouldAutoSignIn({ ...base, phase: 'blocked-timed-out' })).toBe(false);
  });

  it('does not start one while the browser is being sent away', () => {
    // `leaving` is web's: the page has asked the browser to navigate and is about
    // to be replaced. Starting a second authorization in the moments before that
    // happens would replace the URL the first one is going to.
    expect(shouldAutoSignIn({ ...base, phase: 'leaving' })).toBe(false);
  });

  it('does not start one over the login that is being finished', () => {
    // `finishing` is the other end of the same redirect: the browser is back,
    // holding a code that is being exchanged. A second authorization here would
    // race the first and one of them would lose.
    expect(shouldAutoSignIn({ ...base, phase: 'finishing' })).toBe(false);
  });

  it('needs every condition, not any of them', () => {
    // Guards against the predicate degrading into an OR, which would start a
    // sign-in with nothing to inherit or start a second one.
    expect(shouldAutoSignIn({ phase: 'failed', hasOxySession: false, alreadyAttempted: true })).toBe(
      false,
    );
    expect(shouldAutoSignIn({ ...base, phase: 'ready', hasOxySession: false })).toBe(false);
  });
});
