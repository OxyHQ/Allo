/**
 * Session store key-index tests.
 *
 * Exercises the REAL `lib/signal/sessionStore` against the in-memory
 * secure-storage (expo-secure-store mock) and regular-storage (AsyncStorage
 * mock) provided by jest.setup. Only the Double Ratchet (de)serializer is
 * stubbed — these tests are about the persisted key index that makes sessions
 * wipeable, not about ratchet crypto (covered by signal.test.ts).
 *
 * Focus: the migration self-heal — a session written BEFORE the key index
 * existed (so it isn't tracked) must get indexed on load and then be wiped by
 * `wipeAllSessions`.
 */

// Pass-through (de)serializer so we can use plain objects as "ratchet state".
jest.mock("@/lib/signal/doubleRatchet", () => ({
  __esModule: true,
  serializeRatchet: (state: unknown) => state,
  deserializeRatchet: (data: unknown) => data,
}));

// eslint-disable-next-line import/first
import {
  loadSession,
  saveSession,
  wipeAllSessions,
  clearSessionMemoryCache,
} from "@/lib/signal/sessionStore";
// eslint-disable-next-line import/first
import { getSecureItem, setSecureItem, removeSecureItem } from "@/lib/secureStorage";
// `setSecureItem` is used to seed a legacy (un-indexed) session in one test.
// eslint-disable-next-line import/first
import { Storage } from "@/utils/storage";

const SESSION_KEY_PREFIX = "signal_session_v2_";
const SESSION_KEY_INDEX = "signal_session_v2_index";

/** The storage key sessionStore derives for a peer address. */
function keyFor(userId: string, deviceId: number): string {
  const safeUser = userId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${SESSION_KEY_PREFIX}${safeUser}_${deviceId}`;
}

/** A minimal stand-in ratchet state (opaque to these tests). */
const FAKE_STATE = { ratchet: "state" } as unknown as Parameters<typeof saveSession>[1];

beforeEach(async () => {
  // Reset all persisted state and the in-memory cache between tests.
  clearSessionMemoryCache();
  const all = await Storage.get<string[]>(SESSION_KEY_INDEX);
  if (Array.isArray(all)) {
    for (const k of all) await removeSecureItem(k);
  }
  await Storage.remove(SESSION_KEY_INDEX);
});

describe("sessionStore key index", () => {
  it("saveSession tracks the key so wipeAllSessions removes it", async () => {
    await saveSession({ userId: "userB", deviceId: 2 }, FAKE_STATE);
    const key = keyFor("userB", 2);

    // Stored + indexed.
    expect(await getSecureItem(key)).not.toBeNull();
    expect(await Storage.get<string[]>(SESSION_KEY_INDEX)).toContain(key);

    await wipeAllSessions();

    // Storage entry gone, index cleared, memory cache cleared.
    expect(await getSecureItem(key)).toBeNull();
    expect(await Storage.get<string[]>(SESSION_KEY_INDEX)).toBeNull();
  });

  it("self-heals a legacy session missing from the index on load, then wipes it", async () => {
    // Simulate a session written by an OLD build: present in secure storage but
    // NOT recorded in the key index.
    const key = keyFor("legacyUser", 7);
    await setSecureItem(key, JSON.stringify({ ratchet: "legacy" }));
    expect(await Storage.get<string[]>(SESSION_KEY_INDEX)).toBeNull();

    // Loading it must return the session AND index it (self-heal). loadSession
    // fires the index write asynchronously, so flush the microtask queue.
    clearSessionMemoryCache();
    const loaded = await loadSession({ userId: "legacyUser", deviceId: 7 });
    expect(loaded).toEqual({ ratchet: "legacy" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await Storage.get<string[]>(SESSION_KEY_INDEX)).toContain(key);

    // Now wipeAllSessions can find and remove the previously-untracked session.
    await wipeAllSessions();
    expect(await getSecureItem(key)).toBeNull();
  });

  it("does not duplicate a key in the index across repeated loads/saves", async () => {
    await saveSession({ userId: "userC", deviceId: 3 }, FAKE_STATE);
    clearSessionMemoryCache();
    await loadSession({ userId: "userC", deviceId: 3 });
    await loadSession({ userId: "userC", deviceId: 3 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const index = (await Storage.get<string[]>(SESSION_KEY_INDEX)) ?? [];
    const key = keyFor("userC", 3);
    expect(index.filter((k) => k === key)).toHaveLength(1);
  });

  it("wipeAllSessions clears the in-memory cache (no resurrected state)", async () => {
    await saveSession({ userId: "userD", deviceId: 4 }, FAKE_STATE);
    // Cached in memory by saveSession.
    await wipeAllSessions();

    // A subsequent load must hit storage (now empty) and return null, proving the
    // memory cache was cleared rather than serving the wiped session.
    const loaded = await loadSession({ userId: "userD", deviceId: 4 });
    expect(loaded).toBeNull();
  });
});
