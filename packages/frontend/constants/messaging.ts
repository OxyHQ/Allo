/**
 * Constants for messaging UI
 * Centralized values for consistency and maintainability
 */

export const MESSAGING_CONSTANTS = {
  // Message display
  MAX_MESSAGE_WIDTH: '75%',
  MESSAGE_BUBBLE_BORDER_RADIUS: 22,
  MESSAGE_PADDING_HORIZONTAL: 16,
  MESSAGE_PADDING_VERTICAL: 10,
  MESSAGE_MARGIN_VERTICAL: 4,
  MESSAGE_MARGIN_CLOSE: 2,
  MESSAGE_SPACING_WITH_SENDER: 8,
  MESSAGE_CLOSE_TIME_WINDOW_MS: 2 * 60 * 1000, // 2 minutes in milliseconds
  
  // Typography
  MESSAGE_TEXT_SIZE: 16,
  SENDER_NAME_SIZE: 12,
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
  AVATAR_SIZE: 36,
  AVATAR_HIT_SLOP: { top: 10, bottom: 10, left: 10, right: 10 },
  
  // Scroll
  SCROLL_TO_BOTTOM_DELAY: 100,
  
  // Keyboard
  KEYBOARD_OFFSET_IOS: 90,
  
  // Message grouping
  MESSAGE_GROUPING_TIME_WINDOW_MS: 5 * 60 * 1000, // 5 minutes in milliseconds
} as const;

export const TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
} as const;

