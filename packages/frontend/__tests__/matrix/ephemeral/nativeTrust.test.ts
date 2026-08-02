import { VerificationState } from '@unomed/react-native-matrix-sdk';

import { toIdentityTrust, toOwnDeviceTrust } from '@/lib/matrix/native/trust';

/**
 * Turning what the Rust binding says about an identity into what the port
 * promises about one.
 *
 * The order of the questions is the whole content of this file. An identity that
 * replaced a verified one is *the* case the check exists for, and the binding
 * will still call the replacement verified if it has been signed — so asking
 * "is it verified?" before "has it changed?" reports a substitution as fine.
 */

const KNOWN = { isVerified: () => false, hasVerificationViolation: () => false };

describe('toIdentityTrust', () => {
  it('reports somebody with no published identity as unknown', () => {
    expect(toIdentityTrust(undefined)).toBe('unknown');
  });

  it('reports an identity this device has seen and not verified as pinned', () => {
    // Trust on first use, and named as such. Calling it "verified" would be a
    // check nobody performed.
    expect(toIdentityTrust(KNOWN)).toBe('pinned');
  });

  it('reports a verified identity as verified', () => {
    expect(toIdentityTrust({ ...KNOWN, isVerified: () => true })).toBe('verified');
  });

  it('reports an identity in verification violation as changed', () => {
    expect(toIdentityTrust({ ...KNOWN, hasVerificationViolation: () => true })).toBe('changed');
  });

  it('reports a violation even when the new identity is itself verified', () => {
    // The mutation this test is here to catch: swapping these two questions
    // round turns the one case the rule exists for into a pass.
    expect(
      toIdentityTrust({ isVerified: () => true, hasVerificationViolation: () => true }),
    ).toBe('changed');
  });
});

describe('toOwnDeviceTrust', () => {
  it('maps every state the binding has', () => {
    expect(toOwnDeviceTrust(VerificationState.Verified)).toBe('verified');
    expect(toOwnDeviceTrust(VerificationState.Unverified)).toBe('unverified');
    expect(toOwnDeviceTrust(VerificationState.Unknown)).toBe('unknown');
  });

  it('does not collapse "not settled yet" into "not verified"', () => {
    // The crypto stack starts in the background. Treating that as unverified
    // refuses a send for a reason that stops being true a second later.
    expect(toOwnDeviceTrust(VerificationState.Unknown)).not.toBe('unverified');
  });
});
