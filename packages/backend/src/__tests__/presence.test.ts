import {
  PresenceRegistry,
  buildPresencePayload,
  parseBootstrapUserIds,
  computeAudience,
  resolveHiddenUserIds,
  maskHiddenEntries,
  buildBootstrapResult,
  MAX_PRESENCE_BOOTSTRAP_IDS,
  type PresenceEntry,
} from "../utils/presence";

const USER = "user-1";
const KEY_1 = "socket-a";
const KEY_2 = "socket-b";

/** Loose ISO-8601 shape check (date + time + offset/Z). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

describe("PresenceRegistry", () => {
  it("brings a user online on the first connection", () => {
    const registry = new PresenceRegistry();
    const { becameOnline } = registry.addConnection(USER, KEY_1);
    expect(becameOnline).toBe(true);
    expect(registry.isOnline(USER)).toBe(true);
    expect(registry.connectionCount(USER)).toBe(1);
  });

  it("does not re-fire becameOnline for a second connection of the same user", () => {
    const registry = new PresenceRegistry();
    registry.addConnection(USER, KEY_1);
    const { becameOnline } = registry.addConnection(USER, KEY_2);
    expect(becameOnline).toBe(false);
    expect(registry.connectionCount(USER)).toBe(2);
  });

  it("stays online while at least one connection remains", () => {
    const registry = new PresenceRegistry();
    registry.addConnection(USER, KEY_1);
    registry.addConnection(USER, KEY_2);
    const { becameOffline } = registry.removeConnection(USER, KEY_1);
    expect(becameOffline).toBe(false);
    expect(registry.isOnline(USER)).toBe(true);
    expect(registry.connectionCount(USER)).toBe(1);
  });

  it("goes offline when the last connection drops and records lastSeenAt", () => {
    const registry = new PresenceRegistry();
    registry.addConnection(USER, KEY_1);
    registry.addConnection(USER, KEY_2);
    registry.removeConnection(USER, KEY_1);
    const { becameOffline, lastSeenAt } = registry.removeConnection(USER, KEY_2);

    expect(becameOffline).toBe(true);
    expect(lastSeenAt).not.toBeNull();
    expect(typeof lastSeenAt).toBe("string");
    expect(lastSeenAt).toMatch(ISO_RE);
    expect(registry.isOnline(USER)).toBe(false);

    const entry = registry.getEntry(USER);
    expect(entry.online).toBe(false);
    expect(entry.lastSeenAt).toMatch(ISO_RE);
  });

  it("removing an unknown connection is a no-op", () => {
    const registry = new PresenceRegistry();
    const { becameOffline, lastSeenAt } = registry.removeConnection(USER, KEY_1);
    expect(becameOffline).toBe(false);
    expect(lastSeenAt).toBeNull();
    expect(registry.isOnline(USER)).toBe(false);
  });

  it("getEntry for a never-seen user is offline with null lastSeenAt", () => {
    const registry = new PresenceRegistry();
    expect(registry.getEntry("nobody")).toEqual({ online: false, lastSeenAt: null });
  });

  it("getEntries returns a map across online, offline and unknown users", () => {
    const registry = new PresenceRegistry();
    registry.addConnection("online-user", KEY_1);
    registry.addConnection("offline-user", KEY_2);
    registry.removeConnection("offline-user", KEY_2);

    const entries = registry.getEntries(["online-user", "offline-user", "unknown-user"]);
    expect(entries["online-user"].online).toBe(true);
    expect(entries["online-user"].lastSeenAt).toMatch(ISO_RE);
    expect(entries["offline-user"].online).toBe(false);
    expect(entries["offline-user"].lastSeenAt).toMatch(ISO_RE);
    expect(entries["unknown-user"]).toEqual({ online: false, lastSeenAt: null });
  });
});

describe("buildPresencePayload", () => {
  it("projects an entry to the wire shape", () => {
    const entry: PresenceEntry = { online: true, lastSeenAt: "2026-06-11T00:00:00.000Z" };
    expect(buildPresencePayload(USER, entry)).toEqual({
      userId: USER,
      online: true,
      lastSeenAt: "2026-06-11T00:00:00.000Z",
    });
  });

  it("preserves a null lastSeenAt", () => {
    expect(buildPresencePayload(USER, { online: false, lastSeenAt: null })).toEqual({
      userId: USER,
      online: false,
      lastSeenAt: null,
    });
  });
});

describe("parseBootstrapUserIds", () => {
  it("parses a comma-separated string, trimming and de-duplicating", () => {
    expect(parseBootstrapUserIds(" a , b ,a, c ", 100)).toEqual(["a", "b", "c"]);
  });

  it("drops empty segments", () => {
    expect(parseBootstrapUserIds("a,,b,", 100)).toEqual(["a", "b"]);
  });

  it("caps the number of ids", () => {
    const result = parseBootstrapUserIds("a,b,c,d,e", 3);
    expect(result).toHaveLength(3);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("enforces MAX_PRESENCE_BOOTSTRAP_IDS", () => {
    const raw = Array.from({ length: 250 }, (_, i) => `u${i}`).join(",");
    expect(parseBootstrapUserIds(raw, MAX_PRESENCE_BOOTSTRAP_IDS)).toHaveLength(
      MAX_PRESENCE_BOOTSTRAP_IDS
    );
  });

  it("returns an empty array for non-string input", () => {
    for (const bad of [undefined, null, 5, {}, ["a"]]) {
      expect(parseBootstrapUserIds(bad, 100)).toEqual([]);
    }
  });
});

describe("computeAudience", () => {
  it("flattens participants, removes self and de-duplicates", () => {
    const conversations = [
      { participants: [{ userId: "self" }, { userId: "a" }] },
      { participants: [{ userId: "self" }, { userId: "a" }, { userId: "b" }] },
    ];
    const audience = computeAudience(conversations, "self", 100);
    expect(audience).toEqual(["a", "b"]);
    expect(audience).not.toContain("self");
  });

  it("returns empty when there are no other participants", () => {
    expect(computeAudience([{ participants: [{ userId: "self" }] }], "self", 100)).toEqual([]);
  });

  it("returns empty for no conversations", () => {
    expect(computeAudience([], "self", 100)).toEqual([]);
  });

  it("enforces the cap", () => {
    const conversations = [
      {
        participants: Array.from({ length: 50 }, (_, i) => ({ userId: `u${i}` })),
      },
    ];
    expect(computeAudience(conversations, "self", 10)).toHaveLength(10);
  });
});

describe("resolveHiddenUserIds", () => {
  it("includes users who opted out of presence", () => {
    const hidden = resolveHiddenUserIds([
      { oxyUserId: "hidden-user", privacy: { showOnlineStatus: false } },
    ]);
    expect(hidden.has("hidden-user")).toBe(true);
  });

  it("excludes users with showOnlineStatus true or unset", () => {
    const hidden = resolveHiddenUserIds([
      { oxyUserId: "visible-explicit", privacy: { showOnlineStatus: true } },
      { oxyUserId: "visible-unset-privacy", privacy: {} },
      { oxyUserId: "visible-no-privacy" },
    ]);
    expect(hidden.has("visible-explicit")).toBe(false);
    expect(hidden.has("visible-unset-privacy")).toBe(false);
    expect(hidden.has("visible-no-privacy")).toBe(false);
    expect(hidden.size).toBe(0);
  });
});

describe("maskHiddenEntries / buildBootstrapResult", () => {
  it("forces a hidden user to offline even when the registry says online", () => {
    const registry = new PresenceRegistry();
    registry.addConnection("hidden-user", KEY_1);
    registry.addConnection("visible-user", KEY_2);

    const hidden = new Set<string>(["hidden-user"]);
    const result = buildBootstrapResult(["hidden-user", "visible-user"], registry, hidden);

    expect(result["hidden-user"]).toEqual({ online: false, lastSeenAt: null });
    expect(result["visible-user"].online).toBe(true);
  });

  it("does not mutate the input map", () => {
    const entries: Record<string, PresenceEntry> = {
      a: { online: true, lastSeenAt: "2026-06-11T00:00:00.000Z" },
    };
    const masked = maskHiddenEntries(entries, new Set(["a"]));
    expect(masked["a"]).toEqual({ online: false, lastSeenAt: null });
    // Original untouched.
    expect(entries["a"]).toEqual({ online: true, lastSeenAt: "2026-06-11T00:00:00.000Z" });
  });
});
