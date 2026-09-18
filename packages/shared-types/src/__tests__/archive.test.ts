import { describe, expect, it } from "vitest";
import {
  ARCHIVE_CHUNK_AAD_PREFIX,
  ARCHIVE_CHUNK_MAX_BYTES,
  ARCHIVE_MANIFEST_SIGNING_CONTEXT,
  ARCHIVE_MAX_CHUNKS,
  ArchiveDecodeError,
  archiveChunkAad,
  archiveManifestMessage,
  archiveManifestSchema,
  archiveV1Schema,
  BACKUP_KDF_SALT,
  BACKUP_KEY_CHECK_MESSAGE,
  canonicalJson,
  decodeArchive,
  encodeArchive,
  HISTORY_KEY_SEAL_INFO,
  type Archive,
  type ArchiveManifest,
} from "../archive";
import { BLOB_HEX_ID, ISO, MANIFEST as manifest, OBJECT_ID, OBJECT_ID_2, PUBKEY, SHA256, UUID_V7 } from "./fixtures";

const NONCE = Buffer.alloc(12, 9).toString("base64");

const archive: Archive = {
  v: 1,
  createdAt: ISO,
  accountId: OBJECT_ID,
  appId: "allo",
  conversations: [
    { id: UUID_V7, kind: "dm", appId: "allo", title: null, memberAccountIds: [OBJECT_ID, OBJECT_ID_2], createdAt: ISO },
    { id: OBJECT_ID_2, kind: "group", appId: "allo", title: "Familia", memberAccountIds: [OBJECT_ID], createdAt: ISO },
  ],
  events: [
    {
      conversationId: UUID_V7,
      eventId: UUID_V7,
      seq: 1,
      senderAccountId: OBJECT_ID_2,
      senderInstanceId: UUID_V7,
      sentAt: ISO,
      message: { v: 1, t: "text", body: "hola" },
    },
    {
      conversationId: UUID_V7,
      eventId: OBJECT_ID,
      seq: 2,
      senderAccountId: "allo:server",
      senderInstanceId: null,
      sentAt: ISO,
      message: { v: 1, t: "conversation", name: "Familia" },
    },
  ],
  mediaKeys: [
    { conversationId: UUID_V7, blobId: BLOB_HEX_ID, key: PUBKEY, nonce: NONCE, sha256: SHA256 },
    {
      conversationId: UUID_V7,
      blobId: BLOB_HEX_ID,
      key: PUBKEY,
      nonce: NONCE,
      sha256: SHA256,
      thumbnail: { blobId: UUID_V7, key: PUBKEY, nonce: NONCE, sha256: SHA256 },
    },
  ],
};

describe("constants", () => {
  it("pins the values other packages build crypto on", () => {
    expect(ARCHIVE_CHUNK_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(ARCHIVE_MAX_CHUNKS).toBe(512);
    expect(ARCHIVE_CHUNK_AAD_PREFIX).toBe("allo-archive-v1:");
    expect(HISTORY_KEY_SEAL_INFO).toBe("allo-history-key-v1");
    expect(BACKUP_KEY_CHECK_MESSAGE).toBe("allo-backup-key-check-v1");
    expect(BACKUP_KDF_SALT).toBe("allo-backup-v1");
    expect(ARCHIVE_MANIFEST_SIGNING_CONTEXT).toBe("allo-archive-manifest-v1");
  });
});

describe("archiveChunkAad", () => {
  it("is prefix + index/total, byte-exact", () => {
    expect(archiveChunkAad(3, 7)).toBe("allo-archive-v1:3/7");
    expect(archiveChunkAad(0, 1)).toBe("allo-archive-v1:0/1");
  });
  it("differs for every position, so a moved chunk fails to open", () => {
    const all = Array.from({ length: 5 }, (_, i) => archiveChunkAad(i, 5));
    expect(new Set(all).size).toBe(5);
    expect(archiveChunkAad(1, 5)).not.toBe(archiveChunkAad(1, 6));
  });
  it("refuses an index outside [0, total), a zero total and a float", () => {
    expect(() => archiveChunkAad(7, 7)).toThrow(RangeError);
    expect(() => archiveChunkAad(-1, 7)).toThrow(RangeError);
    expect(() => archiveChunkAad(0, 0)).toThrow(RangeError);
    expect(() => archiveChunkAad(1.5, 7)).toThrow(RangeError);
  });
});

describe("archiveV1Schema", () => {
  it("accepts a full archive and an empty one", () => {
    expect(archiveV1Schema.safeParse(archive).success).toBe(true);
    expect(
      archiveV1Schema.safeParse({ v: 1, createdAt: ISO, accountId: OBJECT_ID, appId: "allo", conversations: [], events: [], mediaKeys: [] })
        .success,
    ).toBe(true);
  });
  it("rejects a wrong v, a missing section, a bad conversation kind and an absent title", () => {
    expect(archiveV1Schema.safeParse({ ...archive, v: 2 }).success).toBe(false);
    const { mediaKeys: _omit, ...missing } = archive;
    expect(archiveV1Schema.safeParse(missing).success).toBe(false);
    expect(archiveV1Schema.safeParse({ ...archive, conversations: [{ ...archive.conversations[0], kind: "channel" }] }).success).toBe(false);
    const { title: _t, ...noTitle } = archive.conversations[0];
    expect(archiveV1Schema.safeParse({ ...archive, conversations: [noTitle] }).success).toBe(false);
  });
  it("an event's message must be an AppMessage: not ciphertext, not an unknown t", () => {
    const ev = archive.events[0];
    expect(archiveV1Schema.safeParse({ ...archive, events: [{ ...ev, message: "AAAA" }] }).success).toBe(false);
    expect(archiveV1Schema.safeParse({ ...archive, events: [{ ...ev, message: { v: 1, t: "sticker" } }] }).success).toBe(false);
    expect(archiveV1Schema.safeParse({ ...archive, events: [{ ...ev, message: { v: 2, t: "text", body: "x" } }] }).success).toBe(false);
    expect(archiveV1Schema.safeParse({ ...archive, events: [{ ...ev, senderInstanceId: undefined }] }).success).toBe(false);
  });
  it("a media key is a 44-char base64 key with a lowercase digest; the thumbnail is the same shape", () => {
    const mk = archive.mediaKeys[1];
    expect(archiveV1Schema.safeParse({ ...archive, mediaKeys: [{ ...mk, key: "short" }] }).success).toBe(false);
    expect(archiveV1Schema.safeParse({ ...archive, mediaKeys: [{ ...mk, sha256: SHA256.toUpperCase() }] }).success).toBe(false);
    expect(archiveV1Schema.safeParse({ ...archive, mediaKeys: [{ ...mk, thumbnail: { ...mk.thumbnail, key: "short" } }] }).success).toBe(
      false,
    );
  });
});

describe("encodeArchive / decodeArchive", () => {
  it("round-trips as UTF-8 JSON", () => {
    const bytes = encodeArchive(archive);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(Buffer.from(bytes).toString("utf8"))).toEqual(archive);
    expect(decodeArchive(bytes)).toEqual(archive);
  });
  it("decode rejects an event whose message is not an AppMessage", () => {
    const bad = { ...archive, events: [{ ...archive.events[0], message: { v: 1, t: "sticker", id: "x" } }] };
    const bytes = new TextEncoder().encode(JSON.stringify(bad));
    expect(() => decodeArchive(bytes)).toThrow(ArchiveDecodeError);
  });
  it("decode rejects non-JSON, non-UTF-8, a wrong v and a non-object", () => {
    expect(() => decodeArchive(new TextEncoder().encode("{not json"))).toThrow(ArchiveDecodeError);
    expect(() => decodeArchive(new Uint8Array([0xff, 0xfe, 0x7b]))).toThrow(ArchiveDecodeError);
    expect(() => decodeArchive(new TextEncoder().encode(JSON.stringify({ ...archive, v: 2 })))).toThrow(ArchiveDecodeError);
    expect(() => decodeArchive(new TextEncoder().encode("[]"))).toThrow(ArchiveDecodeError);
  });
  it("encode refuses an invalid archive so it is never encrypted, and the error is named with a cause", () => {
    try {
      encodeArchive({ ...archive, appId: "Not An App" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArchiveDecodeError);
      expect((e as Error).name).toBe("ArchiveDecodeError");
      expect((e as { cause?: unknown }).cause).toBeDefined();
    }
  });
});

describe("archiveManifestSchema", () => {
  it("accepts transfer and backup manifests", () => {
    expect(archiveManifestSchema.safeParse(manifest).success).toBe(true);
    expect(archiveManifestSchema.safeParse({ ...manifest, kind: "backup" }).success).toBe(true);
  });
  it("rejects an unknown kind, zero chunks, 513 chunks, an uppercase digest and a negative count", () => {
    expect(archiveManifestSchema.safeParse({ ...manifest, kind: "export" }).success).toBe(false);
    expect(archiveManifestSchema.safeParse({ ...manifest, chunkBlobIds: [] }).success).toBe(false);
    expect(archiveManifestSchema.safeParse({ ...manifest, chunkBlobIds: Array(ARCHIVE_MAX_CHUNKS).fill(UUID_V7) }).success).toBe(true);
    expect(archiveManifestSchema.safeParse({ ...manifest, chunkBlobIds: Array(ARCHIVE_MAX_CHUNKS + 1).fill(UUID_V7) }).success).toBe(false);
    expect(archiveManifestSchema.safeParse({ ...manifest, plaintextSha256: SHA256.toUpperCase() }).success).toBe(false);
    expect(archiveManifestSchema.safeParse({ ...manifest, eventCount: -1 }).success).toBe(false);
    expect(archiveManifestSchema.safeParse({ ...manifest, v: 2 }).success).toBe(false);
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively and emits no whitespace", () => {
    const out = canonicalJson({ b: 1, a: { z: [3, { y: 1, x: 2 }], m: "s" }, c: null });
    expect(out).toBe('{"a":{"m":"s","z":[3,{"x":2,"y":1}]},"b":1,"c":null}');
  });
  it("is stable under key insertion order", () => {
    const a = canonicalJson({ x: 1, y: { p: true, q: "z" } });
    const b = canonicalJson({ y: { q: "z", p: true }, x: 1 });
    expect(a).toBe(b);
  });
  it("omits undefined members, keeps arrays in place and escapes like JSON", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([2, 1, undefined])).toBe("[2,1,null]");
    expect(canonicalJson("ñ\"\n")).toBe(JSON.stringify("ñ\"\n"));
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(1.5)).toBe("1.5");
  });
  it("refuses what JSON cannot carry", () => {
    expect(() => canonicalJson(NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Infinity)).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
  it("re-parses to the same value", () => {
    expect(JSON.parse(canonicalJson(manifest))).toEqual(manifest);
  });
});

describe("archiveManifestMessage", () => {
  it("is byte-exact: context, LF, canonical JSON with sorted keys", () => {
    const message = archiveManifestMessage(manifest);
    expect(message).toBe(
      "allo-archive-manifest-v1\n" +
        '{"chunkBlobIds":["' +
        BLOB_HEX_ID +
        '","' +
        UUID_V7 +
        '"],"conversationCount":2,"createdAt":"' +
        ISO +
        '","eventCount":2,"kind":"transfer","plaintextSha256":"' +
        SHA256 +
        '","v":1}',
    );
    expect(message.split("\n")).toHaveLength(2);
  });
  it("does not depend on the producer's key order", () => {
    const shuffled = {
      plaintextSha256: manifest.plaintextSha256,
      v: manifest.v,
      chunkBlobIds: manifest.chunkBlobIds,
      kind: manifest.kind,
      eventCount: manifest.eventCount,
      createdAt: manifest.createdAt,
      conversationCount: manifest.conversationCount,
    } satisfies ArchiveManifest;
    expect(archiveManifestMessage(shuffled)).toBe(archiveManifestMessage(manifest));
  });
  it("changes with the kind, so a backup manifest cannot be replayed as a transfer", () => {
    expect(archiveManifestMessage({ ...manifest, kind: "backup" })).not.toBe(archiveManifestMessage(manifest));
  });
});
