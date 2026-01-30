import Conversation, { IConversation, ConversationType } from '../models/Conversation';
import { oxy } from '../../server';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

/**
 * Conversation Service Layer
 *
 * WhatsApp/Telegram-level: Business logic separated from routes
 * Benefits:
 * - Reusable code (use in routes, jobs, websockets)
 * - Easier testing (no need to mock Express)
 * - Single responsibility (routes handle HTTP, services handle business logic)
 * - Better error handling
 */

interface CreateConversationData {
  userId: string;
  type?: ConversationType;
  participantIds: string[];
  name?: string;
  description?: string;
  avatar?: string;
}

interface UpdateConversationData {
  name?: string;
  description?: string;
  avatar?: string;
}

interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export class ConversationService {
  /**
   * Enrich participants with Oxy user data
   * Optimized: Batch fetch all users at once (WhatsApp pattern)
   */
  private static async enrichParticipants(participants: any[]): Promise<any[]> {
    const userIds = Array.from(new Set(participants.map(p => p.userId).filter(Boolean)));
    if (userIds.length === 0) return participants;

    try {
      // Batch fetch all users in parallel (WhatsApp-style efficiency)
      const userPromises = userIds.map(userId =>
        oxy.getUserById(userId)
          .catch((error: any) => {
            if (error?.status === 404) {
              logger.debug(`Oxy user ${userId} not found`);
            } else {
              logger.error(`Error fetching Oxy user ${userId}:`, error);
            }
            return null;
          })
      );

      const users = await Promise.all(userPromises);
      const userMap = new Map(users.map((user, index) => [userIds[index], user]));

      // Enrich participants
      return participants.map(participant => {
        const oxyUser = userMap.get(participant.userId);
        if (!oxyUser) {
          return {
            ...participant,
            name: participant.name || { first: 'Unknown', last: '' },
            username: participant.username,
            avatar: participant.avatar,
          };
        }

        // Extract name from Oxy user
        let name = { first: '', last: '' };
        if (typeof oxyUser.name === 'string') {
          const parts = oxyUser.name.split(' ');
          name = { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
        } else if (oxyUser.name) {
          name = {
            first: oxyUser.name.first || '',
            last: oxyUser.name.last || '',
          };
        } else {
          name = { first: oxyUser.username || oxyUser.handle || 'Unknown', last: '' };
        }

        return {
          ...participant,
          name,
          username: oxyUser.username || oxyUser.handle || participant.username,
          avatar: oxyUser.avatar || participant.avatar,
        };
      });
    } catch (error) {
      logger.error('Error enriching participants:', error);
      return participants; // Return unmodified on error
    }
  }

  /**
   * Get all conversations for a user
   */
  static async getUserConversations(
    userId: string,
    options: PaginationOptions = {}
  ): Promise<IConversation[]> {
    const { limit = 50, offset = 0 } = options;

    try {
      const conversations = await Conversation.find({
        'participants.userId': userId,
        archivedBy: { $ne: userId },
      })
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .limit(limit)
        .skip(offset)
        .lean()
        .exec();

      // Batch enrich all conversations (efficient - single pass)
      const allParticipants = conversations.flatMap(conv => conv.participants || []);
      const enrichedParticipants = await this.enrichParticipants(allParticipants);

      // Map enriched participants back to conversations
      let participantIndex = 0;
      return conversations.map(conv => {
        const participantCount = conv.participants?.length || 0;
        const convEnrichedParticipants = enrichedParticipants.slice(
          participantIndex,
          participantIndex + participantCount
        );
        participantIndex += participantCount;

        return {
          ...conv,
          participants: convEnrichedParticipants,
        } as IConversation;
      });
    } catch (error) {
      logger.error('Error fetching user conversations:', error);
      throw new AppError('Failed to fetch conversations', 500);
    }
  }

  /**
   * Get a conversation by ID
   */
  static async getConversationById(
    conversationId: string,
    userId: string
  ): Promise<IConversation> {
    try {
      const conversation = await Conversation.findOne({
        _id: conversationId,
        'participants.userId': userId,
      })
        .lean()
        .exec();

      if (!conversation) {
        throw new AppError('Conversation not found', 404);
      }

      // Enrich participants
      const enrichedParticipants = await this.enrichParticipants(conversation.participants || []);

      return {
        ...conversation,
        participants: enrichedParticipants,
      } as IConversation;
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error('Error fetching conversation:', error);
      throw new AppError('Failed to fetch conversation', 500);
    }
  }

  /**
   * Create a new conversation
   */
  static async createConversation(data: CreateConversationData): Promise<IConversation> {
    const { userId, type = 'direct', participantIds, name, description, avatar } = data;

    try {
      // Validate participants
      if (!participantIds || participantIds.length < 1) {
        throw new AppError('At least one participant is required', 400);
      }

      // Ensure current user is included
      const allParticipants = Array.from(new Set([userId, ...participantIds]));

      // Validate direct conversation
      if (type === 'direct' && allParticipants.length !== 2) {
        throw new AppError('Direct conversations must have exactly 2 participants', 400);
      }

      // Check if direct conversation already exists
      if (type === 'direct') {
        const existing = await Conversation.findOne({
          type: 'direct',
          'participants.userId': { $all: allParticipants },
          'participants.2': { $exists: false }, // Exactly 2 participants
        })
          .lean()
          .exec();

        if (existing) {
          return existing as IConversation;
        }
      }

      // Create participant objects
      const participants = allParticipants.map(pid => ({
        userId: pid,
        role: pid === userId ? ('admin' as const) : ('member' as const),
        joinedAt: new Date(),
      }));

      // Create conversation
      const conversation = await Conversation.create({
        type,
        participants,
        name: type === 'group' ? name : undefined,
        description: type === 'group' ? description : undefined,
        avatar: type === 'group' ? avatar : undefined,
        createdBy: userId,
        unreadCounts: {},
      });

      logger.info(`Created ${type} conversation`, {
        conversationId: conversation._id,
        createdBy: userId,
        participantCount: participants.length,
      });

      return conversation.toObject() as IConversation;
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error('Error creating conversation:', error);
      throw new AppError('Failed to create conversation', 500);
    }
  }

  /**
   * Update a conversation
   */
  static async updateConversation(
    conversationId: string,
    userId: string,
    updates: UpdateConversationData
  ): Promise<IConversation> {
    try {
      const conversation = await Conversation.findOne({
        _id: conversationId,
        'participants.userId': userId,
      });

      if (!conversation) {
        throw new AppError('Conversation not found', 404);
      }

      // Only allow updates for group conversations
      if (conversation.type === 'group') {
        if (updates.name !== undefined) conversation.name = updates.name;
        if (updates.description !== undefined) conversation.description = updates.description;
        if (updates.avatar !== undefined) conversation.avatar = updates.avatar;

        await conversation.save();

        logger.info('Updated conversation', {
          conversationId,
          userId,
          updates: Object.keys(updates),
        });
      }

      return conversation.toObject() as IConversation;
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error('Error updating conversation:', error);
      throw new AppError('Failed to update conversation', 500);
    }
  }

  /**
   * Archive a conversation
   */
  static async archiveConversation(
    conversationId: string,
    userId: string
  ): Promise<IConversation> {
    try {
      const conversation = await Conversation.findOne({
        _id: conversationId,
        'participants.userId': userId,
      });

      if (!conversation) {
        throw new AppError('Conversation not found', 404);
      }

      if (!conversation.archivedBy.includes(userId)) {
        conversation.archivedBy.push(userId);
        await conversation.save();

        logger.info('Archived conversation', { conversationId, userId });
      }

      return conversation.toObject() as IConversation;
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error('Error archiving conversation:', error);
      throw new AppError('Failed to archive conversation', 500);
    }
  }

  /**
   * Mark conversation as read
   */
  static async markAsRead(conversationId: string, userId: string): Promise<IConversation> {
    try {
      const conversation = await Conversation.findOne({
        _id: conversationId,
        'participants.userId': userId,
      });

      if (!conversation) {
        throw new AppError('Conversation not found', 404);
      }

      // Update participant's lastReadAt
      const participant = conversation.participants.find(p => p.userId === userId);
      if (participant) {
        participant.lastReadAt = new Date();
      }

      // Reset unread count
      conversation.unreadCounts.set(userId, 0);
      await conversation.save();

      return conversation.toObject() as IConversation;
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error('Error marking conversation as read:', error);
      throw new AppError('Failed to mark conversation as read', 500);
    }
  }
}
