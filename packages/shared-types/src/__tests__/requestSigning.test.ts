import { describe, expect, it } from "vitest";
import { EMPTY_BODY_SHA256_HEX } from "../common";
import {
  INSTANCE_HEADER,
  MAX_CLOCK_SKEW_MS,
  REQUEST_SIGNING_CONTEXT,
  SIGNATURE_HEADER,
  signedRequestMessage,
  SOCKET_SIGNING_PATH,
  socketAuthSchema,
  TIMESTAMP_HEADER,
} from "../requestSigning";
import { SIGNATURE, UUID_V7 } from "./fixtures";

describe("constants", () => {
  it("are the documented values", () => {
    expect(INSTANCE_HEADER).toBe("x-allo-instance");
    expect(TIMESTAMP_HEADER).toBe("x-allo-timestamp");
    expect(SIGNATURE_HEADER).toBe("x-allo-signature");
    expect(REQUEST_SIGNING_CONTEXT).toBe("allo-v1");
    expect(MAX_CLOCK_SKEW_MS).toBe(300_000);
    expect(SOCKET_SIGNING_PATH).toBe("/socket");
  });
});

describe("signedRequestMessage", () => {
  it("is byte-exact and upper-cases the method", () => {
    const message = signedRequestMessage({
      method: "post",
      pathWithQuery: "/v1/sync?cursor=MA&limit=50",
      timestampMs: 1758104430123,
      bodySha256Hex: EMPTY_BODY_SHA256_HEX,
    });
    expect(message).toBe(
      "allo-v1\nPOST\n/v1/sync?cursor=MA&limit=50\n1758104430123\n" + EMPTY_BODY_SHA256_HEX,
    );
  });
  it("signs the socket handshake over GET /socket with the empty-body digest", () => {
    expect(
      signedRequestMessage({ method: "GET", pathWithQuery: SOCKET_SIGNING_PATH, timestampMs: 0, bodySha256Hex: EMPTY_BODY_SHA256_HEX }),
    ).toBe("allo-v1\nGET\n/socket\n0\n" + EMPTY_BODY_SHA256_HEX);
  });
  it("refuses inputs no well-formed request produces", () => {
    const ok = { method: "GET", pathWithQuery: "/v1/x", timestampMs: 1, bodySha256Hex: EMPTY_BODY_SHA256_HEX };
    expect(() => signedRequestMessage({ ...ok, pathWithQuery: "v1/x" })).toThrow(RangeError);
    expect(() => signedRequestMessage({ ...ok, method: "" })).toThrow(RangeError);
    expect(() => signedRequestMessage({ ...ok, timestampMs: 1.5 })).toThrow(RangeError);
    expect(() => signedRequestMessage({ ...ok, timestampMs: -1 })).toThrow(RangeError);
    expect(() => signedRequestMessage({ ...ok, bodySha256Hex: EMPTY_BODY_SHA256_HEX.toUpperCase() })).toThrow(RangeError);
  });
});

describe("socketAuthSchema", () => {
  it("accepts the three fields", () => {
    expect(socketAuthSchema.safeParse({ instanceId: UUID_V7, timestamp: 1758104430123, signature: SIGNATURE }).success).toBe(true);
  });
  it("rejects a string timestamp, a missing signature and a token-shaped extra", () => {
    expect(socketAuthSchema.safeParse({ instanceId: UUID_V7, timestamp: "1758104430123", signature: SIGNATURE }).success).toBe(false);
    expect(socketAuthSchema.safeParse({ instanceId: UUID_V7, timestamp: 1 }).success).toBe(false);
    expect(socketAuthSchema.safeParse({ instanceId: "", timestamp: 1, signature: SIGNATURE }).success).toBe(false);
  });
});
