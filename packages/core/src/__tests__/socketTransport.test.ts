import { describe, expect, it, vi } from "vitest";

/**
 * The production socket must never use HTTP long-polling: the API runs on
 * several tasks behind one load balancer without sticky sessions, and a
 * polling `sid` bound to one task is answered 400 by the other. Measured on
 * allo.you on 2026-09-18 (`/socket.io/?EIO=4&transport=polling&sid=…` → 400).
 */
const captured: Array<{ url: string; options: Record<string, unknown> }> = [];
vi.mock("socket.io-client", () => ({
  io: (url: string, options: Record<string, unknown>) => {
    captured.push({ url, options });
    return { on() {}, off() {}, emit() {}, connect() {}, disconnect() {}, connected: false };
  },
}));

describe("defaultSocketFactory", () => {
  it("opens a WebSocket-only socket that never falls back to polling", async () => {
    const { defaultSocketFactory } = await import("../transport/socket");
    defaultSocketFactory("https://api.example/v1", async () => ({ token: "t", instanceId: "i", timestamp: 1, signature: "s" }));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.options.transports).toEqual(["websocket"]);
    expect(captured[0]!.options.upgrade).toBe(false);
    expect(captured[0]!.options.autoConnect).toBe(false);
  });
});
