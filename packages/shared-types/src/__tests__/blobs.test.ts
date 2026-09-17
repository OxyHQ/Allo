import { describe, expect, it } from "vitest";
import { BLOB_CONTENT_TYPE, BLOB_SHA256_HEADER, DEFAULT_MAX_BLOB_BYTES, uploadBlobResponseSchema } from "../blobs";
import { BLOB_HEX_ID, UUID_V7 } from "./fixtures";

describe("blobs", () => {
  it("constants", () => {
    expect(BLOB_SHA256_HEADER).toBe("x-allo-blob-sha256");
    expect(BLOB_CONTENT_TYPE).toBe("application/octet-stream");
    expect(DEFAULT_MAX_BLOB_BYTES).toBe(26_214_400);
  });
  it("upload response takes a hex or uuid id and a size", () => {
    expect(uploadBlobResponseSchema.safeParse({ blobId: BLOB_HEX_ID, size: 10 }).success).toBe(true);
    expect(uploadBlobResponseSchema.safeParse({ blobId: UUID_V7, size: 0 }).success).toBe(true);
    expect(uploadBlobResponseSchema.safeParse({ blobId: UUID_V7, size: -1 }).success).toBe(false);
    expect(uploadBlobResponseSchema.safeParse({ blobId: "", size: 1 }).success).toBe(false);
  });
});
