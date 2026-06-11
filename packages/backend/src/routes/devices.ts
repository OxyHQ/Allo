import { Router, Response } from "express";
import type { Namespace } from "socket.io";
import Device from "../models/Device";
import MessageEnvelope from "../models/MessageEnvelope";
import PushToken from "../models/PushToken";
import { AuthRequest } from "../middleware/auth";
import { getAuthenticatedUserId } from "../utils/auth";
import { sendErrorResponse, sendSuccessResponse, validateRequired } from "../utils/apiHelpers";
import type { DeviceTarget } from "@allo/shared-types";
import {
  DEVICE_DELETE_DAYS,
  DEVICE_INACTIVE_DAYS,
  DEVICE_NAME_MAX_LENGTH,
  PREKEY_BATCH_MAX_TARGETS,
  daysAgo,
  isActiveDevice,
} from "../config/multiDevice";

const router = Router();

/**
 * Resolve the Socket.IO `/messaging` namespace, or null when sockets aren't
 * wired (e.g. unit tests). Mirrors the helper in routes/messages.ts so every
 * route resolves it the same way.
 */
function getMessagingNamespace(): Namespace | null {
  const io = (global as { io?: { of: (nsp: string) => Namespace } }).io;
  return io ? io.of("/messaging") : null;
}

/** Build the per-device room name used to address a single device. */
function deviceRoom(userId: string, deviceId: number): string {
  return `device:${userId}:${deviceId}`;
}

const PUSH_TOKEN_TYPES = ["fcm", "apns", "unknown"] as const;
type PushTokenType = (typeof PUSH_TOKEN_TYPES)[number];

const PUSH_PLATFORMS = ["android", "ios", "unknown"] as const;
type PushPlatform = (typeof PUSH_PLATFORMS)[number];

function coercePushTokenType(value: unknown): PushTokenType {
  return typeof value === "string" && (PUSH_TOKEN_TYPES as readonly string[]).includes(value)
    ? (value as PushTokenType)
    : "unknown";
}

function coercePushPlatform(value: unknown): PushPlatform {
  // Map RN's Platform.OS ("ios" | "android" | "web") onto stored platforms.
  if (value === "ios" || value === "android") return value;
  return "unknown";
}

/** A complete X3DH prekey bundle handed to a sender for one recipient device. */
interface PreKeyBundle {
  userId: string;
  deviceId: number;
  identityKeyPublic: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  registrationId: number;
  preKey: { keyId: number; publicKey: string } | null;
  remainingPreKeys: number;
}

const VALID_PLATFORMS = ["ios", "android", "web"] as const;
type DevicePlatform = (typeof VALID_PLATFORMS)[number];

function sanitizeDeviceName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, DEVICE_NAME_MAX_LENGTH);
}

function sanitizePlatform(value: unknown): DevicePlatform | undefined {
  return typeof value === "string" && (VALID_PLATFORMS as readonly string[]).includes(value)
    ? (value as DevicePlatform)
    : undefined;
}

/** True when a thrown error is a MongoDB duplicate-key (E11000) error. */
function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === 11000
  );
}

/**
 * Consume a complete X3DH prekey bundle for one device, atomically removing at
 * most one one-time prekey so it can never be handed out twice. Returns null if
 * the device does not exist. Shared by the single and batch prekey endpoints.
 */
async function consumePreKeyBundle(
  userId: string,
  deviceId: number
): Promise<PreKeyBundle | null> {
  const device = await Device.findOne(
    { userId, deviceId },
    { identityKeyPublic: 1, signedPreKey: 1, registrationId: 1, preKeys: 1, deviceId: 1 }
  ).lean();

  if (!device) return null;

  let consumedPreKey: { keyId: number; publicKey: string } | null = null;

  if (device.preKeys && device.preKeys.length > 0) {
    const candidate = device.preKeys[0];
    // Atomically remove the prekey we are handing out. If another caller wins
    // the race, `updated` is null and we fall back to no OPK (still a valid
    // X3DH bundle, just weaker forward secrecy for the first message).
    const updated = await Device.findOneAndUpdate(
      { userId, deviceId, "preKeys.keyId": candidate.keyId },
      { $pull: { preKeys: { keyId: candidate.keyId } } },
      { new: false }
    ).lean();
    if (updated) {
      consumedPreKey = { keyId: candidate.keyId, publicKey: candidate.publicKey };
    }
  }

  return {
    userId,
    deviceId: device.deviceId,
    identityKeyPublic: device.identityKeyPublic,
    signedPreKey: device.signedPreKey,
    registrationId: device.registrationId,
    preKey: consumedPreKey,
    remainingPreKeys: Math.max(0, (device.preKeys?.length || 0) - (consumedPreKey ? 1 : 0)),
  };
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

    const devices = await Device.find({ userId })
      .select("-preKeys") // Don't return preKeys in list (they're fetched separately)
      .sort({ deviceId: 1 })
      .lean();

    return sendSuccessResponse(res, 200, { devices });
  } catch (err) {
    console.error("[Devices] Error fetching devices:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch devices");
  }
});

/**
 * POST /api/devices/prekeys/batch
 *
 * Fetch X3DH prekey bundles for many recipient devices at once (multi-device
 * fan-out). Body: { targets: DeviceTarget[] } (cap PREKEY_BATCH_MAX_TARGETS).
 * Each bundle consumes at most one one-time prekey atomically, exactly like the
 * single-device endpoint. Targets without a registered device are returned in
 * `missing` so the caller can drop them.
 *
 * NOTE: registered BEFORE the parameterized `/:deviceId` routes so the literal
 * path is matched first.
 */
router.post("/prekeys/batch", async (req: AuthRequest, res: Response) => {
  try {
    getAuthenticatedUserId(req); // throws if not authenticated
    const { targets } = req.body as { targets?: unknown };

    if (!Array.isArray(targets)) {
      return sendErrorResponse(res, 400, "Bad Request", "targets array is required");
    }
    if (targets.length === 0) {
      return sendErrorResponse(res, 400, "Bad Request", "targets array must not be empty");
    }
    if (targets.length > PREKEY_BATCH_MAX_TARGETS) {
      return sendErrorResponse(
        res,
        413,
        "Payload Too Large",
        `Too many targets (max ${PREKEY_BATCH_MAX_TARGETS})`
      );
    }

    // Sanitize + de-duplicate (userId, deviceId) pairs.
    const seen = new Set<string>();
    const cleanTargets: DeviceTarget[] = [];
    for (const t of targets) {
      if (!t || typeof t !== "object") continue;
      const candidate = t as { userId?: unknown; deviceId?: unknown };
      const deviceId = Number(candidate.deviceId);
      if (
        typeof candidate.userId !== "string" ||
        candidate.userId.length === 0 ||
        !Number.isInteger(deviceId) ||
        deviceId < 1
      ) {
        return sendErrorResponse(
          res,
          400,
          "Bad Request",
          "Each target must have a non-empty userId and a positive integer deviceId"
        );
      }
      const key = `${candidate.userId}:${deviceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cleanTargets.push({ userId: candidate.userId, deviceId });
    }

    const bundles: PreKeyBundle[] = [];
    const missing: DeviceTarget[] = [];

    // Consume sequentially so concurrent OPK $pull operations on the same device
    // (e.g. duplicate targets across callers) stay race-safe and ordered.
    for (const target of cleanTargets) {
      const bundle = await consumePreKeyBundle(target.userId, target.deviceId);
      if (bundle) {
        bundles.push(bundle);
      } else {
        missing.push(target);
      }
    }

    return sendSuccessResponse(res, 200, { bundles, missing });
  } catch (err) {
    console.error("[Devices] Error fetching batch prekeys:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch batch prekeys");
  }
});

/**
 * POST /api/devices/push-token
 *
 * Register (or refresh) a push notification token for the authenticated user
 * and optionally link it to a Signal device. Body:
 *   { token, type?, platform?, locale?, signalDeviceId? }
 *
 * `signalDeviceId` (optional, numeric) is stored in the existing string
 * `deviceId` field so future device-targeted pushes are possible. Delivery
 * logic is unchanged. Registered BEFORE the parameterized `/:deviceId` routes.
 */
router.post("/push-token", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { token, type, platform, locale, signalDeviceId } = req.body as {
      token?: unknown;
      type?: unknown;
      platform?: unknown;
      locale?: unknown;
      signalDeviceId?: unknown;
    };

    if (typeof token !== "string" || token.length === 0) {
      return sendErrorResponse(res, 400, "Bad Request", "token is required");
    }

    // Ownership guard: a push token may only be (re)registered by the user it
    // already belongs to. Without this, any authenticated user could claim
    // another user's token and hijack their notifications.
    const existing = await PushToken.findOne({ token }, { userId: 1 }).lean();
    if (existing && existing.userId && existing.userId !== userId) {
      return sendErrorResponse(res, 409, "Conflict", "Token registered to another user");
    }

    const update: {
      userId: string;
      type: PushTokenType;
      platform: PushPlatform;
      enabled: boolean;
      lastSeenAt: Date;
      locale?: string;
      deviceId?: string;
    } = {
      userId,
      type: coercePushTokenType(type),
      platform: coercePushPlatform(platform),
      enabled: true,
      lastSeenAt: new Date(),
    };

    if (typeof locale === "string" && locale.length > 0) {
      update.locale = locale;
    }

    // Link to the Signal device id when provided (stored as string).
    const numericSignalDeviceId = Number(signalDeviceId);
    if (
      signalDeviceId !== undefined &&
      Number.isInteger(numericSignalDeviceId) &&
      numericSignalDeviceId >= 1
    ) {
      update.deviceId = String(numericSignalDeviceId);
    }

    // Scope the upsert to the caller (or an orphan row) so a cross-user steal is
    // impossible even if a concurrent request races past the pre-check above. If
    // another user owns the token, the scoped filter matches nothing and the
    // upsert hits the unique `token` index, surfaced below as a 409.
    try {
      const pushToken = await PushToken.findOneAndUpdate(
        { token, $or: [{ userId }, { userId: { $exists: false } }] },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      return sendSuccessResponse(res, 200, pushToken);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return sendErrorResponse(res, 409, "Conflict", "Token registered to another user");
      }
      throw err;
    }
  } catch (err) {
    console.error("[Devices] Error registering push token:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to register push token");
  }
});

/**
 * DELETE /api/devices/push-token
 * Unregister a push token (disables it). Body: { token }.
 * Registered BEFORE the parameterized `/:deviceId` routes.
 */
router.delete("/push-token", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { token } = req.body as { token?: unknown };

    if (typeof token !== "string" || token.length === 0) {
      return sendErrorResponse(res, 400, "Bad Request", "token is required");
    }

    // Ownership guard: only disable a token if it belongs to the caller. A token
    // owned by another user must not be touched (notification-hijack defense).
    const existing = await PushToken.findOne({ token }, { userId: 1 }).lean();
    if (existing && existing.userId && existing.userId !== userId) {
      return sendErrorResponse(res, 409, "Conflict", "Token registered to another user");
    }

    // Scoped to the caller so it can never disable someone else's token.
    await PushToken.updateOne({ token, userId }, { $set: { enabled: false } });

    return sendSuccessResponse(res, 200, { token, disabled: true });
  } catch (err) {
    console.error("[Devices] Error unregistering push token:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to unregister push token");
  }
});

/**
 * GET /api/devices/:deviceId
 * Get a specific device by deviceId
 */
router.get("/:deviceId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { deviceId } = req.params;

    const validationError = validateRequired(deviceId, "deviceId");
    if (validationError) {
      return sendErrorResponse(res, 400, "Bad Request", validationError);
    }

    const device = await Device.findOne({
      userId,
      deviceId: Number(deviceId),
    }).lean();

    if (!device) {
      return sendErrorResponse(res, 404, "Not Found", "Device not found");
    }

    return sendSuccessResponse(res, 200, device);
  } catch (err) {
    console.error("[Devices] Error fetching device:", err);
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
    const {
      deviceId,
      identityKeyPublic,
      signedPreKey,
      preKeys,
      registrationId,
      deviceName,
      platform,
    } = req.body;

    if (!deviceId || !identityKeyPublic || !signedPreKey || !preKeys || !registrationId) {
      return sendErrorResponse(
        res,
        400,
        "Bad Request",
        "Missing required fields: deviceId, identityKeyPublic, signedPreKey, preKeys, registrationId"
      );
    }

    const cleanDeviceName = sanitizeDeviceName(deviceName);
    const cleanPlatform = sanitizePlatform(platform);

    // Check if device already exists
    const existing = await Device.findOne({ userId, deviceId: Number(deviceId) });
    if (existing) {
      // Identity-change detection: if a device re-registers with a DIFFERENT
      // identity key than the one on file, the security code for this device has
      // changed (re-install, key wipe, or — worst case — an impersonation
      // attempt). Warn the user's own sessions so they can surface a "security
      // code changed" notice. The overwrite is still allowed for now; identity
      // pinning in `decryptFromPeer` is the planned Phase B hardening.
      if (existing.identityKeyPublic !== identityKeyPublic) {
        console.warn(
          `[Devices] Identity key changed for user ${userId} device ${deviceId}; ` +
            "overwriting (Phase B will pin identities)"
        );
        const messagingNamespace = getMessagingNamespace();
        if (messagingNamespace) {
          messagingNamespace
            .to(`user:${userId}`)
            .emit("deviceIdentityChanged", { userId, deviceId: Number(deviceId) });
        }
      }

      // Update existing device
      existing.identityKeyPublic = identityKeyPublic;
      existing.signedPreKey = signedPreKey;
      existing.preKeys = preKeys;
      existing.registrationId = registrationId;
      if (cleanDeviceName !== undefined) existing.deviceName = cleanDeviceName;
      if (cleanPlatform !== undefined) existing.platform = cleanPlatform;
      existing.lastSeen = new Date();
      await existing.save();
      return sendSuccessResponse(res, 200, existing);
    }

    // Create new device
    const device = await Device.create({
      userId,
      deviceId: Number(deviceId),
      identityKeyPublic,
      signedPreKey,
      preKeys,
      registrationId,
      deviceName: cleanDeviceName,
      platform: cleanPlatform,
      lastSeen: new Date(),
    });

    return sendSuccessResponse(res, 201, device);
  } catch (err) {
    console.error("[Devices] Error registering device:", err);
    if (isDuplicateKeyError(err)) {
      return sendErrorResponse(res, 409, "Conflict", "Device already exists");
    }
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
    const { deviceId } = req.params;
    const { identityKeyPublic, signedPreKey, preKeys, registrationId } = req.body;

    const device = await Device.findOne({
      userId,
      deviceId: Number(deviceId),
    });

    if (!device) {
      return sendErrorResponse(res, 404, "Not Found", "Device not found");
    }

    // Identity-change detection (mirrors POST /): if this update swaps the
    // identity key for a DIFFERENT one, the device's security code has changed.
    // Warn the user's own sessions before overwriting so the same
    // `deviceIdentityChanged` signal fires regardless of which endpoint the
    // client used to re-key. Overwrite is still allowed (Phase B will pin).
    if (identityKeyPublic && device.identityKeyPublic !== identityKeyPublic) {
      console.warn(
        `[Devices] Identity key changed for user ${userId} device ${deviceId}; ` +
          "overwriting (Phase B will pin identities)"
      );
      const messagingNamespace = getMessagingNamespace();
      if (messagingNamespace) {
        messagingNamespace
          .to(`user:${userId}`)
          .emit("deviceIdentityChanged", { userId, deviceId: Number(deviceId) });
      }
    }

    if (identityKeyPublic) device.identityKeyPublic = identityKeyPublic;
    if (signedPreKey) device.signedPreKey = signedPreKey;
    if (preKeys) device.preKeys = preKeys;
    if (registrationId) device.registrationId = registrationId;
    device.lastSeen = new Date();

    await device.save();
    return sendSuccessResponse(res, 200, device);
  } catch (err) {
    console.error("[Devices] Error updating device:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to update device");
  }
});

/**
 * DELETE /api/devices/:deviceId
 *
 * Revoke (unlink) a device. The auth middleware scopes every query to the
 * authenticated user, so a caller can only ever revoke devices on their OWN
 * account. Revocation is a full cascade:
 *
 *   1. Delete the Device row (its keys can no longer be used for X3DH).
 *   2. Delete every undelivered/queued MessageEnvelope addressed to that device
 *      (nothing should be hydrated for a device that no longer exists).
 *   3. Disable any PushToken linked to that Signal device id so it stops
 *      receiving notifications.
 *   4. Emit `device:revoked` to the device's room, then disconnect that room's
 *      sockets so the revoked client tears down and re-initializes.
 *   5. Emit `deviceListChanged` to the user room so the owner's OTHER devices
 *      refresh their linked-devices list and re-cache the fan-out targets.
 *
 * Self-revocation (revoking the device whose `X-Device-Id` matches) is allowed:
 * it acts as a remote wipe of the current device. The client handles
 * `device:revoked` by wiping its Signal state and re-registering as a brand-new
 * device, so the account is never left without a usable device.
 */
router.delete("/:deviceId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { deviceId } = req.params;

    const numericDeviceId = Number(deviceId);
    if (!Number.isInteger(numericDeviceId) || numericDeviceId < 1) {
      return sendErrorResponse(res, 400, "Bad Request", "Invalid deviceId");
    }

    const result = await Device.findOneAndDelete({
      userId,
      deviceId: numericDeviceId,
    });

    if (!result) {
      return sendErrorResponse(res, 404, "Not Found", "Device not found");
    }

    // Cascade: drop this device's queued envelopes and disable its push token(s).
    // Both are best-effort relative to the device deletion that already
    // succeeded; a failure here must not leave the device half-revoked, so log
    // and continue rather than aborting.
    const [envelopeResult, pushResult] = await Promise.allSettled([
      MessageEnvelope.deleteMany({ recipientUserId: userId, recipientDeviceId: numericDeviceId }),
      PushToken.updateMany(
        { userId, deviceId: String(numericDeviceId) },
        { $set: { enabled: false } }
      ),
    ]);
    if (envelopeResult.status === "rejected") {
      console.error("[Devices] Failed to delete envelopes on revocation:", envelopeResult.reason);
    }
    if (pushResult.status === "rejected") {
      console.error("[Devices] Failed to disable push tokens on revocation:", pushResult.reason);
    }

    // Notify the revoked device and the owner's other devices, then evict the
    // revoked device's sockets so it can no longer use the (now stale) session.
    const messagingNamespace = getMessagingNamespace();
    if (messagingNamespace) {
      const room = deviceRoom(userId, numericDeviceId);
      messagingNamespace.to(room).emit("device:revoked", { deviceId: numericDeviceId });
      messagingNamespace.to(`user:${userId}`).emit("deviceListChanged", { userId });
      // Disconnect after emitting so the revoked client receives `device:revoked`
      // before its transport is closed.
      try {
        messagingNamespace.in(room).disconnectSockets(true);
      } catch (err) {
        console.error("[Devices] Failed to disconnect revoked device sockets:", err);
      }
    }

    return sendSuccessResponse(res, 200, { success: true });
  } catch (err) {
    console.error("[Devices] Error deleting device:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to delete device");
  }
});

/**
 * GET /api/devices/user/:userId
 * Get the public devices for a specific user (for multi-device key exchange).
 *
 * Returns public info only (no preKeys). Devices stale beyond DEVICE_DELETE_DAYS
 * are lazily hard-deleted and excluded. Devices inactive beyond
 * DEVICE_INACTIVE_DAYS are excluded from `devices` (the set callers should
 * encrypt to) but surfaced under `inactiveDevices` so clients can distinguish a
 * dormant device from an unknown one. Pass `?includeInactive=true` to also get
 * inactive devices merged into `devices`.
 */
router.get("/user/:userId", async (req: AuthRequest, res: Response) => {
  try {
    const { userId } = req.params;

    const validationError = validateRequired(userId, "userId");
    if (validationError) {
      return sendErrorResponse(res, 400, "Bad Request", validationError);
    }

    const includeInactive = req.query.includeInactive === "true";
    const now = new Date();
    const deleteCutoff = daysAgo(DEVICE_DELETE_DAYS, now);
    const inactiveCutoff = daysAgo(DEVICE_INACTIVE_DAYS, now);

    // Lazily prune devices that have been silent past the delete horizon. Their
    // keys are stale and would only cause undecryptable fan-out.
    await Device.deleteMany({ userId, lastSeen: { $lt: deleteCutoff } });

    // Return public info only (for key exchange). preKeys are fetched separately.
    // createdAt is included so the shared activity rule can fall back to it for a
    // freshly-registered device that hasn't reported a lastSeen yet.
    const allDevices = await Device.find({ userId })
      .select(
        "deviceId identityKeyPublic signedPreKey registrationId deviceName platform lastSeen createdAt"
      )
      .sort({ deviceId: 1 })
      .lean();

    // Use the shared activity rule (lastSeen, falling back to createdAt) so this
    // endpoint and the fan-out consistency check agree on what "active" means.
    const active = allDevices.filter((d) => isActiveDevice(d, inactiveCutoff));
    const inactive = allDevices.filter((d) => !isActiveDevice(d, inactiveCutoff));

    return sendSuccessResponse(res, 200, {
      devices: includeInactive ? allDevices : active,
      inactiveDevices: inactive,
    });
  } catch (err) {
    console.error("[Devices] Error fetching user devices:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch user devices");
  }
});

/**
 * GET /api/devices/user/:userId/prekeys/:deviceId
 *
 * Returns a complete prekey bundle for X3DH: identity key, signed prekey and
 * AT MOST ONE one-time prekey. The OPK (if any) is atomically removed from the
 * device document so it can never be handed out twice.
 */
router.get("/user/:userId/prekeys/:deviceId", async (req: AuthRequest, res: Response) => {
  try {
    const { userId, deviceId } = req.params;

    const numericDeviceId = Number(deviceId);
    if (!Number.isInteger(numericDeviceId) || numericDeviceId < 1) {
      return sendErrorResponse(res, 400, "Bad Request", "Invalid deviceId");
    }

    // Atomically consume a complete X3DH bundle (at most one OPK), shared with
    // the batch endpoint so single and batch fan-out behave identically.
    const bundle = await consumePreKeyBundle(userId, numericDeviceId);
    if (!bundle) {
      return sendErrorResponse(res, 404, "Not Found", "Device not found");
    }

    return sendSuccessResponse(res, 200, bundle);
  } catch (err) {
    console.error("[Devices] Error fetching preKeys:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch preKeys");
  }
});

/**
 * POST /api/devices/:deviceId/prekeys
 *
 * Replenish one-time prekeys for the authenticated user's device. Body:
 *   { preKeys: [{ keyId, publicKey }, ...] }
 *
 * Existing prekeys are kept; duplicates (same keyId) are ignored.
 */
router.post("/:deviceId/prekeys", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { deviceId } = req.params;
    const { preKeys } = req.body as {
      preKeys?: Array<{ keyId: number; publicKey: string }>;
    };

    if (!Array.isArray(preKeys) || preKeys.length === 0) {
      return sendErrorResponse(res, 400, "Bad Request", "preKeys array is required");
    }

    const sanitized = preKeys
      .filter(
        (k) =>
          k &&
          typeof k.keyId === "number" &&
          typeof k.publicKey === "string" &&
          k.publicKey.length > 0
      )
      .map((k) => ({ keyId: k.keyId, publicKey: k.publicKey }));

    if (sanitized.length === 0) {
      return sendErrorResponse(res, 400, "Bad Request", "No valid prekeys provided");
    }

    const device = await Device.findOne({ userId, deviceId: Number(deviceId) });
    if (!device) {
      return sendErrorResponse(res, 404, "Not Found", "Device not found");
    }

    const existing = new Set((device.preKeys || []).map((k) => k.keyId));
    const fresh = sanitized.filter((k) => !existing.has(k.keyId));
    if (fresh.length > 0) {
      device.preKeys = [...(device.preKeys || []), ...fresh];
      device.lastSeen = new Date();
      await device.save();
    }

    return sendSuccessResponse(res, 200, {
      added: fresh.length,
      total: device.preKeys.length,
    });
  } catch (err) {
    console.error("[Devices] Error replenishing prekeys:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to replenish prekeys");
  }
});

export default router;

