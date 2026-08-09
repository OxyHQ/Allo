/**
 * Profile settings, blocks and restricts — on Postgres.
 *
 * Every handler here reads and writes through `db/social/*`. The shape a client
 * receives is unchanged; `utils/userSettings.ts` is where the flat row becomes
 * the nested document and where a request body becomes a column patch.
 *
 * ## Two things the port removes rather than reproduces
 *
 * - **The duplicate-key `catch`.** `POST /blocks` used to read, insert, and keep
 *   a `code === 11000` handler behind both as a net — three places deciding one
 *   answer, with a window between the read and the write where two concurrent
 *   requests both saw nothing. `blockUser` is one statement converging on
 *   `blocks_user_id_blocked_id_key`, and the boolean it returns IS the 201-vs-200
 *   distinction. A real failure still throws instead of being read as a duplicate.
 *
 * - **`$set: { appearance: … }` replacing the whole sub-document.** Mongoose
 *   assigned an `appearance` object, so a request carrying only `primaryColor`
 *   silently reset `themeMode` to its default — and the app sends exactly that
 *   (`stores/appearanceStore.ts` PUTs `partial.appearance`, one field at a time).
 *   Columns are patched individually, so an unmentioned setting is now left
 *   alone. This is a deliberate divergence, not an oversight: the alternative is
 *   re-implementing a data-losing side effect of a document store on purpose.
 */

import { Router, Response } from 'express';
import { requireOxyAuth as requireAuth, type OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId as getAuthenticatedUserId } from '@oxyhq/core/server';
import { getDb } from '../db';
import { blockUser, listBlockedUserIds, unblockUser } from '../db/social/blockRepository';
import {
  listRestrictedUserIds,
  restrictUser,
  unrestrictUser,
} from '../db/social/restrictRepository';
import { deleteUserBehavior } from '../db/social/userBehaviorRepository';
import { ensureUserSettings, updateUserSettings } from '../db/social/userSettingsRepository';
import { readUserSettingsPatch, toUserSettingsDto } from '../utils/userSettings';
import { sendErrorResponse, sendSuccessResponse, validateRequired } from '../utils/apiHelpers';

const router = Router();

/**
 * Profile Settings API
 * All routes require authentication
 */

// Apply auth middleware to all routes
router.use(requireAuth);

/**
 * GET /api/profile/settings/me
 * Get current user's settings
 */
router.get('/settings/me', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const row = await ensureUserSettings(getDb(), oxyUserId);
    return sendSuccessResponse(res, 200, toUserSettingsDto(row));
  } catch (err) {
    console.error('[ProfileSettings] Error fetching my settings:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch settings');
  }
});

/**
 * GET /api/profile/settings/:userId
 * Get settings by oxy user id
 */
router.get('/settings/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const { userId } = req.params;

    const validationError = validateRequired(userId, 'userId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const row = await ensureUserSettings(getDb(), userId);
    return sendSuccessResponse(res, 200, toUserSettingsDto(row));
  } catch (err) {
    console.error('[ProfileSettings] Error fetching user settings:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch settings');
  }
});

/**
 * PUT /api/profile/settings
 * Update current user's settings
 */
router.put('/settings', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const row = await updateUserSettings(getDb(), oxyUserId, readUserSettingsPatch(req.body));
    return sendSuccessResponse(res, 200, toUserSettingsDto(row));
  } catch (err) {
    console.error('[ProfileSettings] Error updating settings:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to update settings');
  }
});

/**
 * DELETE /api/profile/settings/behavior
 * Reset user behavior/preferences
 */
router.delete('/settings/behavior', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const deleted = await deleteUserBehavior(getDb(), oxyUserId);

    return sendSuccessResponse(
      res,
      200,
      { success: true },
      deleted ? 'Personalization data reset successfully' : 'No personalization data to reset'
    );
  } catch (err) {
    console.error('[ProfileSettings] Error resetting user behavior:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to reset personalization data');
  }
});

/**
 * Block management endpoints
 */

router.get('/blocks', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const blockedUsers = await listBlockedUserIds(getDb(), oxyUserId);

    return sendSuccessResponse(res, 200, { blockedUsers });
  } catch (err) {
    console.error('[ProfileSettings] Error fetching blocked users:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch blocked users');
  }
});

router.post('/blocks', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const { blockedId } = req.body;

    const validationError = validateRequired(blockedId, 'blockedId');
    if (validationError || typeof blockedId !== 'string') {
      return sendErrorResponse(res, 400, 'Bad Request', 'Missing or invalid blockedId');
    }

    if (oxyUserId === blockedId) {
      return sendErrorResponse(res, 400, 'Bad Request', 'Cannot block yourself');
    }

    const created = await blockUser(getDb(), { userId: oxyUserId, blockedId });
    if (!created) {
      return sendSuccessResponse(res, 200, { success: true }, 'User already blocked');
    }

    return sendSuccessResponse(res, 201, { success: true }, 'User blocked successfully');
  } catch (err: unknown) {
    console.error('[ProfileSettings] Error blocking user:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to block user');
  }
});

router.delete('/blocks/:blockedId', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const { blockedId } = req.params;

    const validationError = validateRequired(blockedId, 'blockedId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const removed = await unblockUser(getDb(), { userId: oxyUserId, blockedId });

    if (!removed) {
      return sendErrorResponse(res, 404, 'Not Found', 'Block not found');
    }

    return sendSuccessResponse(res, 200, { success: true }, 'User unblocked successfully');
  } catch (err) {
    console.error('[ProfileSettings] Error unblocking user:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to unblock user');
  }
});

/**
 * Restricted users management endpoints
 */

router.get('/restricts', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const restrictedUsers = await listRestrictedUserIds(getDb(), oxyUserId);

    return sendSuccessResponse(res, 200, { restrictedUsers });
  } catch (err) {
    console.error('[ProfileSettings] Error fetching restricted users:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to fetch restricted users');
  }
});

router.post('/restricts', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const { restrictedId } = req.body;

    const validationError = validateRequired(restrictedId, 'restrictedId');
    if (validationError || typeof restrictedId !== 'string') {
      return sendErrorResponse(res, 400, 'Bad Request', 'Missing or invalid restrictedId');
    }

    if (oxyUserId === restrictedId) {
      return sendErrorResponse(res, 400, 'Bad Request', 'Cannot restrict yourself');
    }

    const created = await restrictUser(getDb(), { userId: oxyUserId, restrictedId });
    if (!created) {
      return sendSuccessResponse(res, 200, { success: true }, 'User already restricted');
    }

    return sendSuccessResponse(res, 201, { success: true }, 'User restricted successfully');
  } catch (err: unknown) {
    console.error('[ProfileSettings] Error restricting user:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to restrict user');
  }
});

router.delete('/restricts/:restrictedId', async (req: AuthRequest, res: Response) => {
  try {
    const oxyUserId = getAuthenticatedUserId(req);
    const { restrictedId } = req.params;

    const validationError = validateRequired(restrictedId, 'restrictedId');
    if (validationError) {
      return sendErrorResponse(res, 400, 'Bad Request', validationError);
    }

    const removed = await unrestrictUser(getDb(), { userId: oxyUserId, restrictedId });

    if (!removed) {
      return sendErrorResponse(res, 404, 'Not Found', 'Restrict not found');
    }

    return sendSuccessResponse(res, 200, { success: true }, 'User unrestricted successfully');
  } catch (err) {
    console.error('[ProfileSettings] Error unrestricting user:', err);
    return sendErrorResponse(res, 500, 'Internal Server Error', 'Failed to unrestrict user');
  }
});

export default router;
