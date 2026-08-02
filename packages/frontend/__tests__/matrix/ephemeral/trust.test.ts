import { ephemeralSendRefusal } from '@/lib/matrix/ephemeral/trust';
import type { AlloIdentityTrust, AlloRoomTrust } from '@/lib/matrix/types';

/**
 * The rule an ephemeral conversation refuses to send under.
 *
 * This is the part of the tier that Matrix genuinely enforces rather than asks
 * for politely: a refusal means nothing leaves the device, so no Megolm session
 * is created for it and no room key is shared. Everything below is therefore an
 * assertion about a security control, and the two directions are not equally
 * bad — letting a message through that should not have gone is worse than
 * refusing one that could have.
 */

function trust(
  ownDevice: AlloRoomTrust['ownDevice'],
  members: readonly [string, AlloIdentityTrust][],
): AlloRoomTrust {
  return { ownDevice, members: members.map(([userId, value]) => ({ userId, trust: value })) };
}

describe('ephemeralSendRefusal', () => {
  it('allows a room where everybody is recognised and this device is verified', () => {
    expect(
      ephemeralSendRefusal(
        trust('verified', [
          ['@alice:allo.you', 'pinned'],
          ['@bob:allo.you', 'verified'],
        ]),
      ),
    ).toBeUndefined();
  });

  it.each<AlloRoomTrust['ownDevice']>(['unverified', 'unknown'])(
    'refuses when this device is %s',
    (ownDevice) => {
      // A device that has not taken the cross-signing keys out of 4S cannot be
      // attributed to the account by anybody else, so what it sends into a
      // conversation that promises its participants are accounted for is not
      // accounted for either.
      expect(ephemeralSendRefusal(trust(ownDevice, [['@alice:allo.you', 'verified']]))).toEqual({
        kind: 'own-device-unverified',
      });
    },
  );

  it('reports this device before it reports anybody else', () => {
    // The one thing the user can fix alone. Telling them three people are not
    // trusted, when the problem is their own device, sends them after the wrong
    // thing — and after three people who cannot help.
    expect(ephemeralSendRefusal(trust('unverified', [['@alice:allo.you', 'unknown']]))).toEqual({
      kind: 'own-device-unverified',
    });
  });

  it('refuses when somebody has published no identity', () => {
    expect(
      ephemeralSendRefusal(
        trust('verified', [
          ['@alice:allo.you', 'pinned'],
          ['@bob:allo.you', 'unknown'],
        ]),
      ),
    ).toEqual({ kind: 'members-untrusted', userIds: ['@bob:allo.you'] });
  });

  it('refuses when somebody has replaced the identity this device knew', () => {
    // The attack this rule is actually for: a homeserver substituting a
    // different identity for somebody after the conversation started.
    expect(
      ephemeralSendRefusal(trust('verified', [['@mallory:allo.you', 'changed']])),
    ).toEqual({ kind: 'members-untrusted', userIds: ['@mallory:allo.you'] });
  });

  it('names everybody it could not account for, in the order the room lists them', () => {
    expect(
      ephemeralSendRefusal(
        trust('verified', [
          ['@alice:allo.you', 'unknown'],
          ['@bob:allo.you', 'pinned'],
          ['@carol:allo.you', 'changed'],
        ]),
      ),
    ).toEqual({
      kind: 'members-untrusted',
      userIds: ['@alice:allo.you', '@carol:allo.you'],
    });
  });

  it('allows a conversation nobody else has joined yet', () => {
    // A group created a moment ago, with the invitations still out. There is
    // nobody to be wrong about.
    expect(ephemeralSendRefusal(trust('verified', []))).toBeUndefined();
  });

  it('accepts an identity that is only recognised, not verified', () => {
    // Stated as a decision rather than left to be inferred. Allo has no
    // interactive verification, so demanding `verified` would refuse every
    // message in every ephemeral conversation for ever — which is not a stricter
    // feature, it is an absent one. What is demanded is that the identity be the
    // one this device has always seen.
    expect(ephemeralSendRefusal(trust('verified', [['@alice:allo.you', 'pinned']]))).toBeUndefined();
  });
});
