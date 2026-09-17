/**
 * Instance binding: proving a request comes from one specific enrolled
 * installation of the Oxy account that is signed in.
 *
 * Mounted AFTER Oxy auth. Reads `X-Allo-Instance`, `X-Allo-Timestamp` and
 * `X-Allo-Signature`, rebuilds `signedRequestMessage()` from the method, the
 * request target exactly as sent (`req.originalUrl`), the header timestamp and
 * the SHA-256 of the raw body bytes the parser stashed on `req.rawBody`, and
 * verifies the Ed25519 signature against the instance's stored public key.
 *
 * Order of checks and their codes, from `docs/platform/api-v1.md`:
 *   1. headers well-formed, timestamp within `MAX_CLOCK_SKEW_MS` — `unauthorized`
 *   2. instance exists — `unauthorized`; `pending` — `instance_not_active`;
 *      `revoked` — `instance_revoked`; another account's — `forbidden`
 *   3. signature verifies — else `unauthorized`
 *
 * The signature is checked LAST on purpose: it is the expensive step, and a
 * stale or foreign request never gets to spend it.
 *
 * ## Ed25519 with `node:crypto` alone
 *
 * The stored key is the raw 32 bytes. `crypto.verify` wants a KeyObject or a
 * DER, so the raw key is wrapped in the 12-byte SubjectPublicKeyInfo prefix for
 * the Ed25519 OID (`302a300506032b6570032100`) and imported as `spki`. No
 * dependency, and no key ever has to be re-encoded at rest.
 */

import { createHash, verify as verifySignature } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getRequiredOxyUserId } from "@oxy.so/core/server";
import {
  INSTANCE_HEADER,
  MAX_CLOCK_SKEW_MS,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  ed25519SignatureSchema,
  instanceIdSchema,
  signedRequestMessage,
} from "@allo/shared-types";
import { findInstanceById, touchLastSeen, type InstanceRow } from "../db/platform/instanceRepository";
import { getDb, type AlloDatabase } from "../db";
import { logger } from "../utils/logger";
import { AlloHttpError, forbidden, unauthorized } from "../utils/httpErrors";

/** What a route learns about the caller once the signature has verified. */
export interface AuthenticatedInstance {
  id: string;
  accountId: string;
  appId: string;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RAW_KEY_LENGTH = 32;

/** Wrap a raw 32-byte Ed25519 public key as SPKI DER. Returns null on any other length. */
export function spkiFromRawEd25519(rawBase64: string): Buffer | null {
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== RAW_KEY_LENGTH) return null;
  return Buffer.concat([ED25519_SPKI_PREFIX, raw]);
}

/** Ed25519 over the UTF-8 bytes of `message`; false on any malformed input rather than a throw. */
export function verifyEd25519(message: string, signatureBase64: string, publicKeyBase64: string): boolean {
  const spki = spkiFromRawEd25519(publicKeyBase64);
  if (!spki) return false;
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== 64) return false;
  try {
    return verifySignature(null, Buffer.from(message, "utf8"), { key: spki, format: "der", type: "spki" }, signature);
  } catch {
    return false;
  }
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The body bytes a signature covers: what the parser stashed, or nothing. */
export function rawBodyOf(req: Request): Buffer {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  return Buffer.alloc(0);
}

const TIMESTAMP_PATTERN = /^\d{1,16}$/;

export interface InstanceAuthDeps {
  /** Late-bound so the middleware can be built before the pool is open. */
  getDb?: () => AlloDatabase;
  now?: () => number;
  /** Look the instance up; injectable for tests that need no database. */
  findInstance?: (id: string) => Promise<InstanceRow | null>;
}

/**
 * Outcome of the check as data, so the Socket.IO handshake can run the same
 * verification with `pathWithQuery = "/socket"` and an empty body.
 */
export async function authenticateInstance(
  input: {
    accountId: string;
    instanceId: unknown;
    timestamp: unknown;
    signature: unknown;
    method: string;
    pathWithQuery: string;
    bodySha256Hex: string;
  },
  deps: InstanceAuthDeps = {},
): Promise<AuthenticatedInstance> {
  const now = deps.now ?? Date.now;
  const findInstance = deps.findInstance ?? ((id: string) => findInstanceById(id, (deps.getDb ?? getDb)()));

  const instanceId = instanceIdSchema.safeParse(input.instanceId);
  const signature = ed25519SignatureSchema.safeParse(input.signature);
  const timestampText = typeof input.timestamp === "number" ? String(input.timestamp) : input.timestamp;
  if (!instanceId.success || !signature.success || typeof timestampText !== "string" || !TIMESTAMP_PATTERN.test(timestampText)) {
    throw unauthorized("Instance signature headers are missing or malformed");
  }
  const timestampMs = Number(timestampText);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
    throw unauthorized("Instance signature timestamp is outside the accepted window");
  }

  const instance = await findInstance(instanceId.data);
  if (!instance) throw unauthorized("Unknown instance");
  if (instance.accountId !== input.accountId) throw forbidden("The instance belongs to another account");
  if (instance.status === "pending") throw new AlloHttpError("instance_not_active", "The instance is awaiting approval");
  if (instance.status === "revoked") throw new AlloHttpError("instance_revoked", "The instance was revoked");

  const message = signedRequestMessage({
    method: input.method,
    pathWithQuery: input.pathWithQuery,
    timestampMs,
    bodySha256Hex: input.bodySha256Hex,
  });
  if (!verifyEd25519(message, signature.data, instance.signingPublicKey)) {
    throw unauthorized("Instance signature does not verify");
  }
  return { id: instance.id, accountId: instance.accountId, appId: instance.appId };
}

/** The HTTP middleware. Sets `req.instance` and touches `last_seen_at` (best effort). */
export function requireInstance(deps: InstanceAuthDeps = {}): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    void (async () => {
      const accountId = getRequiredOxyUserId(req);
      const instance = await authenticateInstance(
        {
          accountId,
          instanceId: req.get(INSTANCE_HEADER),
          timestamp: req.get(TIMESTAMP_HEADER),
          signature: req.get(SIGNATURE_HEADER),
          method: req.method,
          pathWithQuery: req.originalUrl,
          bodySha256Hex: sha256Hex(rawBodyOf(req)),
        },
        deps,
      );
      req.instance = instance;
      touchLastSeen(instance.id, (deps.getDb ?? getDb)()).catch((error: unknown) => {
        logger.debug("last_seen_at update failed", error);
      });
    })().then(() => next(), next);
  };
}

/** For a route behind {@link requireInstance}: the instance, or a 500 if the mount order is wrong. */
export function getRequiredInstance(req: Request): AuthenticatedInstance {
  if (!req.instance) {
    throw new Error("requireInstance() did not run ahead of this route");
  }
  return req.instance;
}
