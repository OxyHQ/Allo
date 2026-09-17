import React, { useMemo, useRef, useEffect, useContext, useCallback, useState } from 'react';
import {
  StyleSheet,
  View,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  ImageBackground,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useSharedValue } from 'react-native-reanimated';
import { useRouter, usePathname, useSegments } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { toast } from '@oxy.so/bloom/toast';
import { useTimeline } from '@allo/react';

// Components
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { ContactDetails } from '@/components/ContactDetails';
import Avatar from '@/components/Avatar';
import { GroupAvatar } from '@/components/GroupAvatar';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { MessageBlock } from '@/components/messages/MessageBlock';
import { MessageBubble } from '@/components/messages/MessageBubble';
import { DaySeparator } from '@/components/messages/DaySeparator';
import { AttachmentMenu } from '@/components/messages/AttachmentMenu';
import { MessageActionsMenu, MessageAction } from '@/components/messages/MessageActionsMenu';
import { MessageInfoScreen } from '@/components/messages/MessageInfoScreen';
import { SwipeableMessage } from '@/components/messages/SwipeableMessage';
import { MediaCarousel } from '@/components/messages/MediaCarousel';
import { MicSendButton } from '@/components/messages/MicSendButton';
import { AttachmentViewer } from '@/components/media/AttachmentViewer';
import { EmptyState } from '@/components/shared/EmptyState';
import { ReplyIcon } from '@/assets/icons/reply-icon';
import { ForwardIcon } from '@/assets/icons/forward-icon';
import { CopyIcon } from '@/assets/icons/copy-icon';
import { TrashIcon } from '@/assets/icons/trash-icon';
import { CloseIcon } from '@/assets/icons/close-icon';

// Icons
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Plus } from '@/assets/icons/plus-icon';
import { EmojiIcon } from '@/assets/icons/emoji-icon';
import ChatBackgroundImage from '@/assets/images/background.png';

// Hooks
import { useConversationTheme } from '@/hooks/useConversationTheme';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { useConversation } from '@/hooks/useConversation';
import { useConversationMetadata } from '@/hooks/useConversationMetadata';
import { useSenderInfo } from '@/hooks/useSenderInfo';

// Context
import { BottomSheetContext } from '@/context/BottomSheetContext';

// Utils
import { colors } from '@/styles/colors';
import {
  getOtherParticipants,
} from '@/utils/conversationUtils';
import { getConversationId } from '@/utils/conversationHelpers';
import { logger } from '@/utils/logger';
import { useChatUIStore, useMessagePreferencesStore } from '@/stores';
import { useConversationThemeId } from '@/stores/conversationThemeStore';
import { useOxy } from '@oxy.so/services';
import { readAttachmentBytes } from '@/lib/allo/attachmentBytes';
import {
  captureMediaAttachment,
  pickDocumentAttachments,
  pickMediaAttachments,
  toVoiceAttachment,
  type AlloOutgoingAttachment,
  type PickedAttachments,
} from '@/lib/chat/attachments';
import { selectViewerItem, type ViewerSelection } from '@/lib/chat/attachmentViewer';
import { messagesFromItems, type Message } from '@/lib/chat/model';
import { getErrorMessage } from '@/utils/errors';

// Constants
import { MESSAGING_CONSTANTS } from '@/constants/messaging';

// Utils
import { groupMessagesByTime, formatMessageGroupsWithDays, FormattedMessageGroup } from '@/utils/messageGrouping';

/**
 * ConversationView component props
 */
interface ConversationViewProps {
  conversationId?: string;
  username?: string; // For username-based routing
}

type SelectionContext = 'text' | 'media';

/**
 * ConversationView Component
 *
 * Displays a conversation with messages, input, and header.
 * Supports both direct and group conversations with responsive layouts.
 *
 * The timeline, the send actions and the typing state come from
 * `useTimeline` (`@allo/react`); the SDK decrypts on this device and this
 * component only projects what it is given into the message components.
 *
 * Features:
 * - Tap to toggle message timestamps (only one visible at a time)
 * - Group conversation sender names
 * - Responsive header with contact/group details
 * - Keyboard-aware input
 */
export default function ConversationView({ conversationId: propConversationId }: ConversationViewProps = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const segments = useSegments();
  const bottomSheet = useContext(BottomSheetContext);
  const messageTextSize = useMessagePreferencesStore((state) => state.messageTextSize ?? MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE);
  const setMessageTextSize = useMessagePreferencesStore((state) => state.setMessageTextSize);
  const { user } = useOxy();
  const currentUserId = user?.id;

  // Send button gesture state
  const [isSizeAdjusting, setIsSizeAdjusting] = useState(false);
  const [tempTextSize, setTempTextSize] = useState(messageTextSize);
  const baseTextSize = useRef(messageTextSize);
  const panY = useSharedValue(0);
  const scale = useSharedValue(1);

  // Update temp size when messageTextSize changes externally
  useEffect(() => {
    setTempTextSize(messageTextSize);
    baseTextSize.current = messageTextSize;
  }, [messageTextSize]);

  // Get conversation ID from multiple sources (prop > pathname > segments)
  // Handle both /c/[id] and /@username formats
  const conversationIdOrUsername = useMemo(
    () => getConversationId(propConversationId, pathname, segments),
    [propConversationId, pathname, segments]
  );

  // Check if it's a username route (starts with @)
  const isUsernameRoute = conversationIdOrUsername?.startsWith('@');
  const conversationId = isUsernameRoute ? undefined : conversationIdOrUsername;

  // Get conversation data early so we can use its theme
  const conversation = useConversation(conversationId);

  // Use conversation-specific theme (falls back to global theme if no conversation theme set)
  const conversationThemeId = useConversationThemeId(conversationId);
  const theme = useConversationTheme(conversationThemeId);

  // The timeline and its actions. `''` when there is no conversation: the hook
  // takes a string and cannot be conditional; it subscribes to nothing useful.
  const timeline = useTimeline(conversationId ?? '');
  const { items, send, sendMedia, edit, remove, react, markRead, setTyping, loadOlder, reachedStart, typing } = timeline;

  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });

  // The SDK's items as the message components draw them
  const messages = useMemo(() => messagesFromItems(items), [items]);

  // Group messages by time and format with day separators
  const messageGroups = useMemo(() => {
    if (messages.length === 0) {
      return [];
    }
    const groups = groupMessagesByTime(messages);
    return formatMessageGroupsWithDays(groups);
  }, [messages]);

  // Whatever is on screen has been read. The SDK sends one receipt per
  // advance and nothing when nothing is new, so this is safe on every change.
  useEffect(() => {
    if (!conversationId || items.length === 0) return;
    markRead().catch((error: unknown) => logger.warn('[Conversation] read receipt failed', error));
  }, [conversationId, items, markRead]);

  // Get UI state from store - access directly from state for reactivity
  const inputText = useChatUIStore(state =>
    conversationId ? (state.inputTextByConversation[conversationId] || '') : ''
  );
  const visibleTimestampId = useChatUIStore(state =>
    conversationId ? state.getVisibleTimestampId(conversationId) : null
  );

  const editingMessageId = useChatUIStore(state =>
    conversationId ? state.editingByConversation[conversationId] : undefined
  );

  // Get store actions (using selectors to avoid re-renders)
  const clearConversationUI = useChatUIStore(state => state.clearConversationUI);
  const setInputText = useChatUIStore(state => state.setInputText);
  const setVisibleTimestamp = useChatUIStore(state => state.setVisibleTimestamp);
  const setEditing = useChatUIStore(state => state.setEditing);

  const flatListRef = useRef<FlashListRef<FormattedMessageGroup> | null>(null);
  const inputRef = useRef<TextInput>(null);
  const lastOpenedConversationId = useRef<string | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Message actions state
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [selectionContext, setSelectionContext] = useState<SelectionContext | null>(null);
  const [actionsMenuVisible, setActionsMenuVisible] = useState(false);
  const [actionsMenuPosition, setActionsMenuPosition] = useState<{ x: number; y: number; width?: number; height?: number } | undefined>();
  const [infoScreenVisible, setInfoScreenVisible] = useState(false);
  // The gallery the full-screen viewer is showing, or `null` for closed. A
  // snapshot taken when it opened: the conversation keeps arriving while it is
  // up, and a gallery that grew underneath the reader would move the picture
  // they were looking at.
  const [viewerSelection, setViewerSelection] = useState<ViewerSelection | null>(null);
  const selectedMediaItem = useMemo(() => {
    if (!selectedMessage || !selectedMediaId || !selectedMessage.media) {
      return null;
    }
    return selectedMessage.media.find(media => media.id === selectedMediaId) || null;
  }, [selectedMessage, selectedMediaId]);

  // Clear UI state when switching conversations
  useEffect(() => {
    if (!conversationId) return;
    if (lastOpenedConversationId.current === conversationId) return;
    lastOpenedConversationId.current = conversationId;
    clearConversationUI(conversationId);
  }, [conversationId, clearConversationUI]);

  // Cleanup typing timeout when conversation changes or component unmounts
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
  }, [conversationId]);

  // Use custom hook for conversation metadata
  const conversationMetadata = useConversationMetadata(conversation, currentUserId);
  const { isGroup } = conversationMetadata;

  // Who sent each incoming message.
  const { getSenderName, getSenderHandle, getSenderAvatar } =
    useSenderInfo(conversation, isGroup, conversationMetadata);

  /**
   * Handle header press to show contact/group details
   * On mobile: opens bottom sheet
   * On desktop: details are already visible in right pane
   */
  const handleHeaderPress = useCallback(() => {
    if (!conversationId) return;
    if (!conversation || !bottomSheet) return;

    if (!isLargeScreen) {
      bottomSheet.setBottomSheetContent(
        <ContactDetails
          conversationId={conversationId}
          conversationType={isGroup ? 'group' : 'direct'}
          contactName={conversationMetadata.contactName}
          contactUsername={conversationMetadata.contactUsername}
          contactAvatar={conversationMetadata.contactAvatar}
          isOnline={conversationMetadata.isOnline}
          lastSeen={conversationMetadata.contactInfo?.lastSeen}
          participants={conversation.participants}
          groupName={conversationMetadata.groupInfo?.name}
          groupAvatar={conversationMetadata.groupInfo?.avatar}
          currentUserId={currentUserId}
          myRole={conversation.myRole}
        />
      );
      bottomSheet.openBottomSheet(true);
    }
  }, [conversationId, conversation, isLargeScreen, isGroup, bottomSheet, conversationMetadata, currentUserId]);

  // Styles memoized for performance
  const styles = useMemo(() => StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    background: {
      flex: 1,
      width: '100%',
      backgroundColor: theme.colors.chatBackground,
    },
    backgroundImage: {
      opacity: 0.08, // Reduced opacity to let theme color show through
    },
    container: {
      flex: 1,
      backgroundColor: 'transparent',
    },
    headerWrapper: {
      position: 'relative',
    },
    headerClickableOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: MESSAGING_CONSTANTS.HEADER_OVERLAY_HEIGHT,
      zIndex: MESSAGING_CONSTANTS.HEADER_OVERLAY_Z_INDEX,
      backgroundColor: 'transparent',
    },
    messagesList: {
      flex: 1,
    },
    inputContainer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: 8,
      paddingVertical: 8,
      paddingBottom: Platform.OS === 'ios' ? 8 : 12,
      backgroundColor: theme.colors.background,
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
    },
    inputWrapper: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'flex-end',
      minHeight: 36,
      maxHeight: 100,
      borderRadius: 20,
      backgroundColor: theme.colors.backgroundSecondary,
      paddingLeft: 12,
      paddingRight: 12,
      paddingTop: 8,
      paddingBottom: 8,
    },
    input: {
      flex: 1,
      paddingHorizontal: 0,
      paddingVertical: Platform.OS === 'ios' ? 8 : 6,
      fontSize: isSizeAdjusting ? tempTextSize : messageTextSize,
      color: theme.colors.text,
      textAlignVertical: 'top',
      minHeight: 20,
      maxHeight: 84,
      lineHeight: Platform.OS === 'android'
        ? (isSizeAdjusting ? tempTextSize : messageTextSize) * 1.2
        : undefined,
      includeFontPadding: Platform.OS === 'android' ? false : undefined,
    },
    attachButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: 'transparent',
    },
    emojiButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: 'transparent',
      marginRight: 4,
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },
    editingBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 8,
      backgroundColor: theme.colors.backgroundSecondary,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
    },
    editingBannerText: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    typingIndicator: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      flexDirection: 'row',
      alignItems: 'center',
    },
    typingText: {
      fontSize: 14,
      fontStyle: 'italic',
      color: theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5,
    },
    notJoinedBanner: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: theme.colors.backgroundSecondary,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
    },
    notJoinedText: {
      fontSize: 13,
      textAlign: 'center',
      color: theme.colors.textSecondary,
    },
  }), [theme, messageTextSize, isSizeAdjusting, tempTextSize]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (flatListRef.current && messageGroups.length > 0) {
      const timeoutId = setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, MESSAGING_CONSTANTS.SCROLL_TO_BOTTOM_DELAY);

      return () => clearTimeout(timeoutId);
    }
  }, [messageGroups.length]);

  /**
   * Says the viewer is typing.
   *
   * The throttling around this — one notice per five seconds, a stop after three
   * idle — belongs to the composer; the SDK encrypts and sends the notice.
   */
  const notifyTyping = useCallback((on: boolean) => {
    if (!conversationId) return;
    setTyping(on).catch(() => {
      // A typing notice that does not go out is not worth a toast.
    });
  }, [conversationId, setTyping]);

  // Typing indicator: throttle to max 1 emit per 5s (Telegram pattern)
  const lastTypingEmitRef = useRef<number>(0);

  const handleInputChange = useCallback((text: string) => {
    if (conversationId) {
      setInputText(conversationId, text);

      // Clear existing stop-typing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }

      if (text.length > 0) {
        // Throttle: only send typing=true once every 5 seconds
        const now = Date.now();
        if (now - lastTypingEmitRef.current > 5000) {
          notifyTyping(true);
          lastTypingEmitRef.current = now;
        }
        // Stop typing after 3 seconds of no input
        typingTimeoutRef.current = setTimeout(() => {
          notifyTyping(false);
          lastTypingEmitRef.current = 0;
          typingTimeoutRef.current = null;
        }, 3000);
      } else {
        notifyTyping(false);
        lastTypingEmitRef.current = 0;
      }
    }
  }, [conversationId, setInputText, notifyTyping]);

  const setReplyTo = useChatUIStore((state) => state.setReplyTo);
  const replyTo = useChatUIStore((state) => conversationId && state.replyToByConversation ? state.replyToByConversation[conversationId] : undefined);

  const handleSend = useCallback(async (sizeToUse?: number) => {
    if (!conversationId || inputText.trim().length === 0) return;

    const text = inputText.trim();
    const originalSize = messageTextSize;

    // Clear typing timeout and stop typing indicator
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    notifyTyping(false);

    // Clear input immediately for better UX (before sending)
    setInputText(conversationId, '');

    // Temporarily set the size if it was adjusted
    if (sizeToUse && sizeToUse !== messageTextSize) {
      setMessageTextSize(sizeToUse);
    }

    try {
      if (editingMessageId !== undefined) {
        await edit(editingMessageId, text);
        setEditing(conversationId, undefined);
      } else {
        await send(text, replyTo ? { replyTo } : undefined);
        if (replyTo) setReplyTo(conversationId, undefined);
      }

      // Scroll to bottom after sending
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    } catch (error) {
      logger.error('[Conversation] Error sending message:', error);
      toast.error(getErrorMessage(error) || 'Failed to send message. Please try again.');

      // Restore text on error
      setInputText(conversationId, text);
      return; // Don't continue with cleanup if there was an error
    }

    // Reset size immediately (message stores its own fontSize)
    if (sizeToUse && sizeToUse !== originalSize) {
      setMessageTextSize(originalSize);
      setTempTextSize(originalSize);
    }
    setIsSizeAdjusting(false);

    // Refocus input after sending
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
  }, [conversationId, inputText, send, edit, editingMessageId, setEditing, replyTo, setReplyTo, setInputText, messageTextSize, setMessageTextSize, notifyTyping]);

  /**
   * Handle Enter key press to send message
   * For multiline inputs, we check if there's text to send
   */
  const handleSubmitEditing = useCallback(() => {
    if (inputText.trim().length > 0) {
      handleSend();
    }
  }, [inputText, handleSend]);

  /**
   * Handle key press events (for web/desktop Enter key)
   * Enter sends the message, Shift+Enter creates new line (handled by multiline)
   */
  const handleKeyPress = useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    // On web/desktop, detect Enter key to send
    // Note: Shift+Enter will still create new line due to multiline behavior
    if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter') {
      if (inputText.trim().length > 0) {
        handleSend();
      }
    }
  }, [inputText, handleSend]);

  /**
   * Sends what was picked.
   *
   * Each attachment is read whole, handed to the SDK — which encrypts it with a
   * key of its own, uploads the ciphertext and sends the `media` message — and
   * appears in the timeline as a local echo. One at a time, in the order they
   * were chosen: two uploads at once is twice the memory for the same result.
   */
  const sendAttachments = useCallback(async (attachments: PickedAttachments) => {
    if (!conversationId || attachments.length === 0) {
      return;
    }
    for (const attachment of attachments) {
      try {
        await sendMedia(await readAttachmentBytes(attachment.uri), uploadMeta(attachment));
      } catch (error) {
        logger.error('[Conversation] an attachment could not be sent:', error);
        toast.error(getErrorMessage(error) || 'The attachment could not be sent.');
        return;
      }
    }
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [conversationId, sendMedia]);

  /**
   * Picks from the photo library, or takes a picture, and sends what comes back.
   *
   * The picker's own promise is what this awaits — there is no Effect and no
   * subscription — because opening a picker is something the user did, and the
   * result belongs to that event and not to a later render.
   */
  const handleSelectMedia = useCallback(
    (pick: () => Promise<PickedAttachments>) => {
      pick()
        .then(sendAttachments)
        .catch((error: unknown) => {
          logger.error('[Conversation] Error choosing an attachment:', error);
          toast.error('The attachment could not be read.');
        });
    },
    [sendAttachments]
  );

  /**
   * Handle attach button press
   * Opens WhatsApp-style attachment menu in bottom sheet
   */
  const handleAttach = useCallback(() => {
    if (!bottomSheet) return;

    bottomSheet.setBottomSheetContent(
      <AttachmentMenu
        onClose={() => bottomSheet.openBottomSheet(false)}
        onSelectPhoto={() => handleSelectMedia(pickMediaAttachments)}
        onSelectDocument={() => handleSelectMedia(pickDocumentAttachments)}
        onSelectCamera={() => handleSelectMedia(captureMediaAttachment)}
        // Location, contact and poll are left unwired rather than stubbed: each
        // needs a decision about what Allo sends before there is anything for a
        // handler to do. An option the menu offers and silently ignores is
        // worse than one it does not offer.
        onSelectLocation={undefined}
        onSelectContact={undefined}
        onSelectPoll={undefined}
      />
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, handleSelectMedia]);

  /**
   * Handle emoji button press
   * TODO: Implement emoji picker
   */
  const handleEmoji = useCallback(() => {
    // Placeholder for emoji picker functionality
  }, []);

  /**
   * Toggle timestamp visibility for a message
   * Only one message's timestamp can be visible at a time
   */
  const toggleTimestamp = useCallback((messageId: string) => {
    if (!conversationId) return;
    const current = visibleTimestampId;
    // If clicking the same message, hide it. Otherwise, show the new one.
    const newId = current === messageId ? null : messageId;
    setVisibleTimestamp(conversationId, newId);
  }, [conversationId, visibleTimestampId, setVisibleTimestamp]);

  const selectedMessagePreview = useMemo(() => {
    if (!selectedMessage) {
      return null;
    }

    const previewNodes: React.ReactNode[] = [];
    const mediaToRender = selectedMediaItem
      ? [selectedMediaItem]
      : selectedMessage.media && selectedMessage.media.length > 0
        ? selectedMessage.media
        : [];

    if (mediaToRender.length > 0) {
      previewNodes.push(
        <MediaCarousel
          key="preview-media"
          media={mediaToRender}
          isAiMessage={selectedMessage.messageType === 'ai'}
          onMediaPress={() => { }}
          onMediaLongPress={() => { }}
        />
      );
    }

    if (selectedMessage.text && !selectedMediaItem) {
      previewNodes.push(
        <MessageBubble
          key="preview-text"
          id={selectedMessage.id}
          text={selectedMessage.text}
          timestamp={selectedMessage.timestamp}
          isSent={selectedMessage.isSent}
          senderName={isGroup && !selectedMessage.isSent ? getSenderName(selectedMessage.senderId) : undefined}
          showSenderName={isGroup && !selectedMessage.isSent}
          showTimestamp={false}
          isCloseToPrevious={false}
          messageType={selectedMessage.messageType || 'user'}
        />
      );
    }

    if (previewNodes.length === 0) {
      return null;
    }

    return (
      <View>
        {previewNodes}
      </View>
    );
  }, [
    selectedMessage,
    selectedMediaItem,
    isGroup,
    getSenderName,
  ]);

  /**
   * Opens the full-screen viewer on the picture or video that was tapped.
   *
   * The gallery is every attachment in the conversation, not just this
   * message's: five photographs sent one at a time are five messages, and a
   * viewer built from one of them could never be swiped.
   * Which page it opens on is decided in `lib/chat/attachmentViewer.ts`, from
   * the message and the media together — the same file sent twice has the same
   * blob id twice.
   */
  const handleMediaPress = useCallback((message: Message, mediaId: string) => {
    setViewerSelection(selectViewerItem(messages, message.id, mediaId) ?? null);
  }, [messages]);

  const handleViewerClose = useCallback(() => {
    setViewerSelection(null);
  }, []);

  /**
   * Handle message long press (show reaction bar and actions menu)
   */
  const handleMessageLongPress = useCallback((message: Message, position: { x: number; y: number; width?: number; height?: number }) => {
    setSelectedMessage(message);
    setSelectedMediaId(null); // Clear media selection
    setSelectionContext('text');
    setActionsMenuPosition(position); // Same position for actions menu
    setActionsMenuVisible(true); // Show both simultaneously
  }, []);

  /**
   * Handle reaction selection
   */
  const resetSelectionState = useCallback((options?: { preserveMessage?: boolean }) => {
    setActionsMenuVisible(false);
    if (!options?.preserveMessage) {
      setSelectedMessage(null);
    }
    setSelectedMediaId(null);
    setSelectionContext(null);
  }, []);

  /** Toggles: the SDK removes a reaction this account already set. */
  const handleReactionSelect = useCallback(async (emoji: string) => {
    if (!selectedMessage || !conversationId) {
      resetSelectionState();
      return;
    }

    try {
      await react(selectedMessage.id, emoji);
    } catch (error) {
      logger.error('[Conversation] Error toggling reaction:', error);
      toast.error('Failed to update reaction');
    } finally {
      resetSelectionState();
    }
  }, [selectedMessage, conversationId, react, resetSelectionState]);

  /**
   * Handle reply action
   */
  const handleReply = useCallback((message: Message) => {
    resetSelectionState({ preserveMessage: true });
    if (conversationId) {
      setReplyTo(conversationId, message.id);
      inputRef.current?.focus();
    }
  }, [resetSelectionState, conversationId, setReplyTo]);

  /**
   * Handle forward action
   */
  const handleForward = useCallback((_message: Message) => {
    resetSelectionState({ preserveMessage: true });
    // TODO: Implement forward functionality
  }, [resetSelectionState]);

  /**
   * Handle copy action
   */
  const handleCopy = useCallback(async (message: Message) => {
    resetSelectionState({ preserveMessage: true });
    try {
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(message.text || '');
      toast.success('Message copied to clipboard');
    } catch (error) {
      logger.error('[Conversation] Failed to copy message to clipboard:', error);
    }
  }, [resetSelectionState]);

  /**
   * Handle edit action
   *
   * Puts the composer into rewrite mode with the current body in it. The message
   * is not touched until the user sends; cancelling leaves it exactly as it was.
   */
  const handleEdit = useCallback((message: Message) => {
    resetSelectionState({ preserveMessage: true });
    if (!conversationId) return;
    setEditing(conversationId, message.id);
    setInputText(conversationId, message.text);
    inputRef.current?.focus();
  }, [resetSelectionState, conversationId, setEditing, setInputText]);

  const handleCancelEdit = useCallback(() => {
    if (!conversationId) return;
    setEditing(conversationId, undefined);
    setInputText(conversationId, '');
  }, [conversationId, setEditing, setInputText]);

  const handleCancelReply = useCallback(() => {
    if (!conversationId) return;
    setReplyTo(conversationId, undefined);
  }, [conversationId, setReplyTo]);

  /**
   * Handle delete action: the SDK sends a `delete` for one of the viewer's own
   * messages and every device draws it as taken back.
   */
  const handleDelete = useCallback(async (message: Message) => {
    resetSelectionState({ preserveMessage: true });
    try {
      await remove(message.id);
    } catch (error) {
      logger.error('[Conversation] Error deleting message:', error);
      toast.error(getErrorMessage(error) || 'The message could not be deleted.');
    }
  }, [resetSelectionState, remove]);

  /**
   * Handle info action
   */
  const handleInfo = useCallback((message: Message) => {
    resetSelectionState({ preserveMessage: true });
    setSelectedMessage(message);
    setInfoScreenVisible(true);
  }, [resetSelectionState]);

  /**
   * Get message actions for actions menu
   */
  const getMessageActions = useCallback((message: Message | null, context: SelectionContext | null): MessageAction[] => {
    if (!message) return [];

    const actions: MessageAction[] = [
      {
        label: 'Reply',
        icon: <ReplyIcon size={20} color={theme.colors.text} />,
        onPress: () => handleReply(message),
      },
      {
        label: 'Forward',
        icon: <ForwardIcon size={20} color={theme.colors.text} />,
        onPress: () => handleForward(message),
      },
      {
        label: 'Copy',
        icon: <CopyIcon size={20} color={theme.colors.text} />,
        onPress: () => handleCopy(message),
      },
      {
        label: 'Info',
        onPress: () => handleInfo(message),
      },
    ];

    // Only ever applies to the viewer's own messages: an action offered to
    // everyone that works for a few is worse than one that is not offered.
    if (message.isSent && !message.isDeleted && !message.isUndecryptable) {
      if (!message.media && !message.attachment) {
        actions.push({
          label: 'Edit',
          onPress: () => handleEdit(message),
        });
      }
      actions.push({
        label: 'Delete',
        icon: <TrashIcon size={20} color={theme.colors.error} />,
        onPress: () => {
          void handleDelete(message);
        },
        destructive: true,
      });
    }

    if (context === 'media') {
      return actions.filter(action => action.label !== 'Copy' && action.label !== 'Edit');
    }
    return actions;
  }, [theme.colors.text, theme.colors.error, handleReply, handleForward, handleCopy, handleInfo, handleEdit, handleDelete]);

  /**
   * Handle swipe to reply
   */
  const handleSwipeToReply = useCallback((message: Message) => {
    handleReply(message);
  }, [handleReply]);

  /** Older history, when the reader scrolls to the top of what is shown. */
  const handleStartReached = useCallback(() => {
    if (reachedStart) return;
    loadOlder().catch((error: unknown) => logger.warn('[Conversation] loading older messages failed', error));
  }, [reachedStart, loadOlder]);

  /**
   * Render a message group with day separator if needed
   */
  const renderMessageGroup = useCallback(({ item }: { item: FormattedMessageGroup }) => {
    const { showDaySeparator, ...group } = item;
    const firstMessage = group.messages[0];
    const isAiGroup = group.isAiGroup;

    return (
      <>
        {showDaySeparator && (
          <DaySeparator date={item.timestamp} />
        )}
        <SwipeableMessage
          enabled={!isAiGroup} // Disable swipe for system lines
          onSwipeRight={() => handleSwipeToReply(firstMessage)}
          replyIcon={<ReplyIcon size={20} color="#FFFFFF" />}
        >
          <MessageBlock
            group={group}
            isGroup={isGroup}
            getSenderName={getSenderName}
            getSenderAvatar={getSenderAvatar}
            visibleTimestampId={visibleTimestampId}
            onMessagePress={toggleTimestamp}
            onMessageLongPress={handleMessageLongPress}
            onMediaPress={handleMediaPress}
            onMediaLongPress={(message, mediaId, index, position) => {
              setSelectedMessage(message);
              setSelectedMediaId(mediaId);
              setSelectionContext('media');
              setActionsMenuPosition(position); // Same position for actions menu
              setActionsMenuVisible(true); // Show both simultaneously
            }}
          />
        </SwipeableMessage>
      </>
    );
  }, [
    isGroup,
    getSenderName,
    getSenderAvatar,
    visibleTimestampId,
    toggleTimestamp,
    handleMessageLongPress,
    handleMediaPress,
    handleSwipeToReply,
  ]);

  /**
   * Generate unique key for each message group
   */
  const getGroupKey = useCallback((item: FormattedMessageGroup, index: number) => {
    return `group-${item.dayKey}-${index}-${item.messages[0]?.id || 'empty'}`;
  }, []);

  const canSend = inputText.trim().length > 0;
  const canWrite = conversation?.joined !== false;
  const replyingTo = replyTo ? messages.find((m) => m.id === replyTo) : undefined;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ImageBackground
        source={ChatBackgroundImage}
        style={styles.background}
        imageStyle={styles.backgroundImage}
        resizeMode="repeat"
      >
        <ThemedView style={styles.container}>
          {/* Header */}
          <View style={styles.headerWrapper}>
            <Header
              options={{
                title: conversationMetadata.displayName,
                subtitle: conversationMetadata.contactUsername ||
                  (isGroup && conversationMetadata.groupInfo
                    ? `${conversationMetadata.groupInfo.participantCount} participants`
                    : undefined),
                leftComponents: !isLargeScreen ? [
                  <HeaderIconButton
                    key="back"
                    onPress={() => router.back()}
                  >
                    <BackArrowIcon size={20} color={theme.colors.text} />
                  </HeaderIconButton>,
                ] : [],
                rightComponents: [
                  isGroup && conversation && conversationMetadata.participants.length > 0 ? (
                    <TouchableOpacity
                      key="group-avatar"
                      onPress={handleHeaderPress}
                      activeOpacity={0.7}
                      hitSlop={MESSAGING_CONSTANTS.AVATAR_HIT_SLOP}
                    >
                      <GroupAvatar
                        participants={getOtherParticipants(conversation, currentUserId)}
                        size={MESSAGING_CONSTANTS.AVATAR_SIZE}
                        maxAvatars={2}
                      />
                    </TouchableOpacity>
                  ) : (
                    conversationMetadata.contactAvatar && (
                      <TouchableOpacity
                        key="avatar"
                        onPress={handleHeaderPress}
                        activeOpacity={0.7}
                        hitSlop={MESSAGING_CONSTANTS.AVATAR_HIT_SLOP}
                      >
                        <Avatar
                          source={{ uri: conversationMetadata.contactAvatar }}
                          size={MESSAGING_CONSTANTS.AVATAR_SIZE}
                        />
                      </TouchableOpacity>
                    )
                  ),
                ].filter(Boolean),
              }}
              hideBottomBorder={true}
              disableSticky={true}
            />
            <TouchableOpacity
              style={[
                styles.headerClickableOverlay,
                {
                  left: !isLargeScreen ? 56 : 0,
                  right: (conversationMetadata.contactAvatar || (isGroup && conversationMetadata.participants.length > 0)) ? 56 : 0,
                },
              ]}
              onPress={handleHeaderPress}
              activeOpacity={0.7}
              disabled={!conversationId || !conversation}
              hitSlop={{ top: 5, bottom: 5, left: 5, right: 5 }}
            />
          </View>

          {/* Messages List */}
          {messageGroups.length > 0 ? (
            <>
              <FlashList
                ref={flatListRef}
                data={messageGroups}
                renderItem={renderMessageGroup}
                keyExtractor={getGroupKey}
                onStartReached={handleStartReached}
                onStartReachedThreshold={0.2}
              />
              {/* Typing Indicator */}
              {typing && (
                <View style={styles.typingIndicator}>
                  <ThemedText style={styles.typingText}>
                    Someone is typing...
                  </ThemedText>
                </View>
              )}
            </>
          ) : (
            <EmptyState
              lottieSource={require('@/assets/lottie/welcome.json')}
              title="No messages yet"
              subtitle="Start the conversation!"
            />
          )}

          {/* Message Actions Menu - rendered first (will be below reactions) */}
          <MessageActionsMenu
            visible={actionsMenuVisible}
            actions={getMessageActions(selectedMessage, selectionContext)}
            onClose={() => {
              resetSelectionState();
            }}
            messagePosition={actionsMenuPosition}
            messageElement={selectedMessagePreview || undefined}
            onReactionSelect={handleReactionSelect}
          />

          {/* Full-screen attachment viewer.
              Keyed on the page it opened at, so tapping a second picture builds
              a second viewer instead of pushing a new index into this one from
              an Effect. */}
          {viewerSelection !== null && (
            <AttachmentViewer
              key={viewerSelection.items[viewerSelection.index]?.key}
              selection={viewerSelection}
              onClose={handleViewerClose}
            />
          )}

          {/* Message Info Screen */}
          <MessageInfoScreen
            visible={infoScreenVisible}
            message={selectedMessage}
            senderName={selectedMessage ? getSenderName(selectedMessage.senderId) : undefined}
            senderHandle={selectedMessage ? getSenderHandle(selectedMessage.senderId) : undefined}
            senderAvatar={selectedMessage ? getSenderAvatar(selectedMessage.senderId) : undefined}
            onClose={() => {
              setInfoScreenVisible(false);
              setSelectedMessage(null);
              setSelectedMediaId(null);
              setSelectionContext(null);
            }}
          />

          {/* Input Composer */}
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? MESSAGING_CONSTANTS.KEYBOARD_OFFSET_IOS : 0}
          >
            {/* A second device that has not been added to the group yet can
                read nothing and send nothing; saying so beats a composer that
                silently fails. */}
            {!canWrite && (
              <View style={styles.notJoinedBanner}>
                <ThemedText style={styles.notJoinedText}>
                  This device is being added to the conversation…
                </ThemedText>
              </View>
            )}
            {/* Rewrite mode. Without a way out of it, the next thing the user
                typed would silently replace an old message instead of sending. */}
            {editingMessageId !== undefined && (
              <View style={styles.editingBanner}>
                <ThemedText style={styles.editingBannerText}>Editing message</ThemedText>
                <TouchableOpacity
                  onPress={handleCancelEdit}
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel editing"
                >
                  <CloseIcon size={18} color={theme.colors.textSecondary} />
                </TouchableOpacity>
              </View>
            )}
            {/* Reply mode, with the same way out. */}
            {editingMessageId === undefined && replyTo !== undefined && (
              <View style={styles.editingBanner}>
                <ThemedText style={styles.editingBannerText} numberOfLines={1}>
                  {`Replying to ${replyingTo ? (replyingTo.isSent ? 'yourself' : getSenderName(replyingTo.senderId) ?? '') : ''}`.trim()}
                </ThemedText>
                <TouchableOpacity
                  onPress={handleCancelReply}
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel reply"
                >
                  <CloseIcon size={18} color={theme.colors.textSecondary} />
                </TouchableOpacity>
              </View>
            )}
            <View style={styles.inputContainer}>
              {/* Attach Button */}
              <TouchableOpacity
                style={styles.attachButton}
                onPress={handleAttach}
                activeOpacity={0.7}
                disabled={!canWrite}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Plus
                  color={theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5}
                  size={24}
                />
              </TouchableOpacity>

              {/* Input Wrapper */}
              <View style={styles.inputWrapper}>
                <TextInput
                  ref={inputRef}
                  style={styles.input}
                  value={inputText}
                  onChangeText={handleInputChange}
                  placeholder="Message"
                  placeholderTextColor={theme.colors.textSecondary}
                  multiline
                  editable={canWrite}
                  maxLength={MESSAGING_CONSTANTS.INPUT_MAX_LENGTH}
                  textAlignVertical="top"
                  returnKeyType={canSend ? "send" : "default"}
                  blurOnSubmit={false}
                  onSubmitEditing={handleSubmitEditing}
                  onKeyPress={handleKeyPress}
                  enablesReturnKeyAutomatically={true}
                />

                {/* Emoji Button - Show when input is empty */}
                {!canSend && (
                  <TouchableOpacity
                    style={styles.emojiButton}
                    onPress={handleEmoji}
                    activeOpacity={0.7}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <EmojiIcon
                      color={theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5}
                      size={22}
                    />
                  </TouchableOpacity>
                )}
              </View>

              {/* Mic/Send Button */}
              <MicSendButton
                hasText={canSend}
                onSend={handleSend}
                currentSize={messageTextSize}
                tempSize={tempTextSize}
                isAdjusting={isSizeAdjusting}
                onSizeChange={setTempTextSize}
                onAdjustingChange={setIsSizeAdjusting}
                baseSizeRef={baseTextSize}
                panY={panY}
                scale={scale}
                onRecordStart={() => {
                }}
                // The recorder reports seconds; `toVoiceAttachment` converts.
                onRecordEnd={(uri, duration) => {
                  void sendAttachments([toVoiceAttachment(uri, duration)]);
                }}
                onRecordCancel={() => {
                }}
              />
            </View>
          </KeyboardAvoidingView>
        </ThemedView>
      </ImageBackground>
    </SafeAreaView>
  );
}

/** What the SDK is told about an attachment: the picker's description, minus the URI it has already read. */
function uploadMeta(attachment: AlloOutgoingAttachment) {
  return {
    kind: attachment.kind,
    filename: attachment.filename,
    mime: attachment.mimetype,
    width: attachment.width,
    height: attachment.height,
    durationMs: attachment.durationMs,
    caption: attachment.caption,
  };
}
