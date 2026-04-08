import UserBehavior from '../models/UserBehavior';
import mongoose from 'mongoose';

/**
 * UserPreferenceService - Legacy social media feature service
 *
 * TODO: This service is for social media features (Posts, Likes, Bookmarks)
 * which don't exist in this messaging app. Either delete this file or
 * implement it properly for messaging-specific features.
 *
 * Current status: Stubbed out to fix TypeScript compilation errors.
 * The service is not used anywhere in the codebase.
 */
export class UserPreferenceService {
  /**
   * Placeholder method - not implemented
   */
  async recordInteraction(
    userId: string,
    itemId: string,
    interactionType: string
  ): Promise<void> {
    // Not implemented - this is a stub
    console.warn('[UserPreferenceService] recordInteraction called but service is not implemented');
  }

  /**
   * Placeholder method - not implemented
   */
  async getUserPreferences(userId: string): Promise<any> {
    // Not implemented - this is a stub
    console.warn('[UserPreferenceService] getUserPreferences called but service is not implemented');
    return {};
  }
}

export default new UserPreferenceService();
