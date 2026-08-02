import {
  toIdentityTrust,
  toOwnDeviceTrust,
  type WebVerificationStatus,
} from '@/lib/matrix/web/trust';

/**
 * The same translation in a browser, and the one place the two platforms
 * genuinely differ.
 *
 * `matrix-js-sdk` reports a **pin** violation as well as a verification
 * violation, through `needsUserApproval`; the native binding reports only the
 * second. So an identity that changed without ever having been verified is
 * `changed` here and `pinned` on a phone. That is gap 5 in
 * `docs/matrix/ephemeral.md`, and it is asserted here rather than hidden,
 * because the alternative is a snapshot assembled from a subscription the two
 * SDKs do not share.
 */

function status(overrides: Partial<WebVerificationStatus> = {}): WebVerificationStatus {
  return { known: true, needsUserApproval: false, isVerified: () => false, ...overrides };
}

describe('toIdentityTrust', () => {
  it('reports somebody this browser has never had keys for as unknown', () => {
    // The SDK's own note: when `known` is false every other flag is false too,
    // so asking them first reads "never seen" as "seen and not verified".
    expect(toIdentityTrust(status({ known: false }))).toBe('unknown');
  });

  it('reports a known, unverified identity as pinned', () => {
    expect(toIdentityTrust(status())).toBe('pinned');
  });

  it('reports a verified identity as verified', () => {
    expect(toIdentityTrust(status({ isVerified: () => true }))).toBe('verified');
  });

  it('reports an identity that changed as changed', () => {
    expect(toIdentityTrust(status({ needsUserApproval: true }))).toBe('changed');
  });

  it('reports a change even when the new identity is itself verified', () => {
    expect(
      toIdentityTrust(status({ needsUserApproval: true, isVerified: () => true })),
    ).toBe('changed');
  });
});

describe('toOwnDeviceTrust', () => {
  it('reports a verified own identity as verified', () => {
    expect(toOwnDeviceTrust(status({ isVerified: () => true }))).toBe('verified');
  });

  it('reports a known but unverified own identity as unverified', () => {
    expect(toOwnDeviceTrust(status())).toBe('unverified');
  });

  it('reports an account with no identity yet as unknown, not unverified', () => {
    // What it looks like before recovery has run. "Unverified" is a state the
    // user has to act on; this one resolves itself.
    expect(toOwnDeviceTrust(status({ known: false }))).toBe('unknown');
  });
});
