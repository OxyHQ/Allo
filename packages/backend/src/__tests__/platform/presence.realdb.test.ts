/**
 * Presence: the four rules of ADR 0002, each one broken on purpose.
 *
 * The rule that matters most is the one about indistinguishability — hidden,
 * blocked, unknown and plainly offline must all answer the same — because it
 * is the one a reasonable implementation gets wrong by being helpful.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { presenceResponseSchema, type PresenceState } from "@allo/shared-types";
import { getDb } from "../../db";
import { blockUser } from "../../db/social/blockRepository";
import { ensureUserSettings, updateUserSettings } from "../../db/social/userSettingsRepository";
import { touchLastSeen } from "../../db/platform/presenceRepository";
import { MemoryPresenceStore, setPresenceStore } from "../../runtime/presenceStore";
import { PresenceHub } from "../../runtime/presenceHub";
import { beat, farewell, readPresence } from "../../services/platform/presenceService";
import {
  accountId,
  createPlatformHarness,
  dmBetween,
  expectParses,
  TestInstance,
  USER_HEADER,
  type PlatformHarness,
} from "./harness";

let h: PlatformHarness;
let store: MemoryPresenceStore;

beforeAll(async () => {
  h = await createPlatformHarness();
}, 180_000);

afterAll(async () => {
  setPresenceStore(null);
  await h?.drop();
});

beforeEach(() => {
  store = new MemoryPresenceStore();
  setPresenceStore(store);
});

const stateFor = (body: unknown, id: string): PresenceState => {
  const parsed = expectParses(presenceResponseSchema, body);
  const found = parsed.presence.find((state) => state.accountId === id);
  if (!found) throw new Error(`no state for ${id}`);
  return found;
};

const hidden = (id: string): PresenceState => ({ accountId: id, online: false, lastSeenAt: null });

async function hidePresence(oxyUserId: string): Promise<void> {
  await ensureUserSettings(getDb(), oxyUserId);
  await updateUserSettings(getDb(), oxyUserId, { privacyShowOnlineStatus: false });
}

describe("GET /v1/presence", () => {
  it("requires the instance signature; an Oxy session alone is 401", async () => {
    const { a, b } = await dmBetween(h.app);
    const response = await request(h.app)
      .get(`/v1/presence?accountIds=${b.accountId}`)
      .set(USER_HEADER, a.accountId);
    expect(response.status).toBe(401);
  });

  it("answers online for an account with a live instance, and offline with a last seen once it goes", async () => {
    const { a, b } = await dmBetween(h.app);

    await beat(b.accountId, b.id, { store });
    const live = await a.signed("get", `/v1/presence?accountIds=${b.accountId}`);
    expect(live.status).toBe(200);
    expect(stateFor(live.body, b.accountId)).toEqual({ accountId: b.accountId, online: true, lastSeenAt: null });

    await farewell(b.accountId, b.id, { store });
    const gone = await a.signed("get", `/v1/presence?accountIds=${b.accountId}`);
    const state = stateFor(gone.body, b.accountId);
    expect(state.online).toBe(false);
    expect(state.lastSeenAt).not.toBeNull();
    // Published truncated to the minute: a second-accurate last seen tracks
    // better than the dot beside it.
    expect(state.lastSeenAt!.endsWith(":00.000Z")).toBe(true);
  });

  it("an account that hides its own presence receives nobody else's, and is told why", async () => {
    const { a, b } = await dmBetween(h.app);
    await beat(b.accountId, b.id, { store });
    await hidePresence(a.accountId);

    const response = await a.signed("get", `/v1/presence?accountIds=${b.accountId}`);
    const parsed = expectParses(presenceResponseSchema, response.body);
    expect(parsed.publishing).toBe(false);
    expect(parsed.presence).toEqual([hidden(b.accountId)]);
  });

  it("an account that hides is not published to others either", async () => {
    const { a, b } = await dmBetween(h.app);
    await beat(b.accountId, b.id, { store });
    await hidePresence(b.accountId);

    const response = await a.signed("get", `/v1/presence?accountIds=${b.accountId}`);
    expect(stateFor(response.body, b.accountId)).toEqual(hidden(b.accountId));
    expect(expectParses(presenceResponseSchema, response.body).publishing).toBe(true);
  });

  it("a stranger is answered, and answered with nothing: presence is not a directory lookup", async () => {
    const { a } = await dmBetween(h.app);
    const stranger = await TestInstance.register(h.app, accountId("stranger"));
    await beat(stranger.accountId, stranger.id, { store });

    const response = await a.signed("get", `/v1/presence?accountIds=${stranger.accountId}`);
    expect(response.status).toBe(200);
    expect(stateFor(response.body, stranger.accountId)).toEqual(hidden(stranger.accountId));
  });

  it("a block cuts presence in BOTH directions, and looks exactly like being offline", async () => {
    const { a, b } = await dmBetween(h.app);
    await beat(a.accountId, a.id, { store });
    await beat(b.accountId, b.id, { store });
    await blockUser(getDb(), { userId: a.accountId, blockedId: b.accountId });

    const blockerSees = await a.signed("get", `/v1/presence?accountIds=${b.accountId}`);
    expect(stateFor(blockerSees.body, b.accountId)).toEqual(hidden(b.accountId));

    // And the person who was blocked cannot tell that they were: the answer is
    // the same one they would get for somebody who is simply offline.
    const blockedSees = await b.signed("get", `/v1/presence?accountIds=${a.accountId}`);
    expect(stateFor(blockedSees.body, a.accountId)).toEqual(hidden(a.accountId));
  });

  it("an online account publishes no last seen, so the two facts are never read as one", async () => {
    const { a, b } = await dmBetween(h.app);
    await touchLastSeen(getDb(), b.accountId, new Date(Date.now() - 3_600_000));
    await beat(b.accountId, b.id, { store });

    const response = await a.signed("get", `/v1/presence?accountIds=${b.accountId}`);
    expect(stateFor(response.body, b.accountId)).toEqual({ accountId: b.accountId, online: true, lastSeenAt: null });
  });

  it("refuses an empty set and one over the cap", async () => {
    const { a } = await dmBetween(h.app);
    expect((await a.signed("get", "/v1/presence?accountIds=")).status).toBe(400);
    const tooMany = Array.from({ length: 201 }, (_, i) => `acct-0000-${String(i).padStart(4, "0")}`).join(",");
    expect((await a.signed("get", `/v1/presence?accountIds=${tooMany}`)).status).toBe(400);
  });

  it("asking about yourself answers nothing rather than reflecting your own dot back", async () => {
    const { a } = await dmBetween(h.app);
    await beat(a.accountId, a.id, { store });
    const response = await a.signed("get", `/v1/presence?accountIds=${a.accountId}`);
    expect(stateFor(response.body, a.accountId)).toEqual(hidden(a.accountId));
  });
});

describe("the heartbeat", () => {
  it("expires on its own: an instance that stops beating is offline without anybody reporting it", async () => {
    const { a, b } = await dmBetween(h.app);
    const at = new Date();
    await beat(b.accountId, b.id, { store, now: () => at });

    const later = new Date(at.getTime() + 76_000);
    const answer = await readPresence(a.accountId, [b.accountId], { store, now: () => later });
    expect(answer.presence[0].online).toBe(false);
  });

  it("writes last seen at most once a minute, however often it beats", async () => {
    const { b } = await dmBetween(h.app);
    const lastWrite = new Map<string, number>();
    const start = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await beat(b.accountId, b.id, { store, lastWrite, now: () => new Date(start + i * 10_000) });
    }
    expect(lastWrite.size).toBe(1);
  });
});

describe("the watch set", () => {
  interface Sent {
    accountId: string;
    online: boolean;
  }

  function fakeSocket(id: string) {
    const sent: Sent[] = [];
    return {
      socket: { id, emit: (_event: "presence", payload: PresenceState) => sent.push({ accountId: payload.accountId, online: payload.online }) },
      sent,
    };
  }

  it("answers a new watch in full, then sends only what changes", async () => {
    const { a, b } = await dmBetween(h.app);
    const hub = new PresenceHub();
    const watcher = fakeSocket("s1");
    const instanceA = { id: a.id, accountId: a.accountId, appId: "allo", status: "active" as const };

    await hub.attach(watcher.socket, instanceA);
    await hub.watch(watcher.socket, { accountIds: [b.accountId] });
    expect(watcher.sent).toEqual([{ accountId: b.accountId, online: false }]);

    await beat(b.accountId, b.id, { store });
    await hub.tick();
    expect(watcher.sent[watcher.sent.length - 1]).toEqual({ accountId: b.accountId, online: true });

    // Nothing changed: nothing is sent.
    const before = watcher.sent.length;
    await hub.tick();
    expect(watcher.sent.length).toBe(before);
    hub.stop();
  });

  it("says nothing about an account that is not being watched", async () => {
    const { a, b } = await dmBetween(h.app);
    const hub = new PresenceHub();
    const watcher = fakeSocket("s2");
    await hub.attach(watcher.socket, { id: a.id, accountId: a.accountId, appId: "allo", status: "active" });
    await hub.watch(watcher.socket, { accountIds: [] });

    await beat(b.accountId, b.id, { store });
    await hub.tick();
    expect(watcher.sent).toEqual([]);
    hub.stop();
  });

  it("a connecting instance is present, and its last socket leaving makes it absent", async () => {
    const { a, b } = await dmBetween(h.app);
    const hub = new PresenceHub();
    const instanceB = { id: b.id, accountId: b.accountId, appId: "allo", status: "active" as const };
    const first = fakeSocket("b1");
    const second = fakeSocket("b2");

    await hub.attach(first.socket, instanceB);
    expect((await store.onlineOf([b.accountId])).has(b.accountId)).toBe(true);

    // Two sockets, one instance: the first goodbye is not a goodbye.
    await hub.attach(second.socket, instanceB);
    await hub.detach(first.socket, instanceB);
    expect((await store.onlineOf([b.accountId])).has(b.accountId)).toBe(true);

    await hub.detach(second.socket, instanceB);
    expect((await store.onlineOf([b.accountId])).has(b.accountId)).toBe(false);
    hub.stop();
  });

  it("a pending instance is not present: it may hold a socket to hear about its approval", async () => {
    const pending = await TestInstance.register(h.app, accountId("p"));
    const hub = new PresenceHub();
    const socket = fakeSocket("p1");
    await hub.attach(socket.socket, { id: pending.id, accountId: pending.accountId, appId: "allo", status: "pending" });
    expect((await store.onlineOf([pending.accountId])).has(pending.accountId)).toBe(false);
    hub.stop();
  });

  it("drops a malformed watch frame rather than erroring, as the typing relay does", async () => {
    const { a } = await dmBetween(h.app);
    const hub = new PresenceHub();
    const watcher = fakeSocket("s3");
    await hub.attach(watcher.socket, { id: a.id, accountId: a.accountId, appId: "allo", status: "active" });
    await hub.watch(watcher.socket, { accountIds: "not a list" });
    expect(watcher.sent).toEqual([]);
    hub.stop();
  });
});
