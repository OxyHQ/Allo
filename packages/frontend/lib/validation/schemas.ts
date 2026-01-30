import { z } from 'zod';

/**
 * Zod Validation Schemas
 *
 * Runtime validation for API responses and data integrity
 * Prevents bugs from malformed data and provides type safety
 *
 * WhatsApp/Telegram-level: Strict validation prevents crashes from bad data
 */

// ============================================================================
// Media Schema
// ============================================================================

export const MediaItemSchema = z.object({
  id: z.string(),
  type: z.enum(['image', 'video', 'gif']),
  url: z.string().url().optional(),
  thumbnail: z.string().url().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  size: z.number().optional(),
  duration: z.number().optional(), // For videos
});

export type MediaItem = z.infer<typeof MediaItemSchema>;

// ============================================================================
// Message Schema
// ============================================================================

export const MessageStatusSchema = z.enum(['pending', 'sent', 'delivered', 'read', 'failed']);

export const MessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  senderId: z.string(),
  senderDeviceId: z.number().optional(),
  senderName: z.string().optional(),
  timestamp: z.date(),
  isSent: z.boolean(),
  conversationId: z.string(),
  messageType: z.enum(['user', 'ai', 'system']).optional(),
  media: z.array(MediaItemSchema).optional(),
  fontSize: z.number().optional(),
  replyTo: z.string().optional(),
  reactions: z.record(z.array(z.string())).optional(), // emoji -> userIds
  // Encryption
  isEncrypted: z.boolean().optional(),
  ciphertext: z.string().optional(),
  encryptionVersion: z.number().optional(),
  // Status
  readStatus: MessageStatusSchema.optional(),
  // Editing
  isEdited: z.boolean().optional(),
  editedAt: z.date().optional(),
});

export type Message = z.infer<typeof MessageSchema>;

// ============================================================================
// API Response Schemas
// ============================================================================

export const MessageAPISchema = z.object({
  _id: z.string().optional(),
  id: z.string().optional(),
  text: z.string().optional(),
  ciphertext: z.string().optional(),
  senderId: z.string(),
  senderDeviceId: z.number().optional(),
  conversationId: z.string(),
  messageType: z.enum(['user', 'ai', 'system']).optional(),
  fontSize: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  isEncrypted: z.boolean().optional(),
  encryptionVersion: z.number().optional(),
  readBy: z.record(z.string()).optional(),
  deliveredTo: z.array(z.string()).optional(),
  media: z.array(MediaItemSchema).optional(),
});

export const MessagesAPIResponseSchema = z.object({
  messages: z.array(MessageAPISchema),
  total: z.number().optional(),
  hasMore: z.boolean().optional(),
  cursor: z.string().optional(),
});

// ============================================================================
// User Schema
// ============================================================================

export const UserNameSchema = z.union([
  z.string(),
  z.object({
    first: z.string().optional(),
    last: z.string().optional(),
    full: z.string().optional(),
  }),
]);

export const UserSchema = z.object({
  id: z.string(),
  username: z.string().optional(),
  handle: z.string().optional(),
  name: UserNameSchema.optional(),
  avatar: z.string().url().optional().or(z.literal('')),
  verified: z.boolean().optional(),
  bio: z.string().optional(),
  createdAt: z.string().optional(),
});

export type User = z.infer<typeof UserSchema>;

// ============================================================================
// Conversation Schema
// ============================================================================

export const ConversationTypeSchema = z.enum(['direct', 'group']);

export const ConversationParticipantSchema = z.object({
  id: z.string(),
  userId: z.string().optional(), // Backend format
  name: z.union([
    z.string(),
    z.object({
      first: z.string(),
      last: z.string(),
    }),
  ]),
  username: z.string().optional(),
  avatar: z.string().optional(),
});

export const ConversationSchema = z.object({
  id: z.string(),
  type: ConversationTypeSchema,
  name: z.string(),
  lastMessage: z.string(),
  timestamp: z.string(),
  unreadCount: z.number(),
  avatar: z.string().optional(),
  isArchived: z.boolean().optional(),
  participants: z.array(ConversationParticipantSchema).optional(),
  groupName: z.string().optional(),
  groupAvatar: z.string().optional(),
  participantCount: z.number().optional(),
});

export type Conversation = z.infer<typeof ConversationSchema>;

// ============================================================================
// API Response for Conversations
// ============================================================================

export const ConversationAPIParticipantSchema = z.object({
  userId: z.string(),
  name: z.union([
    z.string(),
    z.object({
      first: z.string().optional(),
      last: z.string().optional(),
    }),
  ]).optional(),
  username: z.string().optional(),
  avatar: z.string().optional(),
});

export const ConversationAPISchema = z.object({
  _id: z.string().optional(),
  id: z.string().optional(),
  type: ConversationTypeSchema.optional(),
  name: z.string().optional(),
  avatar: z.string().optional(),
  participants: z.array(ConversationAPIParticipantSchema).optional(),
  lastMessage: z.object({
    text: z.string().optional(),
    senderId: z.string().optional(),
  }).optional(),
  lastMessageAt: z.string().optional(),
  unreadCounts: z.record(z.number()).optional(),
  createdAt: z.string().optional(),
});

export const ConversationsAPIResponseSchema = z.object({
  conversations: z.array(ConversationAPISchema),
  total: z.number().optional(),
  hasMore: z.boolean().optional(),
  cursor: z.string().optional(),
});

// ============================================================================
// Validation Helper Functions
// ============================================================================

/**
 * Safe parse with error logging
 */
export function safeParse<T>(schema: z.ZodSchema<T>, data: unknown, context?: string): T | null {
  const result = schema.safeParse(data);

  if (!result.success) {
    console.error(`[Validation Error]${context ? ` ${context}:` : ''}`, {
      errors: result.error.errors,
      data,
    });
    return null;
  }

  return result.data;
}

/**
 * Parse or throw with detailed error
 */
export function parseOrThrow<T>(schema: z.ZodSchema<T>, data: unknown, context?: string): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const message = `Validation failed${context ? ` for ${context}` : ''}: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`;
      console.error('[Validation Error]', message, { errors: error.errors, data });
      throw new Error(message);
    }
    throw error;
  }
}

/**
 * Validate array with partial success
 * Returns only valid items, logs invalid ones
 */
export function parseArray<T>(
  schema: z.ZodSchema<T>,
  data: unknown[],
  context?: string
): T[] {
  if (!Array.isArray(data)) {
    console.error(`[Validation Error]${context ? ` ${context}:` : ''} Expected array, got:`, typeof data);
    return [];
  }

  const results: T[] = [];

  data.forEach((item, index) => {
    const result = schema.safeParse(item);
    if (result.success) {
      results.push(result.data);
    } else {
      console.warn(
        `[Validation Warning]${context ? ` ${context}:` : ''} Invalid item at index ${index}:`,
        result.error.errors
      );
    }
  });

  return results;
}
