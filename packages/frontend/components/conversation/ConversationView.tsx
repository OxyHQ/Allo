import React, { useMemo, useRef, useEffect, useContext, useCallback, useState } from 'react';
import {
  ActivityIndicator,
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
import LottieView from 'lottie-react-native';
import { toast } from '@oxyhq/bloom/toast';

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
import { useTheme } from '@/hooks/useTheme';
import { useConversationTheme } from '@/hooks/useConversationTheme';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { useConversation } from '@/hooks/useConversation';
import { useConversationMetadata } from '@/hooks/useConversationMetadata';

// Context
import { BottomSheetContext } from '@/context/BottomSheetContext';

// Utils
import { colors } from '@/styles/colors';
import {
  getOtherParticipants,
  isGroupConversation,
  useContactInfo,
} from '@/utils/conversationUtils';
import { getConversationId, useSenderName } from '@/utils/conversationHelpers';
import { logger } from '@/utils/logger';
import { useMessagesStore, useChatUIStore, useMessagePreferencesStore } from '@/stores';
import { useOxy } from '@oxyhq/services';
import { useUserById } from '@/stores/usersStore';
import { useUsersStore } from '@/stores/usersStore';
import { useRealtimeMessaging } from '@/hooks/useRealtimeMessaging';
import { useTypingIndicator } from '@/hooks/useTypingIndicator';
import { useSenderInfo } from '@/hooks/useSenderInfo';
// Matrix chat backend (behind EXPO_PUBLIC_CHAT_BACKEND)
import { CHAT_BACKEND } from '@/lib/chat/backend';
import { useMatrixTimeline } from '@/hooks/useMatrixTimeline';
import { useMatrixMedia } from '@/hooks/useMatrixMedia';
import {
  captureMediaAttachment,
  pickDocumentAttachments,
  pickMediaAttachments,
  toVoiceAttachment,
  type PickedAttachments,
} from '@/lib/chat/attachments';
import { selectViewerItem, type ViewerSelection } from '@/lib/chat/attachmentViewer';

// Constants
import { MESSAGING_CONSTANTS } from '@/constants/messaging';

// Utils
import { groupMessagesByTime, formatMessageGroupsWithDays, FormattedMessageGroup } from '@/utils/messageGrouping';

// Import Message type from store
import type { MediaItem, Message } from '@/stores';
import { mediaVariantForKind } from '@/utils/mediaVariant';

/**
 * ConversationView component props
 */
interface ConversationViewProps {
  conversationId?: string;
  username?: string; // For username-based routing
}

type SelectionContext = 'text' | 'media';

// Get current user ID from Oxy hook (will be used in component)

// Stable empty array to prevent Zustand selector from creating new references
const EMPTY_MESSAGES: Message[] = [];

// Stable empty style for FlashList contentContainer
const MESSAGE_LIST_CONTENT_STYLE = { paddingVertical: 8 };

// Shown above the oldest loaded message while the homeserver is being asked for
// more. Declared once, at module scope, so the list header is not a new element
// type on every render.
const olderMessagesStyles = StyleSheet.create({
  spinner: { paddingVertical: 12 },
});

const OlderMessagesSpinner = (
  <View style={olderMessagesStyles.spinner}>
    <ActivityIndicator />
  </View>
);


/**
 * ConversationView Component
 * 
 * Displays a conversation with messages, input, and header.
 * Supports both direct and group conversations with responsive layouts.
 * 
 * Features:
 * - Tap to toggle message timestamps (only one visible at a time)
 * - Group conversation sender names
 * - Responsive header with contact/group details
 * - Keyboard-aware input
 * 
 * @example
 * ```tsx
 * <ConversationView conversationId="1" />
 * ```
 */
export default function ConversationView({ conversationId: propConversationId }: ConversationViewProps = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const segments = useSegments();
  const bottomSheet = useContext(BottomSheetContext);
  const messageTextSize = useMessagePreferencesStore((state) => state.messageTextSize ?? MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE);
  const setMessageTextSize = useMessagePreferencesStore((state) => state.setMessageTextSize);
  const { user, oxyServices } = useOxy();
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
  const username = isUsernameRoute ? conversationIdOrUsername?.substring(1) : undefined;

  // For username routes, we'll resolve to conversation ID in useEffect
  // For now, use the ID directly if it's not a username
  const conversationId = isUsernameRoute ? undefined : conversationIdOrUsername;

  // Get conversation data early so we can use its theme
  const conversation = useConversation(conversationId);

  // Use conversation-specific theme (falls back to global theme if no conversation theme set)
  const theme = useConversationTheme(conversation?.theme);

  // Initialize realtime messaging and typing indicator hooks
  const { sendTypingIndicator } = useRealtimeMessaging(conversationId);
  const storedTypingUserIds = useTypingIndicator(conversationId);

  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });

  // Get messages from store (direct access with stable empty array reference)
  const storedMessages = useMessagesStore(state =>
    conversationId ? (state.messagesByConversation[conversationId] || EMPTY_MESSAGES) : EMPTY_MESSAGES
  );

  // ...or from the Matrix port, which is `undefined` unless this build's chat
  // backend is Matrix. The room's timeline is a live view over the sync loop, so
  // there is no fetch: opening it is subscribing to it.
  const matrixTimeline = useMatrixTimeline(conversationId);
  const messages = matrixTimeline?.messages ?? storedMessages;

  // Attachments the port has fetched and decrypted, keyed by the media refs the
  // messages above carry. `undefined` on the Express path, where a media id is
  // an Oxy Cloud file id instead — see `getMediaUrl`.
  const matrixMedia = useMatrixMedia();

  // The store-backed indicator is re-emitted as a DOM event and so only ever
  // fires on web; the port's comes from the homeserver and works everywhere.
  const typingUserIds = matrixTimeline?.typingUserIds ?? storedTypingUserIds;

  /**
   * Says the viewer is typing, wherever this conversation lives.
   *
   * The throttling around this — one notice per five seconds, a stop after three
   * idle — belongs to the composer and is the same either way; only the wire
   * changes.
   */
  const notifyTyping = useCallback(
    (isTyping: boolean) => {
      if (matrixTimeline) {
        matrixTimeline.setTyping(isTyping);
        return;
      }
      sendTypingIndicator(isTyping);
    },
    [matrixTimeline, sendTypingIndicator],
  );

  // Group messages by time and format with day separators
  const messageGroups = useMemo(() => {
    if (messages.length === 0) {
      return [];
    }
    const groups = groupMessagesByTime(messages);
    return formatMessageGroupsWithDays(groups);
  }, [messages]);

  // Get loading state
  const storedIsLoading = useMessagesStore(state =>
    conversationId ? state.isLoading(conversationId) : false
  );
  const isLoading = matrixTimeline?.isLoading ?? storedIsLoading;

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
  const fetchMessages = useMessagesStore(state => state.fetchMessages);
  const clearConversationUI = useChatUIStore(state => state.clearConversationUI);
  const setInputText = useChatUIStore(state => state.setInputText);
  const setVisibleTimestamp = useChatUIStore(state => state.setVisibleTimestamp);
  const setEditing = useChatUIStore(state => state.setEditing);
  const sendMessage = useMessagesStore(state => state.sendMessage);

  /**
   * Tell the homeserver the newest message here has been seen.
   *
   * An Effect because it is the one thing on this screen that is neither derived
   * state nor a response to something the user did: nobody taps "I have read
   * this", and the fact being reported — that a conversation with these messages
   * in it is on screen — only exists after the render that put them there. It is
   * a write to an external system, which is the case Effects are for.
   *
   * Keyed on the newest message rather than on the list, so scrolling, a
   * reaction, or an edit does not re-send. Re-running is harmless anyway: the
   * source drops a receipt for an event it has already sent one for.
   */
  const markRead = matrixTimeline?.markRead;
  const newestMessageId = messages.length > 0 ? messages[messages.length - 1].id : undefined;
  useEffect(() => {
    markRead?.();
  }, [markRead, newestMessageId]);


  const flatListRef = useRef<FlashListRef<FormattedMessageGroup> | null>(null);
  const inputRef = useRef<TextInput>(null);
  const lastFetchedConversationId = useRef<string | null>(null);
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

  // Fetch messages when conversation changes
  useEffect(() => {
    if (!conversationId) return;

    // Only fetch if this is a different conversation
    if (lastFetchedConversationId.current === conversationId) {
      return; // Already fetched this conversation
    }

    lastFetchedConversationId.current = conversationId;

    // Clear UI state when switching conversations
    clearConversationUI(conversationId);

    // A Matrix timeline is not fetched: it is a live view the port opens over
    // the sync loop, and asking the Express API for this room's messages would
    // request a conversation that does not exist there.
    if (CHAT_BACKEND === 'matrix') return;

    // Fetch messages (store will handle duplicate requests)
    if (currentUserId) {
      fetchMessages(conversationId, currentUserId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, currentUserId]); // Fetch when conversation or user changes

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

  /**
   * Handle header press to show contact/group details
   * On mobile: opens bottom sheet
   * On desktop: details are already visible in right pane
   */
  const handleHeaderPress = useCallback(() => {
    if (!conversationId || !conversation || !bottomSheet) return;

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
          participants={conversationMetadata.participants}
          groupName={conversationMetadata.groupInfo?.name}
          groupAvatar={conversationMetadata.groupInfo?.avatar}
          currentUserId={currentUserId}
          conversationTheme={conversation?.theme}
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
      backgroundColor: theme.colors.background || '#FFFFFF',
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border || 'rgba(0,0,0,0.08)',
    },
    inputWrapper: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'flex-end',
      minHeight: 36,
      maxHeight: 100,
      borderRadius: 20,
      backgroundColor: '#F0F0F0',
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
      color: '#000000',
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
    sizeIndicator: {
      position: 'absolute',
      bottom: 60,
      alignSelf: 'center',
      backgroundColor: theme.colors.card || '#FFFFFF',
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 8,
      borderWidth: 1,
      borderColor: theme.colors.border || 'rgba(0,0,0,0.1)',
    },
    sizeIndicatorText: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.text,
    },
    sizePreview: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: 4,
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

  const handleSend = useCallback(async (sizeToUse?: number) => {
    if (!conversationId || inputText.trim().length === 0) return;

    const text = inputText.trim();
    const originalSize = messageTextSize;
    const finalSize = sizeToUse ?? messageTextSize;

    // Clear typing timeout and stop typing indicator
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    notifyTyping(false);

    // Clear input immediately for better UX (before sending)
    if (conversationId) {
      setInputText(conversationId, '');
    }

    // Temporarily set the size if it was adjusted
    if (sizeToUse && sizeToUse !== messageTextSize) {
      setMessageTextSize(sizeToUse);
    }

    // On Matrix a message is addressed to a room, not to a recipient: there is
    // no device list to encrypt for by hand and no user id to look up, because
    // the room's members and their devices are the homeserver's business and the
    // SDK's. Everything below this branch exists to satisfy the Signal
    // implementation, which needs to know who it is encrypting for.
    //
    // The per-message font size does not survive this path. `AlloTimelineHandle`
    // sends a body and nothing else, and Allo's font size is meant to travel as
    // `so.oxy.allo.font_size` inside the encrypted content
    // (`docs/matrix/data-model.md` §4.2) — which the port has no call for yet.
    // The gesture still adjusts the composer; it just does not reach the message.
    if (matrixTimeline) {
      try {
        // The same composer, sending or rewriting. An edit keeps the original
        // event's place and timestamp on every client in the room; only the body
        // changes, which is why the row does not move when this returns.
        if (editingMessageId !== undefined) {
          await matrixTimeline.edit(editingMessageId, text);
          setEditing(conversationId, undefined);
        } else {
          await matrixTimeline.send(text);
        }
      } catch (error) {
        console.error('Error sending message:', error);
        const errorMessage = error instanceof Error ? error.message : 'Failed to send message. Please try again.';
        toast.error(errorMessage);
        setInputText(conversationId, text);
        return;
      }

      if (sizeToUse && sizeToUse !== originalSize) {
        setMessageTextSize(originalSize);
        setTempTextSize(originalSize);
      }
      setIsSizeAdjusting(false);

      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return;
    }

    // Get recipient user ID from conversation
    // For direct messages, get the other participant
    // For groups, we'll need to handle multiple recipients (for now, use first other participant)
    let recipientUserId: string | undefined;
    if (conversation) {
      if (isGroup) {
        // For groups, get the first other participant (in a real implementation, 
        // we'd send to all participants, but for now use first one)
        const otherParticipants = getOtherParticipants(conversation, currentUserId);
        recipientUserId = otherParticipants[0]?.id;
      } else {
        // For direct messages, get the other participant
        const otherParticipants = getOtherParticipants(conversation, currentUserId);
        recipientUserId = otherParticipants[0]?.id;
      }
    }

    if (!recipientUserId || !currentUserId) {
      console.error('Cannot send message: missing recipient or current user ID');
      if (conversationId) {
        setInputText(conversationId, text);
      }
      return;
    }

    // Send message via store with custom font size if adjusted
    try {
      const result = await sendMessage(conversationId, text, currentUserId, recipientUserId, sizeToUse && sizeToUse !== originalSize ? sizeToUse : undefined);

      if (!result) {
        // Message failed to send - check for error in store
        const error = useMessagesStore.getState().getError(conversationId);
        toast.error(error || 'Failed to send message. Please try again.');

        // Restore text on error
        if (conversationId) {
          setInputText(conversationId, text);
        }
        return;
      }

      // Scroll to bottom after sending
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to send message. Please try again.';
      toast.error(errorMessage);

      // Restore text on error
      if (conversationId) {
        setInputText(conversationId, text);
      }
      return; // Don't continue with cleanup if there was an error
    }

    // Reset size immediately (message stores its own fontSize)
    if (sizeToUse && sizeToUse !== originalSize) {
      setMessageTextSize(originalSize);
      setTempTextSize(originalSize);
    }
    setIsSizeAdjusting(false);

    // Ensure input is cleared (double-check)
    if (conversationId) {
      setInputText(conversationId, '');
    }

    // Refocus input after sending
    setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
  }, [conversationId, inputText, sendMessage, setInputText, messageTextSize, setMessageTextSize, conversation, isGroup, currentUserId, matrixTimeline, notifyTyping, editingMessageId, setEditing]);

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
   * Sends one attachment, and says so when it does not go.
   *
   * Attachments exist on the Matrix path only, and that is a property of the
   * backend rather than a gap in this screen: Allo's Express API has never had
   * an upload endpoint, and the homeserver's media repository is what replaces
   * it. A build talking to the old backend says so instead of opening a picker
   * that leads nowhere.
   *
   * Failures are shown rather than logged. An upload is something the user
   * started and waited for, and the one that matters most —
   * `MatrixMediaEncryptionUnknownError`, raised when the conversation's
   * encryption state has not synced yet — is recovered from by trying again,
   * which nobody does if nothing said anything.
   */
  const sendAttachments = useCallback(async (attachments: PickedAttachments) => {
    if (attachments.length === 0) {
      return;
    }
    if (!matrixTimeline) {
      toast.error('Attachments need the Matrix chat backend.');
      return;
    }
    for (const attachment of attachments) {
      try {
        await matrixTimeline.sendAttachment(attachment);
      } catch (error) {
        console.error('Error sending attachment:', error);
        toast.error(
          error instanceof Error ? error.message : 'The attachment could not be sent.'
        );
        return;
      }
    }
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [matrixTimeline]);

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
          console.error('Error choosing an attachment:', error);
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
        // Location, contact and poll are left unwired rather than stubbed. None
        // of the three is missing a picker: `m.location` is in the spec and the
        // port does not translate it, a contact card has no event type at all,
        // and a poll is MSC3381 — so each needs a decision about what Allo
        // sends before there is anything for a handler to do. See
        // `docs/matrix/ui-wiring.md` §5. An option the menu offers and silently
        // ignores is worse than one it does not offer.
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

  // Use the new hook for sender info
  const { getSenderName, getSenderAvatar } = useSenderInfo(conversation, isGroup, conversationMetadata);

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


  /**
   * Resolve a media download URL from a media ID.
   *
   * Two different resolutions behind one prop, and they must not be mixed. On
   * the Matrix path the id is the port's opaque media ref: the bytes live in
   * the homeserver's media repository, are encrypted in an encrypted room, and
   * are fetched and decrypted by the port — so the answer comes from a cache and
   * is `''` until it arrives. On the Express path the id is an Oxy Cloud file
   * id and the URL is built from it, with a rendition variant that depends on
   * the item's kind (`mediaVariantForKind`). Neither server can resolve the
   * other's identifiers.
   *
   * Returns an empty string when there is nothing yet, so the image renderer
   * surfaces its own empty state instead of a masking placeholder.
   */
  const getMediaUrl = useCallback((mediaId: string, kind: MediaItem['type']): string => {
    if (matrixMedia) {
      return matrixMedia.url(mediaId);
    }
    try {
      return oxyServices.getFileDownloadUrl(mediaId, mediaVariantForKind(kind));
    } catch (error) {
      console.error('Error getting media URL:', error);
      return '';
    }
  }, [oxyServices, matrixMedia]);

  /**
   * The same media, at full size, for the viewer.
   *
   * It differs from `getMediaUrl` on the Express path and only there. That
   * resolver asks Oxy Cloud for a rendition sized for a 250pt bubble —
   * `w1280` for a picture, `poster` (a still frame) for a video — and both are
   * the wrong answer full screen: one is soft on a modern display and the other
   * is a photograph of a video. Omitting the variant serves the bytes as
   * uploaded, which is what "full size" means.
   *
   * On the Matrix path there is nothing to choose. A media ref already names one
   * blob in the homeserver's media repository, and the viewer is given the
   * original ref rather than the thumbnail's — see `lib/chat/attachmentViewer.ts`.
   */
  const getFullMediaUrl = useCallback((mediaId: string, kind: MediaItem['type']): string => {
    if (matrixMedia) {
      return matrixMedia.url(mediaId);
    }
    try {
      return oxyServices.getFileDownloadUrl(mediaId, undefined);
    } catch (error) {
      logger.error('[Conversation] Error getting full-size media URL:', error);
      return '';
    }
  }, [oxyServices, matrixMedia]);

  /**
   * The same resolution for an attachment that is not a picture.
   *
   * Separate from `getMediaUrl` because it takes no kind. A voice note, an audio
   * file and a document have no name in `MediaItem['type']`, and the Oxy
   * rendition variant that argument picks — `w1280`, `poster` — is meaningless
   * for all three: what is wanted is the file as uploaded, which is what an
   * omitted variant serves.
   */
  const getAttachmentUrl = useCallback((source: string): string => {
    if (matrixMedia) {
      return matrixMedia.url(source);
    }
    try {
      return oxyServices.getFileDownloadUrl(source, undefined);
    } catch (error) {
      logger.error('[Conversation] Error getting attachment URL:', error);
      return '';
    }
  }, [oxyServices, matrixMedia]);

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
          getMediaUrl={getMediaUrl}
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
    getMediaUrl,
    isGroup,
    getSenderName,
  ]);

  /**
   * Opens the full-screen viewer on the picture or video that was tapped.
   *
   * The gallery is every attachment in the conversation, not just this
   * message's: a Matrix event carries one attachment, so five photographs are
   * five messages, and a viewer built from one of them could never be swiped.
   * Which page it opens on is decided in `lib/chat/attachmentViewer.ts`, from
   * the message and the media together — the same file sent twice has the same
   * media id twice.
   *
   * Both backends reach here. The viewer never learns which one: the gallery
   * comes from `Message.media`, which both fill, and the URLs come from
   * `getMediaUrl`, which is already reconciled above.
   */
  const handleMediaPress = useCallback((message: Message, mediaId: string, index: number) => {
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

  const addReaction = useMessagesStore((state) => state.addReaction);
  const removeReaction = useMessagesStore((state) => state.removeReaction);

  const handleReactionSelect = useCallback(async (emoji: string) => {
    if (!selectedMessage || !conversationId) {
      resetSelectionState();
      return;
    }

    try {
      if (matrixTimeline) {
        // One call for both directions. Which one it is depends on whether this
        // account has already annotated the event, and the port asks the SDK
        // that question against state a snapshot here could be a sync behind —
        // a reaction sent from the user's phone a moment ago, for instance.
        await matrixTimeline.toggleReaction(selectedMessage.id, emoji);
      } else {
        const currentReactions = selectedMessage.reactions || {};
        const hasReacted = currentReactions[emoji]?.includes(currentUserId || '') || false;

        if (hasReacted) {
          await removeReaction(conversationId, selectedMessage.id, emoji);
        } else {
          await addReaction(conversationId, selectedMessage.id, emoji);
        }
      }
    } catch (error) {
      console.error('[Conversation] Error toggling reaction:', error);
      toast.error('Failed to update reaction');
    } finally {
      resetSelectionState();
    }
  }, [selectedMessage, conversationId, currentUserId, addReaction, removeReaction, resetSelectionState, matrixTimeline]);

  const setReplyTo = useChatUIStore((state) => state.setReplyTo);
  const replyTo = useChatUIStore((state) => conversationId && state.replyToByConversation ? state.replyToByConversation[conversationId] : undefined);

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
  const handleForward = useCallback((message: Message) => {
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
      console.error('[Conversation] Failed to copy message to clipboard:', error);
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

  /**
   * Handle delete action
   *
   * On Matrix this is a redaction, and a redaction is not a disappearance: the
   * event keeps its place, its sender and its time on every client in the room,
   * and only its content goes. The row stays and starts drawing itself as
   * deleted, which is the protocol working — see `AlloTimelineHandle.redact`.
   */
  const handleDelete = useCallback((message: Message) => {
    resetSelectionState({ preserveMessage: true });
    if (!matrixTimeline) {
      // The Express backend has no endpoint that removes a message, so there is
      // nothing to call and no reason to pretend otherwise by clearing it here:
      // a message gone from this device and present on every other one is worse
      // than one that is still there.
      toast.error('Deleting messages is not available on this account.');
      return;
    }
    matrixTimeline.deleteMessage(message.id).catch((error: unknown) => {
      console.error('[Conversation] Error deleting message:', error);
      toast.error('Failed to delete message');
    });
  }, [resetSelectionState, matrixTimeline]);

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

    // Both only ever apply to the viewer's own messages. Matrix lets a moderator
    // redact somebody else's, but Allo does not check power levels, and an
    // action offered to everyone that works for a few is worse than one that is
    // not offered: the failure arrives after the tap, from the homeserver.
    if (message.isSent) {
      if (matrixTimeline) {
        actions.push({
          label: 'Edit',
          onPress: () => handleEdit(message),
        });
      }
      actions.push({
        label: 'Delete',
        icon: <TrashIcon size={20} color="#FF3B30" />,
        onPress: () => handleDelete(message),
        destructive: true,
      });
    }

    if (context === 'media') {
      return actions.filter(action => action.label !== 'Copy');
    }
    return actions;
  }, [theme.colors.text, handleReply, handleForward, handleCopy, handleInfo, handleEdit, handleDelete, matrixTimeline]);

  /**
   * Handle swipe to reply
   */
  const handleSwipeToReply = useCallback((message: Message) => {
    handleReply(message);
  }, [handleReply]);

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
          enabled={!isAiGroup} // Disable swipe for AI messages
          onSwipeRight={() => handleSwipeToReply(firstMessage)}
          replyIcon={<ReplyIcon size={20} color="#FFFFFF" />}
        >
          <MessageBlock
            group={group}
            isGroup={isGroup}
            getSenderName={getSenderName}
            getSenderAvatar={getSenderAvatar}
            getMediaUrl={getMediaUrl}
            getAttachmentUrl={getAttachmentUrl}
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
    getMediaUrl,
    getAttachmentUrl,
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
                // Older messages are asked for as the top of the list comes into
                // view. The store-backed path has no such call — it fetches a
                // conversation whole — so this stays undefined there and the list
                // behaves exactly as it did.
                onStartReached={matrixTimeline?.loadOlder}
                onStartReachedThreshold={0.5}
                ListHeaderComponent={
                  matrixTimeline?.isPaginating ? OlderMessagesSpinner : undefined
                }
              />
              {/* Typing Indicator */}
              {typingUserIds.length > 0 && (
                <View style={styles.typingIndicator}>
                  <ThemedText style={styles.typingText}>
                    {typingUserIds.length === 1 ? 'Someone is typing...' : `${typingUserIds.length} people are typing...`}
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
              resolveUrl={getFullMediaUrl}
              onClose={handleViewerClose}
            />
          )}

          {/* Message Info Screen */}
          <MessageInfoScreen
            visible={infoScreenVisible}
            message={selectedMessage}
            senderName={selectedMessage ? getSenderName(selectedMessage.senderId) : undefined}
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
            <View style={styles.inputContainer}>
              {/* Attach Button */}
              <TouchableOpacity
                style={styles.attachButton}
                onPress={handleAttach}
                activeOpacity={0.7}
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
                  placeholderTextColor={colors.chatInputPlaceholder || theme.colors.textSecondary || '#999999'}
                  multiline
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
