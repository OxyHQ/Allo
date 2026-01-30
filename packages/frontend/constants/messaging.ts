/**
 * Constants for messaging UI
 * Centralized values for consistency and maintainability
 */

export const MESSAGING_CONSTANTS = {
  // Message display
  MAX_MESSAGE_WIDTH: '82%',
  MESSAGE_BUBBLE_BORDER_RADIUS: 20,
  MESSAGE_PADDING_HORIZONTAL: 10,
  MESSAGE_PADDING_VERTICAL: 6,
  MESSAGE_MARGIN_VERTICAL: 1,
  MESSAGE_MARGIN_CLOSE: 1,
  MESSAGE_SPACING_WITH_SENDER: 4,
  MESSAGE_CLOSE_TIME_WINDOW_MS: 2 * 60 * 1000, // 2 minutes in milliseconds

  // Block-level spacing (uniform gaps between message groups)
  BLOCK_PADDING_HORIZONTAL: 6,
  BLOCK_PADDING_VERTICAL: 1,
  BLOCK_MARGIN_VERTICAL: 1,
  BLOCK_CONTENT_ROW_GAP: 2,
  BLOCK_BUBBLES_GAP: 1,

  // Typography
  MESSAGE_TEXT_SIZE: 16,
  SENDER_NAME_SIZE: 11,
  TIMESTAMP_SIZE: 11,

  // Input
  INPUT_MAX_LENGTH: 1000,
  INPUT_BORDER_RADIUS: 20,
  INPUT_PADDING_HORIZONTAL: 16,
  INPUT_PADDING_VERTICAL: 10,
  SEND_BUTTON_SIZE: 44,

  // Header
  HEADER_OVERLAY_HEIGHT: 48,
  HEADER_OVERLAY_Z_INDEX: 101,
  AVATAR_SIZE: 32,
  AVATAR_HIT_SLOP: { top: 10, bottom: 10, left: 10, right: 10 },

  // Scroll
  SCROLL_TO_BOTTOM_DELAY: 100,

  // Keyboard
  KEYBOARD_OFFSET_IOS: 90,

  // Message grouping
  MESSAGE_GROUPING_TIME_WINDOW_MS: 5 * 60 * 1000, // 5 minutes in milliseconds

  // Media
  MEDIA_MAX_WIDTH: 250,
  MEDIA_HEIGHT: 200,
  MEDIA_BORDER_RADIUS_AI: 12,
  MEDIA_MARGIN_BOTTOM: 4,

  // Stickers (100x100 square)
  STICKER_SIZE: 100,
  STICKER_SIZE_SMALL: 70,

  // Typography
  LINE_HEIGHT_MULTIPLIER: 1.4, // Multiplier for line height based on font size
} as const;

export const TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
} as const;

