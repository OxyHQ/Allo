import { describe, expect, it } from "vitest";
import {
  APP_MESSAGE_VERSION,
  AppMessageDecodeError,
  appMessageSchema,
  decodeAppMessage,
  encodeAppMessage,
  eventRefSchema,
  MAX_TEXT_BODY_LENGTH,
  type AppMessage,
  type EventRef,
} from "../appMessage";
import { PUBKEY, SHA256, UUID_V7 } from "./fixtures";

const ref: EventRef = { kind: "event", conversationId: UUID_V7, eventId: UUID_V7 };
const local: EventRef = { kind: "local", conversationId: UUID_V7, idempotencyKey: "m-1" };

const media: AppMessage = {
  v: 1,
  t: "media",
  blobId: UUID_V7,
  key: PUBKEY,
  nonce: Buffer.alloc(12, 9).toString("base64"),
  sha256: SHA256,
  mime: "image/jpeg",
  filename: "cat.jpg",
  size: 12345,
  kind: "image",
  width: 640,
  height: 480,
  thumbnail: { blobId: UUID_V7, key: PUBKEY, nonce: Buffer.alloc(12, 8).toString("base64"), sha256: SHA256, width: 64, height: 48 },
};

const valid: AppMessage[] = [
  { v: 1, t: "text", body: "hola" },
  { v: 1, t: "text", body: "hola", replyTo: local },
  { v: 1, t: "edit", target: ref, body: "hola!" },
  { v: 1, t: "delete", target: ref },
  { v: 1, t: "reaction", target: ref, key: "👍", op: "add" },
  { v: 1, t: "read", upTo: ref },
  { v: 1, t: "delivered", upTo: ref },
  { v: 1, t: "delivered", upTo: local },
  media,
  { v: 1, t: "conversation", name: "Familia" },
  { v: 1, t: "conversation" },
  { v: 1, t: "typing", on: true },
];

describe("eventRefSchema", () => {
  it("takes an event ref or a local ref", () => {
    expect(eventRefSchema.safeParse(ref).success).toBe(true);
    expect(eventRefSchema.safeParse(local).success).toBe(true);
  });
  it("rejects a ref with both keys under the wrong kind, and one with neither", () => {
    expect(eventRefSchema.safeParse({ kind: "event", conversationId: UUID_V7, idempotencyKey: "m-1" }).success).toBe(false);
    expect(eventRefSchema.safeParse({ conversationId: UUID_V7, eventId: UUID_V7 }).success).toBe(false);
  });
});

describe("appMessageSchema", () => {
  it("accepts every kind", () => {
    for (const m of valid) expect(appMessageSchema.safeParse(m).success, m.t).toBe(true);
  });
  it("rejects wrong v, unknown t, and a field of the wrong kind", () => {
    expect(APP_MESSAGE_VERSION).toBe(1);
    expect(appMessageSchema.safeParse({ v: 2, t: "text", body: "x" }).success).toBe(false);
    expect(appMessageSchema.safeParse({ v: "1", t: "text", body: "x" }).success).toBe(false);
    expect(appMessageSchema.safeParse({ v: 1, t: "sticker", id: "x" }).success).toBe(false);
    expect(appMessageSchema.safeParse({ v: 1, t: "text" }).success).toBe(false);
    expect(appMessageSchema.safeParse({ v: 1, t: "text", body: "" }).success).toBe(false);
    expect(appMessageSchema.safeParse({ v: 1, t: "text", body: "x".repeat(MAX_TEXT_BODY_LENGTH + 1) }).success).toBe(false);
    expect(appMessageSchema.safeParse({ v: 1, t: "reaction", target: ref, key: "👍", op: "toggle" }).success).toBe(false);
    expect(appMessageSchema.safeParse({ v: 1, t: "typing", on: "yes" }).success).toBe(false);
    expect(appMessageSchema.safeParse({ v: 1, t: "delivered" }).success).toBe(false);
    expect(appMessageSchema.safeParse({ v: 1, t: "delivered", upTo: UUID_V7 }).success).toBe(false);
    expect(appMessageSchema.safeParse({ v: 2, t: "delivered", upTo: ref }).success).toBe(false);
    expect(appMessageSchema.safeParse({ ...media, kind: "gif" }).success).toBe(false);
    expect(appMessageSchema.safeParse({ ...media, key: "short" }).success).toBe(false);
    expect(appMessageSchema.safeParse({ ...media, sha256: SHA256.toUpperCase() }).success).toBe(false);
  });
});

describe("encode / decode", () => {
  it("round-trips every kind as UTF-8 JSON", () => {
    for (const m of valid) {
      const bytes = encodeAppMessage(m);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(JSON.parse(Buffer.from(bytes).toString("utf8"))).toEqual(m);
      expect(decodeAppMessage(bytes)).toEqual(m);
    }
  });
  it("a delivered receipt round-trips, and an unknown t still fails", () => {
    const m: AppMessage = { v: 1, t: "delivered", upTo: ref };
    const decoded = decodeAppMessage(encodeAppMessage(m));
    expect(decoded).toEqual(m);
    expect(decoded.t).toBe("delivered");
    expect(() => decodeAppMessage(new TextEncoder().encode(JSON.stringify({ v: 1, t: "acked", upTo: ref })))).toThrow(
      AppMessageDecodeError,
    );
  });
  it("keeps non-ASCII text intact", () => {
    const m: AppMessage = { v: 1, t: "text", body: "ñandú 🦤 日本" };
    expect(decodeAppMessage(encodeAppMessage(m))).toEqual(m);
  });
  it("decode rejects unknown t, wrong v, non-JSON and non-UTF-8", () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(() => decodeAppMessage(enc({ v: 1, t: "sticker" }))).toThrow(AppMessageDecodeError);
    expect(() => decodeAppMessage(enc({ v: 2, t: "text", body: "x" }))).toThrow(AppMessageDecodeError);
    expect(() => decodeAppMessage(new TextEncoder().encode("{not json"))).toThrow(AppMessageDecodeError);
    expect(() => decodeAppMessage(new Uint8Array([0xff, 0xfe, 0x7b]))).toThrow(AppMessageDecodeError);
    expect(() => decodeAppMessage(enc("a string"))).toThrow(AppMessageDecodeError);
  });
  it("encode refuses an invalid envelope so it is never encrypted", () => {
    expect(() => encodeAppMessage({ v: 1, t: "text", body: "" })).toThrow(AppMessageDecodeError);
    expect(() => encodeAppMessage({ v: 1, t: "nope" } as unknown as AppMessage)).toThrow(AppMessageDecodeError);
  });
  it("the error is named and carries a cause", () => {
    try {
      decodeAppMessage(new TextEncoder().encode("[]"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppMessageDecodeError);
      expect((e as Error).name).toBe("AppMessageDecodeError");
      expect((e as { cause?: unknown }).cause).toBeDefined();
    }
  });
});
