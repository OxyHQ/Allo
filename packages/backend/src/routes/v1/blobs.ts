/**
 * Blobs. The READ lives with the other JSON routes; the UPLOAD is raw bytes
 * and is assembled in `app.ts` ahead of the JSON parser, with its own
 * middleware chain: Oxy auth → size-capped `express.raw` → instance signature
 * (over the bytes) → handler. `createBlobUploadHandler` is that handler.
 */

import express, { Router, type RequestHandler } from "express";
import { BLOB_CONTENT_TYPE, BLOB_SHA256_HEADER, blobIdSchema } from "@allo/shared-types";
import { getRequiredInstance } from "../../middleware/instanceAuth";
import { downloadBlob, uploadBlob } from "../../services/platform/blobService";
import { asyncRoute } from "./asyncRoute";
import { parseParam } from "./validate";

export function createBlobReadRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();
  router.get(
    "/blobs/:id",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const id = parseParam(blobIdSchema, req.params.id, "id");
      const bytes = await downloadBlob(id);
      res.setHeader("Content-Type", BLOB_CONTENT_TYPE);
      res.setHeader("Content-Length", String(bytes.length));
      res.end(bytes);
    }),
  );
  return router;
}

/**
 * `express.raw` bounded at `maxBytes`. body-parser compares `Content-Length`
 * against the limit BEFORE reading the stream, so an oversized upload is a
 * 413 that never buffers; the error handler maps it to `payload_too_large`.
 * The `verify` hook stashes the bytes where the signature check looks.
 */
export function createBlobBodyParser(maxBytes: number): RequestHandler {
  return express.raw({
    type: BLOB_CONTENT_TYPE,
    limit: maxBytes,
    verify: (req, _res, buf) => {
      Reflect.set(req, "rawBody", buf);
    },
  });
}

export function createBlobUploadHandler(options: { maxBytes: number }): RequestHandler {
  return asyncRoute(async (req, res) => {
    const me = getRequiredInstance(req);
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const declared = req.get(BLOB_SHA256_HEADER);
    const result = await uploadBlob(
      { instanceId: me.id, accountId: me.accountId },
      { bytes, declaredSha256: declared },
      { maxBytes: options.maxBytes },
    );
    res.status(201).json(result);
  });
}
