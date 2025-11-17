import { Message } from '@/stores';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';

/**
 * Message Group
 * Groups messages that are close together in time
 */
export interface MessageGroup {
  messages: Message[];
  timestamp: Date; // Timestamp of the first message in the group
  isAiGroup: boolean; // Whether all messages in this group are AI messages
  senderId?: string; // Sender ID (for non-AI groups)
  isSent?: boolean; // Whether messages are sent by current user
}

/**
 * Formatted message group with day information
 */
export interface FormattedMessageGroup extends MessageGroup {
  dayKey: string; // Unique key for the day (e.g., "2024-01-15")
  showDaySeparator: boolean; // Whether to show day separator before this group
}

/**
 * Check if two messages are close together in time
 */
export function areMessagesCloseInTime(msg1: Message, msg2: Message): boolean {
  const timeDiff = Math.abs(msg1.timestamp.getTime() - msg2.timestamp.getTime());
  return timeDiff <= MESSAGING_CONSTANTS.MESSAGE_GROUPING_TIME_WINDOW_MS;
}

/**
 * Check if two messages are from the same day
 */
export function areMessagesFromSameDay(msg1: Message, msg2: Message): boolean {
  const date1 = new Date(msg1.timestamp);
  const date2 = new Date(msg2.timestamp);
  
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

/**
 * Get day key string from a date (e.g., "2024-01-15")
 */
export function getDayKey(timestamp: Date): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Group messages by time proximity
 * Messages within MESSAGE_GROUPING_TIME_WINDOW_MS are grouped together
 */
export function groupMessagesByTime(messages: Message[]): MessageGroup[] {
  if (messages.length === 0) {
    return [];
  }

  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup | null = null;

  for (const message of messages) {
    const isAiMessage = message.messageType === 'ai';

    if (!currentGroup) {
      // Start a new group
      currentGroup = {
        messages: [message],
        timestamp: message.timestamp,
        isAiGroup: isAiMessage,
        senderId: !isAiMessage ? message.senderId : undefined,
        isSent: !isAiMessage ? message.isSent : undefined,
      };
    } else {
      const lastMessage = currentGroup.messages[currentGroup.messages.length - 1];
      const shouldGroup = areMessagesCloseInTime(lastMessage, message);

      // Check if we should add to current group
      // AI messages can only group with AI messages
      // Regular messages can only group with messages from same sender and same sent status
      const canGroup = shouldGroup &&
        (isAiMessage
          ? currentGroup.isAiGroup
          : !currentGroup.isAiGroup &&
            currentGroup.senderId === message.senderId &&
            currentGroup.isSent === message.isSent);

      if (canGroup) {
        // Add to current group
        currentGroup.messages.push(message);
      } else {
        // Finish current group and start a new one
        groups.push(currentGroup);
        currentGroup = {
          messages: [message],
          timestamp: message.timestamp,
          isAiGroup: isAiMessage,
          senderId: !isAiMessage ? message.senderId : undefined,
          isSent: !isAiMessage ? message.isSent : undefined,
        };
      }
    }
  }

  // Add the last group
  if (currentGroup) {
    groups.push(currentGroup);
  }

  return groups;
}

/**
 * Format message groups with day separators
 */
export function formatMessageGroupsWithDays(groups: MessageGroup[]): FormattedMessageGroup[] {
  if (groups.length === 0) {
    return [];
  }

  const formatted: FormattedMessageGroup[] = [];
  let previousDayKey: string | null = null;

  for (const group of groups) {
    const dayKey = getDayKey(group.timestamp);
    const showDaySeparator = previousDayKey === null || previousDayKey !== dayKey;

    formatted.push({
      ...group,
      dayKey,
      showDaySeparator,
    });

    previousDayKey = dayKey;
  }

  return formatted;
}

/**
 * Format a date for day separator display
 * Returns formatted string like "Today", "Yesterday", "Monday, January 15", etc.
 */
export function formatDaySeparator(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const messageDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (messageDate.getTime() === today.getTime()) {
    return 'Today';
  }

  if (messageDate.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  }

  // Check if it's within the last 7 days
  const daysDiff = Math.floor((today.getTime() - messageDate.getTime()) / (1000 * 60 * 60 * 24));
  if (daysDiff <= 7) {
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  // For older dates, show full date
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

