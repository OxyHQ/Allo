import { viewerUnreadCount } from '@/lib/unreadCount';

/**
 * `unreadCounts` is a per-participant map, not a conversation total. The backend
 * increments an entry for every participant except the sender and zeroes only the
 * entry of whoever reads, so a conversation in normal use carries a non-zero count
 * for more than one person at once.
 *
 * That is the shape these tests are built around: a case where only the viewer has
 * unread mail cannot tell "read the viewer's entry" apart from "add the entries up",
 * because with every other entry at zero the sum IS the viewer's count. Every
 * assertion below that guards the fix therefore puts a non-zero count on both sides.
 */

const VIEWER = 'oxy-viewer-1';
const OTHER = 'oxy-other-2';
const THIRD = 'oxy-third-3';

describe('viewerUnreadCount', () => {
  describe('reads the viewer’s own entry, not the conversation total', () => {
    it('ignores the other participant’s unread mail in a direct chat', () => {
      // The viewer has 2 unread; the other side has 5 unread of the viewer's own
      // messages. Summing would report 7.
      expect(viewerUnreadCount({ [VIEWER]: 2, [OTHER]: 5 }, VIEWER)).toBe(2);
    });

    it('ignores every other member’s unread mail in a group', () => {
      expect(
        viewerUnreadCount({ [VIEWER]: 1, [OTHER]: 9, [THIRD]: 4 }, VIEWER)
      ).toBe(1);
    });

    it('reports zero for a viewer who is caught up while others are not', () => {
      // The case that actually reaches a user as a phantom badge: nothing to read,
      // but the other side has a backlog.
      expect(viewerUnreadCount({ [VIEWER]: 0, [OTHER]: 6 }, VIEWER)).toBe(0);
    });

    it('reports zero for a viewer with no entry at all while others have one', () => {
      // A participant who has never had a message counted for them has no key.
      expect(viewerUnreadCount({ [OTHER]: 6 }, VIEWER)).toBe(0);
    });

    it('gives each viewer their own count from one shared map', () => {
      const counts = { [VIEWER]: 2, [OTHER]: 5 };
      expect(viewerUnreadCount(counts, VIEWER)).toBe(2);
      expect(viewerUnreadCount(counts, OTHER)).toBe(5);
    });
  });

  describe('reads the shape that actually arrives over the wire', () => {
    /**
     * There used to be a case here asserting a `Map` was read too. It went with
     * the Postgres port, and it is worth saying why rather than leaving its
     * absence to look like a gap: JSON has no Map, so one never crossed the
     * wire. The backend had typed its Mongoose `Map` into the transport DTO, the
     * helper grew an `instanceof Map` branch to satisfy that type, and the test
     * pinned a branch that could only ever be reached by calling the function
     * directly — which is what the deleted case did.
     */
    it('reads a plain object keyed by user id', () => {
      expect(viewerUnreadCount({ [VIEWER]: 2, [OTHER]: 5 }, VIEWER)).toBe(2);
    });
  });

  describe('declines to guess when it cannot identify the viewer', () => {
    it('is zero, not the total, before the session restores', () => {
      // An Oxy session can take seconds to restore. Falling back to the sum here
      // is what the badge used to do for everyone.
      expect(viewerUnreadCount({ [VIEWER]: 2, [OTHER]: 5 }, undefined)).toBe(0);
    });

    it('is zero for a conversation with no counts recorded', () => {
      expect(viewerUnreadCount(undefined, VIEWER)).toBe(0);
      expect(viewerUnreadCount({}, VIEWER)).toBe(0);
    });
  });
});
