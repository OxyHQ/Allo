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

  it.each<AutoSignInPhase>(['idle', 'starting', 'authorizing', 'ready'])(
    'does not start from %s',
    (phase) => {
      expect(shouldAutoSignIn({ ...base, phase })).toBe(false);
    },
  );

  it('needs every condition, not any of them', () => {
    // Guards against the predicate degrading into an OR, which would start a
    // sign-in with nothing to inherit or start a second one.
    expect(shouldAutoSignIn({ phase: 'failed', hasOxySession: false, alreadyAttempted: true })).toBe(
      false,
    );
    expect(shouldAutoSignIn({ ...base, phase: 'ready', hasOxySession: false })).toBe(false);
  });
});
