/**
 * The log sanitiser: what must never reach a line, and what must survive.
 * The setup file mocks the logger module for every other suite; this one
 * needs the real thing.
 */

import { describe, expect, it, vi } from "vitest";

vi.unmock("../../utils/logger");

describe("sanitizeLogValue", () => {
  it("redacts ids, tokens, urls, emails and uuids of any version, and keeps the request fields", async () => {
    const { sanitizeLogValue } = await vi.importActual<typeof import("../../utils/logger")>("../../utils/logger");
    const out = sanitizeLogValue({
      requestId: "req-abcdef12",
      route: "/v1/conversations/:id/events",
      method: "POST",
      status: 200,
      durationMs: 12.5,
      count: 3,
      kind: "app_message",
      conversationId: "0192f7a0-1234-7abc-8def-0123456789ab",
      instanceId: "abc",
      token: "very-secret",
      signature: "sig",
      pushToken: "tok",
      payload: "ciphertext",
      note: "user 507f1f77bcf86cd799439011 signed in with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc from 10.0.0.1 and mailto a@b.co and https://user:pw@h.example/x and id 0192f7a0-1234-7abc-8def-0123456789ab",
    }) as Record<string, unknown>;
    expect(out.requestId).toBe("req-abcdef12");
    expect(out.route).toBe("/v1/conversations/:id/events");
    expect(out.method).toBe("POST");
    expect(out.status).toBe(200);
    expect(out.durationMs).toBe(12.5);
    expect(out.count).toBe(3);
    expect(out.kind).toBe("app_message");
    for (const key of ["conversationId", "instanceId", "token", "signature", "pushToken", "payload"]) {
      expect(out[key]).toBe("[REDACTED]");
    }
    const note = String(out.note);
    expect(note).not.toContain("507f1f77bcf86cd799439011");
    expect(note).not.toContain("eyJ");
    expect(note).not.toContain("10.0.0.1");
    expect(note).not.toContain("a@b.co");
    expect(note).not.toContain("user:pw");
    expect(note).not.toContain("0192f7a0-1234-7abc-8def-0123456789ab");
  });

  it("survives errors, cycles, buffers and depth", async () => {
    const { sanitizeLogValue } = await vi.importActual<typeof import("../../utils/logger")>("../../utils/logger");
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const error = new Error("token=abc failed for 507f1f77bcf86cd799439011");
    const out = sanitizeLogValue({ cyclic, error, bytes: Buffer.from("secret"), deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } }) as Record<string, unknown>;
    expect((out.cyclic as Record<string, unknown>).self).toBe("[Circular]");
    expect(String((out.error as Record<string, unknown>).message)).not.toContain("abc");
    expect(String((out.error as Record<string, unknown>).message)).not.toContain("507f1f77bcf86cd799439011");
    expect(out.bytes).toBe("[Bytes 6]");
    expect(JSON.stringify(out.deep)).toContain("[Truncated]");
  });
});
