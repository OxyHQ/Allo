/**
 * The `/v1` Socket.IO namespace: the handshake is Oxy + instance signature,
 * rooms come from the verified instance, `typing` is relayed to the other
 * active leaves and stored nowhere, and a revoked instance is cut off.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { EMPTY_BODY_SHA256_HEX, SOCKET_NAMESPACE, SOCKET_SIGNING_PATH, signedRequestMessage } from "@allo/shared-types";
import * as schema from "../../db/schema";
import { getDb } from "../../db";
import { revokeInstance } from "../../services/platform/instanceService";
import { setRealtime } from "../../runtime/realtime";
import { createSocketServer, type SocketRuntime } from "../../runtime/socket";
import { base64, createPlatformHarness, dmBetween, signMessage, TestInstance, accountId, type PlatformHarness } from "./harness";

let h: PlatformHarness;
let server: http.Server;
let sockets: SocketRuntime;
let url: string;

/** Oxy's socket auth stand-in: `auth.oxyUser` names the account. */
const fakeOxy = {
  authSocket: () => async (socket: unknown, next: (err?: Error) => void) => {
    const s = socket as { handshake: { auth: Record<string, unknown> }; data: Record<string, unknown> };
    const userId = s.handshake.auth.oxyUser;
    if (typeof userId !== "string") return next(new Error("no session"));
    s.data.userId = userId;
    next();
  },
};

beforeAll(async () => {
  h = await createPlatformHarness();
  server = http.createServer(h.app);
  sockets = createSocketServer(server, { oxy: fakeOxy, instanceAuth: { getDb } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${SOCKET_NAMESPACE}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => sockets.io.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await h?.drop();
});

function socketAuthFor(instance: TestInstance, overrides: Record<string, unknown> = {}) {
  const timestamp = Date.now();
  const signature = signMessage(
    instance.key,
    signedRequestMessage({ method: "GET", pathWithQuery: SOCKET_SIGNING_PATH, timestampMs: timestamp, bodySha256Hex: EMPTY_BODY_SHA256_HEX }),
  );
  return { oxyUser: instance.accountId, instanceId: instance.id, timestamp, signature, ...overrides };
}

function open(auth: Record<string, unknown>): Promise<{ socket: Socket; error?: string }> {
  return new Promise((resolve) => {
    const socket = connect(url, { auth, transports: ["websocket"], reconnection: false, forceNew: true });
    socket.on("connect", () => resolve({ socket }));
    socket.on("connect_error", (error) => resolve({ socket, error: error.message }));
  });
}

describe("the handshake", () => {
  it("admits a correctly signed instance and refuses a bad signature, a foreign account and a stale timestamp", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const ok = await open(socketAuthFor(me));
    expect(ok.error).toBeUndefined();
    ok.socket.close();

    const bad = await open(socketAuthFor(me, { signature: "A".repeat(88) }));
    expect(bad.error).toBe("unauthorized");
    const foreign = await open(socketAuthFor(me, { oxyUser: accountId("x") }));
    expect(foreign.error).toBe("forbidden");
    const stale = await open({ ...socketAuthFor(me), timestamp: Date.now() - 10 * 60 * 1000 });
    expect(stale.error).toBe("unauthorized");
    const noSession = await open({ ...socketAuthFor(me), oxyUser: undefined });
    expect(noSession.error).toBe("no session");
  });
});

describe("rooms and relays", () => {
  it("relays typing to the other active leaves only, reports connectivity, and disconnects a revoked instance", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const stranger = await TestInstance.register(h.app, accountId("s"));
    const [sa, sb, ss] = await Promise.all([open(socketAuthFor(a)), open(socketAuthFor(b)), open(socketAuthFor(stranger))]);
    expect([sa.error, sb.error, ss.error]).toEqual([undefined, undefined, undefined]);

    expect(await sockets.realtime.isInstanceConnected(b.id)).toBe(true);
    expect(await sockets.realtime.isInstanceConnected("nobody-00000001")).toBe(false);

    const heardByB = new Promise<unknown>((resolve) => sb.socket.once("typing", resolve));
    let heardByA = false;
    let heardByStranger = false;
    sa.socket.on("typing", () => (heardByA = true));
    ss.socket.on("typing", () => (heardByStranger = true));
    sa.socket.emit("typing", { conversationId, ciphertext: base64("typing-ciphertext") });
    expect(await heardByB).toEqual({ conversationId, ciphertext: base64("typing-ciphertext") });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heardByA).toBe(false);
    expect(heardByStranger).toBe(false);
    // Nothing was stored: the event log is unchanged.
    const events = await h.db.select().from(schema.conversationEvents).where(eq(schema.conversationEvents.conversationId, conversationId));
    expect(events).toHaveLength(2);

    // A stranger's typing frame for a conversation it is not in goes nowhere.
    let leaked = false;
    sb.socket.on("typing", () => (leaked = true));
    ss.socket.emit("typing", { conversationId, ciphertext: base64("x") });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(leaked).toBe(false);

    // Revocation through the real service with the real realtime: b hears
    // instance.revoked on the account room, then is disconnected.
    setRealtime(sockets.realtime);
    const revokedEvent = new Promise<unknown>((resolve) => sb.socket.once("instance.revoked", resolve));
    const disconnected = new Promise<string>((resolve) => sb.socket.once("disconnect", resolve));
    await revokeInstance({ id: b.id, accountId: b.accountId }, b.id, { db: h.db });
    expect(await revokedEvent).toEqual({ instanceId: b.id });
    expect(await disconnected).toBe("io server disconnect");
    expect(await sockets.realtime.isInstanceConnected(b.id)).toBe(false);
    setRealtime(h.realtime);

    sa.socket.close();
    ss.socket.close();
  });
});
