import { EphemeralSendGuard } from '@/lib/matrix/ephemeral/guard';
import { MatrixEphemeralUntrustedError } from '@/lib/matrix/errors';
import type { AlloEphemeralPolicy, AlloRoomTrust } from '@/lib/matrix/types';

/**
 * The check that stands between a caller of the port and a send.
 *
 * It lives inside `lib/matrix/` rather than in the app's seam so that no screen
 * can get past it, and it is one object rather than two copies so that both
 * platforms cannot drift apart. What is asserted here is the shape of that: what
 * it reads, when it reads it, and what it refuses.
 */

const ROOM = '!secret:allo.you';
const ORDINARY = '!ordinary:allo.you';
const POLICY: AlloEphemeralPolicy = { lifetimeMs: 3_600_000 };

const VERIFIED: AlloRoomTrust = {
  ownDevice: 'verified',
  members: [{ userId: '@alice:allo.you', trust: 'pinned' }],
};

const UNTRUSTED: AlloRoomTrust = {
  ownDevice: 'verified',
  members: [{ userId: '@mallory:allo.you', trust: 'unknown' }],
};

function guardWith(
  policies: ReadonlyMap<string, AlloEphemeralPolicy>,
  trust: AlloRoomTrust,
): { guard: EphemeralSendGuard; trustReads: string[]; policyReads: number } {
  const trustReads: string[] = [];
  const counters = { policyReads: 0 };
  const guard = new EphemeralSendGuard({
    policies: async () => {
      counters.policyReads += 1;
      return policies;
    },
    trust: async (roomId) => {
      trustReads.push(roomId);
      return trust;
    },
  });
  return {
    guard,
    trustReads,
    get policyReads() {
      return counters.policyReads;
    },
  };
}

describe('EphemeralSendGuard', () => {
  it('lets an ordinary conversation through', async () => {
    const { guard } = guardWith(new Map(), UNTRUSTED);

    await expect(guard.requireSendable(ORDINARY)).resolves.toBeUndefined();
  });

  it("does not read anybody's identity for an ordinary conversation", async () => {
    // This runs before every message the app sends. Reading the identity of
    // everybody in every room would put a crypto-store walk on the critical path
    // of the composer, for a rule that does not apply.
    const context = guardWith(new Map(), UNTRUSTED);

    await context.guard.requireSendable(ORDINARY);

    expect(context.trustReads).toEqual([]);
  });

  it('lets an ephemeral conversation through when everybody is accounted for', async () => {
    const { guard } = guardWith(new Map([[ROOM, POLICY]]), VERIFIED);

    await expect(guard.requireSendable(ROOM)).resolves.toBeUndefined();
  });

  it('refuses an ephemeral conversation with somebody it cannot account for', async () => {
    const { guard } = guardWith(new Map([[ROOM, POLICY]]), UNTRUSTED);

    await expect(guard.requireSendable(ROOM)).rejects.toBeInstanceOf(
      MatrixEphemeralUntrustedError,
    );
  });

  it('carries the reason and the people on the error', async () => {
    // The screen has to say which of the two problems it is, in the reader's own
    // language, and name whoever is involved. Reformatting an English sentence
    // is not a way to do that.
    const { guard } = guardWith(new Map([[ROOM, POLICY]]), UNTRUSTED);

    await expect(guard.requireSendable(ROOM)).rejects.toMatchObject({
      roomId: ROOM,
      refusal: { kind: 'members-untrusted', userIds: ['@mallory:allo.you'] },
    });
  });

  it('refuses when this device itself is not verified', async () => {
    const { guard } = guardWith(new Map([[ROOM, POLICY]]), {
      ownDevice: 'unverified',
      members: [],
    });

    await expect(guard.requireSendable(ROOM)).rejects.toMatchObject({
      refusal: { kind: 'own-device-unverified' },
    });
  });

  it('reads the policies again on every send', async () => {
    // Not cached. A conversation the user made ephemeral on another device would
    // otherwise keep behaving as an ordinary one until the app was restarted,
    // and there would be nothing on screen to say so. Both SDKs answer this from
    // the local account data store, so it costs no request.
    const context = guardWith(new Map(), VERIFIED);

    await context.guard.requireSendable(ORDINARY);
    await context.guard.requireSendable(ORDINARY);

    expect(context.policyReads).toBe(2);
  });

  it('reads the trust of the room it was asked about', async () => {
    const context = guardWith(new Map([[ROOM, POLICY]]), VERIFIED);

    await context.guard.requireSendable(ROOM);

    expect(context.trustReads).toEqual([ROOM]);
  });
});
