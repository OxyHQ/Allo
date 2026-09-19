import { describe, expect, it } from "vitest";
import {
  MAX_PRESENCE_WATCH,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_TTL_MS,
  presenceQuerySchema,
  presenceResponseSchema,
  presenceStateSchema,
  presenceWatchEventSchema,
} from "../presence";
import { CLIENT_TO_SERVER_EVENTS, SERVER_TO_CLIENT_EVENTS } from "../sync";
import { UUID_V7 } from "./fixtures";

const other = "6700000000000000000000a2";

describe("presenceStateSchema", () => {
  it("takes an online account, an offline one with a last seen, and the hidden answer", () => {
    expect(presenceStateSchema.safeParse({ accountId: UUID_V7, online: true, lastSeenAt: null }).success).toBe(true);
    expect(
      presenceStateSchema.safeParse({ accountId: UUID_V7, online: false, lastSeenAt: "2026-09-19T10:00:00.000Z" }).success,
    ).toBe(true);
    expect(presenceStateSchema.safeParse({ accountId: UUID_V7, online: false, lastSeenAt: null }).success).toBe(true);
  });

  it("refuses a missing last seen, because absent and 'not telling you' must not be the same value", () => {
    expect(presenceStateSchema.safeParse({ accountId: UUID_V7, online: false }).success).toBe(false);
  });
});

describe("presenceQuerySchema", () => {
  it("splits a comma-separated watch set", () => {
    const parsed = presenceQuerySchema.parse({ accountIds: `${UUID_V7},${other}` });
    expect(parsed.accountIds).toEqual([UUID_V7, other]);
  });

  it("refuses an empty set and one over the cap, which is what keeps it a screen and not an address book", () => {
    expect(presenceQuerySchema.safeParse({ accountIds: "" }).success).toBe(false);
    expect(presenceQuerySchema.safeParse({ accountIds: Array(MAX_PRESENCE_WATCH + 1).fill(UUID_V7).join(",") }).success).toBe(
      false,
    );
  });

  it("refuses an id that is not one", () => {
    expect(presenceQuerySchema.safeParse({ accountIds: "no spaces allowed" }).success).toBe(false);
  });
});

describe("presenceResponseSchema", () => {
  it("carries whether the asker publishes, so the app can say why it sees nothing", () => {
    expect(presenceResponseSchema.safeParse({ presence: [], publishing: false }).success).toBe(true);
    expect(presenceResponseSchema.safeParse({ presence: [] }).success).toBe(false);
  });
});

describe("the socket registry", () => {
  it("carries presence in both directions", () => {
    expect(SERVER_TO_CLIENT_EVENTS.presence).toBe(presenceStateSchema);
    expect(CLIENT_TO_SERVER_EVENTS["presence.watch"]).toBe(presenceWatchEventSchema);
    expect(Object.keys(CLIENT_TO_SERVER_EVENTS)).toEqual(["typing", "presence.watch", "presence.heartbeat"]);
  });

  it("empties the watch set rather than refusing it: that is how a client stops listening", () => {
    expect(presenceWatchEventSchema.safeParse({ accountIds: [] }).success).toBe(true);
  });
});

describe("the timings", () => {
  it("heartbeats comfortably inside the TTL, so one lost beat is not an offline blink", () => {
    expect(PRESENCE_HEARTBEAT_MS * 2).toBeLessThan(PRESENCE_TTL_MS);
  });
});
