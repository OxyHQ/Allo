/**
 * Presence store + event-mapper unit tests.
 *
 * The store (`stores/presenceStore`) is pure Zustand and runs on plain Node.
 * `applyPresenceEvent` (from `hooks/usePresence`) maps a raw `presence:update`
 * payload onto the store; importing that hook pulls in the REST client and the
 * shared-socket accessor, so both are mocked to keep this a focused unit test
 * with no network or socket.
 */

jest.mock("@/utils/api", () => ({
  __esModule: true,
  api: { get: jest.fn() },
}));

jest.mock("@/hooks/useRealtimeMessaging", () => ({
  __esModule: true,
  getMessagingSocket: jest.fn(() => null),
}));

// eslint-disable-next-line import/first
import { usePresenceStore } from "@/stores/presenceStore";
// eslint-disable-next-line import/first
import { applyPresenceEvent } from "@/hooks/usePresence";

beforeEach(() => {
  usePresenceStore.getState().clearAll();
});

describe("presenceStore", () => {
  it("setPresence stores a single user's online state and lastSeenAt", () => {
    usePresenceStore.getState().setPresence("u1", true, null);
    expect(usePresenceStore.getState().getPresence("u1")).toEqual({
      online: true,
      lastSeenAt: null,
    });
  });

  it("setPresence overwrites a previous entry for the same user", () => {
    const iso = "2026-06-11T10:00:00.000Z";
    usePresenceStore.getState().setPresence("u1", true, null);
    usePresenceStore.getState().setPresence("u1", false, iso);
    expect(usePresenceStore.getState().getPresence("u1")).toEqual({
      online: false,
      lastSeenAt: iso,
    });
  });

  it("setMany merges a batch without dropping existing entries", () => {
    usePresenceStore.getState().setPresence("u1", true, null);
    usePresenceStore.getState().setMany({
      u2: { online: false, lastSeenAt: "2026-06-11T09:00:00.000Z" },
      u3: { online: true, lastSeenAt: null },
    });

    const { byUserId } = usePresenceStore.getState();
    expect(Object.keys(byUserId).sort()).toEqual(["u1", "u2", "u3"]);
    expect(byUserId.u1.online).toBe(true);
    expect(byUserId.u2.online).toBe(false);
    expect(byUserId.u3.online).toBe(true);
  });

  it("setMany is a no-op for an empty map", () => {
    usePresenceStore.getState().setPresence("u1", true, null);
    usePresenceStore.getState().setMany({});
    expect(Object.keys(usePresenceStore.getState().byUserId)).toEqual(["u1"]);
  });

  it("getPresence returns undefined for an unknown user", () => {
    expect(usePresenceStore.getState().getPresence("nobody")).toBeUndefined();
  });

  it("clearAll empties the map", () => {
    usePresenceStore.getState().setPresence("u1", true, null);
    usePresenceStore.getState().setMany({ u2: { online: true, lastSeenAt: null } });
    usePresenceStore.getState().clearAll();
    expect(usePresenceStore.getState().byUserId).toEqual({});
  });
});

describe("applyPresenceEvent", () => {
  it("applies an online event to the store", () => {
    applyPresenceEvent({ userId: "u1", online: true, lastSeenAt: null });
    expect(usePresenceStore.getState().getPresence("u1")).toEqual({
      online: true,
      lastSeenAt: null,
    });
  });

  it("flips a user offline and records lastSeenAt", () => {
    const iso = "2026-06-11T11:00:00.000Z";
    applyPresenceEvent({ userId: "u1", online: true, lastSeenAt: null });
    applyPresenceEvent({ userId: "u1", online: false, lastSeenAt: iso });
    expect(usePresenceStore.getState().getPresence("u1")).toEqual({
      online: false,
      lastSeenAt: iso,
    });
  });

  it("coerces a missing lastSeenAt to null", () => {
    applyPresenceEvent({ userId: "u1", online: true, lastSeenAt: undefined as unknown as null });
    expect(usePresenceStore.getState().getPresence("u1")).toEqual({
      online: true,
      lastSeenAt: null,
    });
  });

  it("ignores a malformed payload (no userId)", () => {
    applyPresenceEvent(undefined);
    applyPresenceEvent({ online: true, lastSeenAt: null } as unknown as Parameters<
      typeof applyPresenceEvent
    >[0]);
    expect(usePresenceStore.getState().byUserId).toEqual({});
  });
});
