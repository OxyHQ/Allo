import crypto from "crypto";
import {
  buildCanonicalString,
  buildMediaCanonicalString,
  hmacHex,
  timingSafeEqualHex,
  verifyInboundJson,
  signOutboundJson,
  signOutboundMedia,
  isTimestampFresh,
} from "../signing";
import { BRIDGE_TIMESTAMP_TOLERANCE_MS } from "../config";
import { signJson, TEST_BRIDGE_SECRET, TEST_BRIDGE_SECRET_TOO_SHORT } from "./helpers/fixtures";

/**
 * Proves the connector's signing is byte-identical to the Allo backend's. The
 * canonical strings and HMACs are recomputed here with a SEPARATE expression (raw
 * `crypto.createHmac(...)`, matching the backend's own test helper) so a drift in
 * either side fails this test loudly.
 */
describe("signing — canonical strings (backend parity)", () => {
  it("builds the JSON canonical string exactly as the backend documents", () => {
    const c = buildCanonicalString("post", "/commands", "1700000000000", '{"a":1}');
    expect(c).toBe("POST./commands.1700000000000.{\"a\":1}");
  });

  it("builds the media canonical string with the fixed action tag and no body", () => {
    const c = buildMediaCanonicalString("POST", "/internal/bridge/media", "1700000000000");
    expect(c).toBe("POST./internal/bridge/media.1700000000000.media-upload");
  });

  it("hmacHex matches an independent crypto computation", () => {
    const canonical = "POST./commands.123.body";
    const expected = crypto.createHmac("sha256", "secret").update(canonical).digest("hex");
    expect(hmacHex("secret", canonical)).toBe(expected);
  });

  it("timingSafeEqualHex is true for equal strings and false (not throwing) for unequal lengths", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "ab")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
  });
});

describe("signing — outbound (connector -> Allo) verifiable by the backend's vectors", () => {
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  beforeEach(() => {
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
  });
  afterEach(() => {
    process.env.BRIDGE_SHARED_SECRET = prevSecret;
  });

  it("signOutboundJson produces a signature the backend's signEvents formula reproduces", () => {
    const path = "/internal/bridge/events";
    const rawBody = JSON.stringify({ v: 1, type: "session_status" });
    const { timestamp, signature } = signOutboundJson("POST", path, rawBody);
    // The backend recomputes with the same formula; equality proves parity.
    expect(signature).toBe(signJson(timestamp, path, rawBody));
  });

  it("signOutboundMedia produces a signature matching the backend's media formula", () => {
    const path = "/internal/bridge/media";
    const { timestamp, signature } = signOutboundMedia("POST", path);
    const expected = crypto
      .createHmac("sha256", TEST_BRIDGE_SECRET)
      .update(`POST.${path}.${timestamp}.media-upload`)
      .digest("hex");
    expect(signature).toBe(expected);
  });

  it("throws when the secret is unset/too short", () => {
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET_TOO_SHORT;
    expect(() => signOutboundJson("POST", "/commands", "{}")).toThrow();
  });
});

describe("signing — inbound verification (Allo -> connector)", () => {
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  beforeEach(() => {
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
  });
  afterEach(() => {
    process.env.BRIDGE_SHARED_SECRET = prevSecret;
  });

  it("accepts a request signed by the backend's helper over the SAME path/body", () => {
    const path = "/commands";
    const rawBody = JSON.stringify({ v: 1, type: "send", network: "telegram" });
    const ts = String(Date.now());
    const result = verifyInboundJson({
      method: "POST",
      path,
      rawBody,
      timestampHeader: ts,
      signatureHeader: signJson(ts, path, rawBody),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a signature computed for a DIFFERENT path (cross-endpoint replay)", () => {
    const rawBody = JSON.stringify({ v: 1 });
    const ts = String(Date.now());
    const sigForOther = signJson(ts, "/sessions/telegram/link", rawBody);
    const result = verifyInboundJson({
      method: "POST",
      path: "/commands",
      rawBody,
      timestampHeader: ts,
      signatureHeader: sigForOther,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a stale timestamp", () => {
    const path = "/commands";
    const rawBody = "{}";
    const staleTs = String(Date.now() - (BRIDGE_TIMESTAMP_TOLERANCE_MS + 60_000));
    const result = verifyInboundJson({
      method: "POST",
      path,
      rawBody,
      timestampHeader: staleTs,
      signatureHeader: signJson(staleTs, path, rawBody),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a future timestamp", () => {
    const path = "/commands";
    const rawBody = "{}";
    const futureTs = String(Date.now() + (BRIDGE_TIMESTAMP_TOLERANCE_MS + 60_000));
    const result = verifyInboundJson({
      method: "POST",
      path,
      rawBody,
      timestampHeader: futureTs,
      signatureHeader: signJson(futureTs, path, rawBody),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects missing headers", () => {
    const result = verifyInboundJson({
      method: "POST",
      path: "/commands",
      rawBody: "{}",
      timestampHeader: undefined,
      signatureHeader: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("returns 500 when the secret is too short (treated as not configured)", () => {
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET_TOO_SHORT;
    const path = "/commands";
    const rawBody = "{}";
    const ts = String(Date.now());
    const result = verifyInboundJson({
      method: "POST",
      path,
      rawBody,
      timestampHeader: ts,
      signatureHeader: signJson(ts, path, rawBody, "POST", TEST_BRIDGE_SECRET_TOO_SHORT),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(500);
  });

  it("isTimestampFresh respects the ±tolerance window", () => {
    const now = 1_000_000_000_000;
    expect(isTimestampFresh(now, now)).toBe(true);
    expect(isTimestampFresh(now - BRIDGE_TIMESTAMP_TOLERANCE_MS, now)).toBe(true);
    expect(isTimestampFresh(now - BRIDGE_TIMESTAMP_TOLERANCE_MS - 1, now)).toBe(false);
    expect(isTimestampFresh(now + BRIDGE_TIMESTAMP_TOLERANCE_MS + 1, now)).toBe(false);
  });
});
