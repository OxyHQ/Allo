import { Router, Response } from "express";
import Device from "../models/Device";
import { AuthRequest } from "../middleware/auth";
import { getAuthenticatedUserId } from "../utils/auth";
import { sendErrorResponse, sendSuccessResponse, validateRequired } from "../utils/apiHelpers";

const router = Router();

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
    } = req.body;

    if (!deviceId || !identityKeyPublic || !signedPreKey || !preKeys || !registrationId) {
      return sendErrorResponse(
        res,
        400,
        "Bad Request",
        "Missing required fields: deviceId, identityKeyPublic, signedPreKey, preKeys, registrationId"
      );
    }

    // Check if device already exists
    const existing = await Device.findOne({ userId, deviceId: Number(deviceId) });
    if (existing) {
      // Update existing device
      existing.identityKeyPublic = identityKeyPublic;
      existing.signedPreKey = signedPreKey;
      existing.preKeys = preKeys;
      existing.registrationId = registrationId;
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
      lastSeen: new Date(),
    });

    return sendSuccessResponse(res, 201, device);
  } catch (err: any) {
    console.error("[Devices] Error registering device:", err);
    if (err.code === 11000) {
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
 * Remove a device
 */
router.delete("/:deviceId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { deviceId } = req.params;

    const result = await Device.findOneAndDelete({
      userId,
      deviceId: Number(deviceId),
    });

    if (!result) {
      return sendErrorResponse(res, 404, "Not Found", "Device not found");
    }

    return sendSuccessResponse(res, 200, { success: true });
  } catch (err) {
    console.error("[Devices] Error deleting device:", err);
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

    // Return public keys only (for key exchange)
    const devices = await Device.find({ userId })
      .select("deviceId identityKeyPublic signedPreKey registrationId")
      .sort({ deviceId: 1 })
      .lean();

    return sendSuccessResponse(res, 200, { devices });
  } catch (err) {
    console.error("[Devices] Error fetching user devices:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch user devices");
  }
});

/**
 * GET /api/devices/user/:userId/prekeys/:deviceId
 * Get preKeys for a specific device (for key exchange)
 */
router.get("/user/:userId/prekeys/:deviceId", async (req: AuthRequest, res: Response) => {
  try {
    const { userId, deviceId } = req.params;

    const device = await Device.findOne({
      userId,
      deviceId: Number(deviceId),
    }).select("preKeys").lean();

    if (!device) {
      return sendErrorResponse(res, 404, "Not Found", "Device not found");
    }

    return sendSuccessResponse(res, 200, { preKeys: device.preKeys || [] });
  } catch (err) {
    console.error("[Devices] Error fetching preKeys:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch preKeys");
  }
});

export default router;

