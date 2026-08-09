/**
 * The Signal Protocol device registry — on Postgres.
 *
 * Every handler reads and writes through `db/messaging/deviceRepository`, and
 * `utils/deviceDto.ts` is where a row becomes a response.
 *
 * ## What the port removes rather than reproduces
 *
 * - **The read-then-branch registration, and its 409.** `POST /` read the
 *   device, then either inserted or updated. Two registrations of the same
 *   device racing there both saw nothing and both inserted, and the loser got
 *   `409 Device already exists` for a request that was perfectly valid.
 *   `registerDevice` is one `ON CONFLICT (user_id, device_id) DO UPDATE`, so
 *   there is no window and no duplicate to report — which is why
 *   `isDuplicateKeyError` (a Mongo `code === 11000` predicate) goes with it. The
 *   201-vs-200 distinction now comes from `xmax`, i.e. from what the statement
 *   actually did, rather than from what a previous read happened to see.
 *
 * - **`.select("-preKeys")`.** One-time pre-keys are a child table now, and the
 *   list route's DTO type has no property to put them in. See `utils/deviceDto.ts`.
 *
 * ## What the port ADDS, and why it is not a new restriction
 *
 * Mongoose validated the key material (`keyId`/`registrationId` as numbers,
 * `publicKey`/`signature` as required strings, `deviceId` with `min: 1`) and
 * that validation does not survive the model. It is re-expressed here, at the
 * one place a device is written, because the columns are typed now: a string
 * where `signed_pre_key_id` wants an integer is a 500 from the driver rather
 * than a 400 anybody can act on.
 *
 * The path parameter is the sharper case. `Number("abc")` is `NaN`; Mongo
 * matched nothing and answered 404, whereas binding `NaN` to an `integer`
 * column is a driver error. So a malformed device id is now a 400 rather than a
 * 404 — the one deliberate response change in this file, and it cannot reach a
 * client that was sending a device number in the first place.
 *
 * `deviceId >= 1` has no CHECK on `devices` (its `messages.senderDeviceId`
 * counterpart does have `messages_sender_device_id_check`). Re-expressed here
 * rather than added as a constraint, because a constraint is a migration this
 * change does not otherwise need — recorded so the asymmetry is a known gap and
 * not a discovery.
 */

import { Router, Response } from "express";
import type { OxyAuthRequest as AuthRequest } from "@oxyhq/core/server";
import { getRequiredOxyUserId as getAuthenticatedUserId } from "@oxyhq/core/server";
import type { PreKey, SignedPreKey } from "@allo/shared-types";
import { getDb } from "../db";
import {
  deleteDevice,
  findDevice,
  findDevicePreKeys,
  listDeviceBundlesForUser,
  listDevicesForUser,
  registerDevice,
  updateDeviceKeys,
} from "../db/messaging/deviceRepository";
import {
  toDeviceDto,
  toDeviceWithPreKeysDto,
  toPublicDeviceBundle,
} from "../utils/deviceDto";
import { sendErrorResponse, sendSuccessResponse, validateRequired } from "../utils/apiHelpers";
import { logger } from "../utils/logger";

const router = Router();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An integer, from a number or the numeric string a path parameter carries. */
function parseInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Signal's device number: 1-based, which is Mongoose's `min: 1`. */
function parseSignalDeviceId(value: unknown): number | null {
  const parsed = parseInteger(value);
  return parsed !== null && parsed >= 1 ? parsed : null;
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseSignedPreKey(value: unknown): SignedPreKey | null {
  if (!isRecord(value)) return null;
  const keyId = parseInteger(value.keyId);
  const publicKey = parseNonEmptyString(value.publicKey);
  const signature = parseNonEmptyString(value.signature);
  if (keyId === null || publicKey === null || signature === null) return null;
  return { keyId, publicKey, signature };
}

/**
 * The whole one-time pre-key bundle, or `null` if ANY entry is malformed.
 *
 * All-or-nothing on purpose: these are replaced wholesale, so accepting the
 * parseable subset would silently register a device advertising fewer keys than
 * its client believes it published.
 */
function parsePreKeys(value: unknown): PreKey[] | null {
  if (!Array.isArray(value)) return null;
  const preKeys: PreKey[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const keyId = parseInteger(entry.keyId);
    const publicKey = parseNonEmptyString(entry.publicKey);
    if (keyId === null || publicKey === null) return null;
    preKeys.push({ keyId, publicKey });
  }
  return preKeys;
}

/**
 * Device Management API for Signal Protocol
 * All routes require authentication
 */

/**
 * GET /api/devices
 * Get all devices for the authenticated user
 */
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const devices = await listDevicesForUser(getDb(), userId);

    return sendSuccessResponse(res, 200, { devices: devices.map(toDeviceDto) });
  } catch (err) {
    logger.error("[Devices] Error fetching devices:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch devices");
  }
});

/**
 * GET /api/devices/:deviceId
 * Get a specific device by deviceId
 */
router.get("/:deviceId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const signalDeviceId = parseSignalDeviceId(req.params.deviceId);

    if (signalDeviceId === null) {
      return sendErrorResponse(res, 400, "Bad Request", "deviceId must be a positive integer");
    }

    const device = await findDevice(getDb(), userId, signalDeviceId);

    if (!device) {
      return sendErrorResponse(res, 404, "Not Found", "Device not found");
    }

    return sendSuccessResponse(res, 200, toDeviceWithPreKeysDto(device));
  } catch (err) {
    logger.error("[Devices] Error fetching device:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch device");
  }
});

/**
 * POST /api/devices
 * Register a new device with Signal Protocol keys
 */
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const body: unknown = req.body;
    const source = isRecord(body) ? body : {};

    const deviceId = parseSignalDeviceId(source.deviceId);
    const identityKeyPublic = parseNonEmptyString(source.identityKeyPublic);
    const signedPreKey = parseSignedPreKey(source.signedPreKey);
    const preKeys = parsePreKeys(source.preKeys);
    const registrationId = parseInteger(source.registrationId);

    if (
      deviceId === null ||
      identityKeyPublic === null ||
      signedPreKey === null ||
      preKeys === null ||
      registrationId === null
    ) {
      return sendErrorResponse(
        res,
        400,
        "Bad Request",
        "Missing or invalid fields: deviceId, identityKeyPublic, signedPreKey, preKeys, registrationId"
      );
    }

    const { device, created } = await registerDevice(getDb(), {
      userId,
      deviceId,
      identityKeyPublic,
      signedPreKey,
      preKeys,
      registrationId,
    });

    return sendSuccessResponse(res, created ? 201 : 200, toDeviceWithPreKeysDto(device));
  } catch (err: unknown) {
    logger.error("[Devices] Error registering device:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to register device");
  }
});

/**
 * PUT /api/devices/:deviceId
 * Update device keys
 */
router.put("/:deviceId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const signalDeviceId = parseSignalDeviceId(req.params.deviceId);

    if (signalDeviceId === null) {
      return sendErrorResponse(res, 400, "Bad Request", "deviceId must be a positive integer");
    }

    const body: unknown = req.body;
    const source = isRecord(body) ? body : {};

    /**
     * Each field is applied only when the caller SENDS it, which is what the
     * `if (identityKeyPublic)` guards did. A field that is present but
     * malformed is refused rather than skipped: skipping it would answer 200 to
     * a request that changed nothing the caller asked for.
     */
    const patch: {
      identityKeyPublic?: string;
      signedPreKey?: SignedPreKey;
      registrationId?: number;
      preKeys?: PreKey[];
    } = {};

    if (source.identityKeyPublic !== undefined) {
      const identityKeyPublic = parseNonEmptyString(source.identityKeyPublic);
      if (identityKeyPublic === null) {
        return sendErrorResponse(res, 400, "Bad Request", "identityKeyPublic must be a non-empty string");
      }
      patch.identityKeyPublic = identityKeyPublic;
    }

    if (source.signedPreKey !== undefined) {
      const signedPreKey = parseSignedPreKey(source.signedPreKey);
      if (signedPreKey === null) {
        return sendErrorResponse(res, 400, "Bad Request", "signedPreKey must carry keyId, publicKey and signature");
      }
      patch.signedPreKey = signedPreKey;
    }

    if (source.registrationId !== undefined) {
      const registrationId = parseInteger(source.registrationId);
      if (registrationId === null) {
        return sendErrorResponse(res, 400, "Bad Request", "registrationId must be an integer");
      }
      patch.registrationId = registrationId;
    }

    if (source.preKeys !== undefined) {
      const preKeys = parsePreKeys(source.preKeys);
      if (preKeys === null) {
        return sendErrorResponse(res, 400, "Bad Request", "preKeys must be an array of {keyId, publicKey}");
      }
      patch.preKeys = preKeys;
    }

    const device = await updateDeviceKeys(getDb(), userId, signalDeviceId, patch);

    if (!device) {
      return sendErrorResponse(res, 404, "Not Found", "Device not found");
    }

    return sendSuccessResponse(res, 200, toDeviceWithPreKeysDto(device));
  } catch (err) {
    logger.error("[Devices] Error updating device:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to update device");
  }
});

/**
 * DELETE /api/devices/:deviceId
 * Remove a device
 */
router.delete("/:deviceId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const signalDeviceId = parseSignalDeviceId(req.params.deviceId);

    if (signalDeviceId === null) {
      return sendErrorResponse(res, 400, "Bad Request", "deviceId must be a positive integer");
    }

    const removed = await deleteDevice(getDb(), userId, signalDeviceId);

    if (!removed) {
      return sendErrorResponse(res, 404, "Not Found", "Device not found");
    }

    return sendSuccessResponse(res, 200, { success: true });
  } catch (err) {
    logger.error("[Devices] Error deleting device:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to delete device");
  }
});

/**
 * GET /api/devices/user/:userId
 * Get all devices for a specific user (for key exchange)
 */
router.get("/user/:userId", async (req: AuthRequest, res: Response) => {
  try {
    const { userId } = req.params;

    const validationError = validateRequired(userId, "userId");
    if (validationError) {
      return sendErrorResponse(res, 400, "Bad Request", validationError);
    }

    const devices = await listDeviceBundlesForUser(getDb(), userId);

    return sendSuccessResponse(res, 200, { devices: devices.map(toPublicDeviceBundle) });
  } catch (err) {
    logger.error("[Devices] Error fetching user devices:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch user devices");
  }
});

/**
 * GET /api/devices/user/:userId/prekeys/:deviceId
 * Get preKeys for a specific device (for key exchange)
 */
router.get("/user/:userId/prekeys/:deviceId", async (req: AuthRequest, res: Response) => {
  try {
    const { userId } = req.params;
    const signalDeviceId = parseSignalDeviceId(req.params.deviceId);

    const validationError = validateRequired(userId, "userId");
    if (validationError) {
      return sendErrorResponse(res, 400, "Bad Request", validationError);
    }

    if (signalDeviceId === null) {
      return sendErrorResponse(res, 400, "Bad Request", "deviceId must be a positive integer");
    }

    // `null` is "no such device" and `[]` is "this device has none left" — the
    // repository keeps them apart so only the first is a 404.
    const preKeys = await findDevicePreKeys(getDb(), userId, signalDeviceId);

    if (preKeys === null) {
      return sendErrorResponse(res, 404, "Not Found", "Device not found");
    }

    return sendSuccessResponse(res, 200, { preKeys });
  } catch (err) {
    logger.error("[Devices] Error fetching preKeys:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch preKeys");
  }
});

export default router;
