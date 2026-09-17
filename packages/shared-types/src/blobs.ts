/**
 * Blobs: opaque encrypted bytes, uploaded raw and referenced from events.
 * The server checks only size and digest; the key travels inside a `media`
 * app message the server cannot read.
 */
import { z } from "zod";
import { blobIdSchema, nonNegativeIntSchema } from "./common";

/** Request header on `POST /v1/blobs`: lowercase hex SHA-256 of the body. */
export const BLOB_SHA256_HEADER = "x-allo-blob-sha256";

export const BLOB_CONTENT_TYPE = "application/octet-stream";

export const DEFAULT_MAX_BLOB_BYTES = 25 * 1024 * 1024;

export const uploadBlobResponseSchema = z.object({
  blobId: blobIdSchema,
  size: nonNegativeIntSchema,
});
export type UploadBlobResponse = z.infer<typeof uploadBlobResponseSchema>;
