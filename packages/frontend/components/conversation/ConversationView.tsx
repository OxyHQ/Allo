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
import { FlashList } from '@shopify/flash-list';
import { useSharedValue } from 'react-native-reanimated';
import { useRouter, usePathname, useSegments } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import LottieView from 'lottie-react-native';
import { useTranslation } from 'react-i18next';

// New conversation-specific UI components
import { AttachmentSheet } from '@/components/conversation/AttachmentSheet';
import { EmojiPicker } from '@/components/conversation/EmojiPicker';
import { MediaViewer } from '@/components/conversation/MediaViewer';
import { ForwardSheet } from '@/components/conversation/ForwardSheet';
import { DeleteMessageSheet } from '@/components/conversation/DeleteMessageSheet';
import { useVoiceRecorder } from '@/components/conversation/VoiceRecorder';
import { resolveMediaUrl } from '@/utils/uploadAttachment';
import { toast } from '@/lib/sonner';
import type { MediaItem, AttachmentPayload } from '@/stores/messagesStore';

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
import { MessageActionsMenu, MessageAction } from '@/components/messages/MessageActionsMenu';
import { MessageInfoScreen } from '@/components/messages/MessageInfoScreen';
import { SwipeableMessage } from '@/components/messages/SwipeableMessage';
import { MediaCarousel } from '@/components/messages/MediaCarousel';
import { MicSendButton } from '@/components/messages/MicSendButton';
import { EmptyState } from '@/components/shared/EmptyState';
import { ReplyIcon } from '@/assets/icons/reply-icon';
import { ForwardIcon } from '@/assets/icons/forward-icon';
import { CopyIcon } from '@/assets/icons/copy-icon';
import { TrashIcon } from '@/assets/icons/trash-icon';

// Icons
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Ionicons } from '@expo/vector-icons';

const IconAdapter = Ionicons as any;
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
import {
  getConversationDisplayName,
  getConversationAvatar,
  getOtherParticipants,
  isGroupConversation,
  useContactInfo,
} from '@/utils/conversationUtils';
import { getConversationId, useSenderName } from '@/utils/conversationHelpers';
import { useMessagesStore, useChatUIStore, useMessagePreferencesStore } from '@/stores';
import { useOxy } from '@oxyhq/services';
import { useUserById } from '@/stores/usersStore';
import { useUsersStore } from '@/stores/usersStore';
import { useRealtimeMessaging } from '@/hooks/useRealtimeMessaging';
import { useSubscribePresence } from '@/hooks/usePresence';
import { usePresence } from '@/stores/presenceStore';
import { formatRelativeLastSeen } from '@/utils/dateUtils';
import { useCallsStore } from '@/stores/callsStore';
import { useTypingIndicator } from '@/hooks/useTypingIndicator';
import { useSenderInfo } from '@/hooks/useSenderInfo';

// Constants
import { MESSAGING_CONSTANTS } from '@/constants/messaging';

// Utils
import { groupMessagesByTime, formatMessageGroupsWithDays, FormattedMessageGroup } from '@/utils/messageGrouping';

// Import Message type from store
import type { Message } from '@/stores';

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
  const username = isUsernameRoute ? conversationIdOrUsername.substring(1) : undefined;

  // For username routes, we'll resolve to conversation ID in useEffect
  // For now, use the ID directly if it's not a username
  const conversationId = isUsernameRoute ? undefined : conversationIdOrUsername;

  // Get conversation data early so we can use its theme
  const conversation = useConversation(conversationId);

  // Use conversation-specific theme (falls back to global theme if no conversation theme set)
  const theme = useConversationTheme(conversation?.theme);

  // Initialize realtime messaging and typing indicator hooks
  const { sendTypingIndicator } = useRealtimeMessaging(conversationId);
  const typingUserIds = useTypingIndicator(conversationId);

  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });

  // Get messages from store (direct access with stable empty array reference)
  const messages = useMessagesStore(state =>
    conversationId ? (state.messagesByConversation[conversationId] || EMPTY_MESSAGES) : EMPTY_MESSAGES
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
  const isLoading = useMessagesStore(state =>
    conversationId ? state.isLoading(conversationId) : false
  );

  // Get UI state from store - access directly from state for reactivity
  const inputText = useChatUIStore(state =>
    conversationId ? (state.inputTextByConversation[conversationId] || '') : ''
  );
  const visibleTimestampId = useChatUIStore(state =>
    conversationId ? state.getVisibleTimestampId(conversationId) : null
  );

  // Get store actions (using selectors to avoid re-renders)
  const fetchMessages = useMessagesStore(state => state.fetchMessages);
  const clearConversationUI = useChatUIStore(state => state.clearConversationUI);
  const setInputText = useChatUIStore(state => state.setInputText);
  const setVisibleTimestamp = useChatUIStore(state => state.setVisibleTimestamp);
  const sendMessage = useMessagesStore(state => state.sendMessage);
  const sendAttachmentMessage = useMessagesStore(state => state.sendAttachmentMessage);
  const deleteMessageForScope = useMessagesStore(state => state.deleteMessageForScope);
  const { t } = useTranslation();


  const flatListRef = useRef<any>(null);
  const inputRef = useRef<TextInput>(null);
  const lastFetchedConversationId = useRef<string | null>(null);
  const typingTimeoutRef = useRef<any>(null);

  // Message actions state
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [selectionContext, setSelectionContext] = useState<SelectionContext | null>(null);
  const [actionsMenuVisible, setActionsMenuVisible] = useState(false);
  const [actionsMenuPosition, setActionsMenuPosition] = useState<{ x: number; y: number; width?: number; height?: number } | undefined>();
  const [infoScreenVisible, setInfoScreenVisible] = useState(false);

  // Fullscreen media viewer state
  const [mediaViewerState, setMediaViewerState] = useState<{
    visible: boolean;
    media: MediaItem[];
    initialIndex: number;
  }>({ visible: false, media: [], initialIndex: 0 });

  // Resolve the (direct) recipient user id for this conversation
  const recipientUserId = useMemo(() => {
    if (!conversation) return undefined;
    const others = getOtherParticipants(conversation, currentUserId);
    return others[0]?.id;
  }, [conversation, currentUserId]);
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

  // Online presence for the direct recipient (no-op for groups). Bootstraps via
  // REST + subscribes to live `presence:update`; the row reads its own entry.
  const presenceUserIds = useMemo(
    () => (!isGroup && recipientUserId ? [recipientUserId] : []),
    [isGroup, recipientUserId]
  );
  useSubscribePresence(presenceUserIds);
  const recipientPresence = usePresence(!isGroup ? recipientUserId : undefined);

  // Header subtitle: for a 1:1 chat show live presence (online / last seen);
  // when presence is unknown (no entry yet) fall back to the contact username.
  // For groups keep the participant-count subtitle.
  const headerSubtitle = useMemo<string | undefined>(() => {
    if (isGroup) {
      return conversationMetadata.groupInfo
        ? `${conversationMetadata.groupInfo.participantCount} participants`
        : undefined;
    }
    if (recipientPresence?.online) {
      return t('presence.online', 'Online');
    }
    if (recipientPresence && recipientPresence.lastSeenAt) {
      return t('presence.lastSeen', {
        time: formatRelativeLastSeen(recipientPresence.lastSeenAt, t),
        defaultValue: 'Last seen {{time}}',
      });
    }
    return conversationMetadata.contactUsername;
  }, [isGroup, recipientPresence, conversationMetadata.groupInfo, conversationMetadata.contactUsername, t]);

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
    typingIndicator: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      flexDirection: 'row',
      alignItems: 'center',
    },
    typingText: {
      fontSize: 14,
      fontStyle: 'italic',
      color: theme.colors.textSecondary,
    },
    sizeIndicator: {
      position: 'absolute',
      bottom: 60,
      alignSelf: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
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
          sendTypingIndicator(true);
          lastTypingEmitRef.current = now;
        }
        // Stop typing after 3 seconds of no input
        typingTimeoutRef.current = setTimeout(() => {
          sendTypingIndicator(false);
          lastTypingEmitRef.current = 0;
          typingTimeoutRef.current = null;
        }, 3000);
      } else {
        sendTypingIndicator(false);
        lastTypingEmitRef.current = 0;
      }
    }
  }, [conversationId, setInputText, sendTypingIndicator]);

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
    sendTypingIndicator(false);

    // Clear input immediately for better UX (before sending)
    if (conversationId) {
      setInputText(conversationId, '');
    }

    // Temporarily set the size if it was adjusted
    if (sizeToUse && sizeToUse !== messageTextSize) {
      setMessageTextSize(sizeToUse);
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
        const { toast } = await import('@/lib/sonner');
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
      const { toast } = await import('@/lib/sonner');
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
  }, [conversationId, inputText, sendMessage, setInputText, messageTextSize, setMessageTextSize, recipientUserId, currentUserId, sendTypingIndicator]);

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
   * Dispatch a prepared attachment payload (uploaded media / location / poll / …)
   * through the encrypted message pipeline.
   */
  const dispatchAttachmentPayload = useCallback(
    async (payload: AttachmentPayload) => {
      if (!conversationId || !currentUserId || !recipientUserId) {
        toast.error(t('chat.uploadFailed'));
        return;
      }
      try {
        const result = await sendAttachmentMessage(
          conversationId,
          payload,
          currentUserId,
          recipientUserId
        );
        if (!result) {
          toast.error(t('chat.uploadFailed'));
        } else {
          setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
        }
      } catch (error) {
        console.error('[Conversation] dispatchAttachmentPayload error:', error);
        toast.error(t('chat.uploadFailed'));
      }
    },
    [conversationId, currentUserId, recipientUserId, sendAttachmentMessage, t]
  );

  /**
   * Open the attachment grid (photos, documents, location, camera, contact, poll).
   */
  const handleAttach = useCallback(() => {
    if (!bottomSheet) return;

    const closeSheet = () => bottomSheet.openBottomSheet(false);

    bottomSheet.setBottomSheetContent(
      <AttachmentSheet
        onSendAttachment={(payload) => {
          closeSheet();
          void dispatchAttachmentPayload(payload);
        }}
        openSubSheet={(content) => {
          bottomSheet.setBottomSheetContent(content);
          bottomSheet.openBottomSheet(true);
        }}
        closeSheet={closeSheet}
      />
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, dispatchAttachmentPayload]);

  /**
   * Open the emoji picker in a bottom sheet and insert the selected emoji
   * at the end of the current input text.
   */
  const handleEmoji = useCallback(() => {
    if (!bottomSheet || !conversationId) return;
    const closeSheet = () => bottomSheet.openBottomSheet(false);
    bottomSheet.setBottomSheetContent(
      <EmojiPicker
        onSelect={(emoji) => {
          const currentState = useChatUIStore.getState();
          const existing = currentState.inputTextByConversation[conversationId] || '';
          setInputText(conversationId, existing + emoji);
        }}
        onClose={closeSheet}
      />
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, conversationId, setInputText]);

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
   * Get media URL from media ID. We prefer the `url` cached on the MediaItem
   * (set when the asset was uploaded through our local backend) and fall back
   * to `oxyServices.getFileDownloadUrl` for assets stored in the Oxy CDN.
   */
  const getMediaUrl = useCallback(
    (mediaId: string): string => {
      // Search all messages for the matching media item so we can read its `url`
      const found = messages
        .flatMap((m) => m.media || [])
        .find((m) => m.id === mediaId);
      return resolveMediaUrl(mediaId, oxyServices, {
        url: found?.url,
        variant: 'full',
      });
    },
    [messages, oxyServices]
  );
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
   * Open the fullscreen media viewer at the tapped item.
   * The viewer pages through all media of the message that contains it.
   */
  const handleMediaPress = useCallback(
    (mediaId: string, _index: number) => {
      const owningMessage = messages.find((m) => m.media?.some((media) => media.id === mediaId));
      const messageMedia = owningMessage?.media || [];
      const visualMedia = messageMedia.filter(
        (m) => m.type === 'image' || m.type === 'video' || m.type === 'gif'
      );
      const localIndex = Math.max(0, visualMedia.findIndex((m) => m.id === mediaId));
      if (visualMedia.length === 0) return;
      setMediaViewerState({
        visible: true,
        media: visualMedia,
        initialIndex: localIndex,
      });
    },
    [messages]
  );

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
      const currentReactions = selectedMessage.reactions || {};
      const hasReacted = currentReactions[emoji]?.includes(currentUserId || '') || false;

      if (hasReacted) {
        await removeReaction(conversationId, selectedMessage.id, emoji);
      } else {
        await addReaction(conversationId, selectedMessage.id, emoji);
      }
    } catch (error) {
      console.error('[Conversation] Error toggling reaction:', error);
      const { toast } = await import('@/lib/sonner');
      toast.error('Failed to update reaction');
    } finally {
      resetSelectionState();
    }
  }, [selectedMessage, conversationId, currentUserId, addReaction, removeReaction, resetSelectionState]);

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
   * Handle forward action — opens the multi-select forward sheet.
   */
  const handleForward = useCallback(
    (message: Message) => {
      resetSelectionState({ preserveMessage: false });
      if (!bottomSheet) return;
      const closeSheet = () => bottomSheet.openBottomSheet(false);
      bottomSheet.setBottomSheetContent(
        <ForwardSheet message={message} onClose={closeSheet} />
      );
      bottomSheet.openBottomSheet(true);
    },
    [resetSelectionState, bottomSheet]
  );

  /**
   * Handle copy action
   */
  const handleCopy = useCallback(async (message: Message) => {
    resetSelectionState({ preserveMessage: true });
    try {
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(message.text || '');
      toast.success(t('chat.copySuccess'));
    } catch (error) {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(message.text || '');
        toast.success(t('chat.copySuccess'));
      } else {
        toast.error(t('chat.copyFailed'));
      }
    }
  }, [resetSelectionState, t]);

  /**
   * Handle delete action — opens the "delete for me / for everyone" sheet.
   */
  const handleDelete = useCallback(
    (message: Message) => {
      resetSelectionState({ preserveMessage: false });
      if (!bottomSheet || !conversationId) return;

      const isOwn = message.senderId === currentUserId;
      const closeSheet = () => bottomSheet.openBottomSheet(false);

      const runDelete = async (scope: 'me' | 'everyone') => {
        closeSheet();
        const ok = await deleteMessageForScope(conversationId, message.id, scope);
        if (ok) toast.success(t('chat.deleteSuccess'));
        else toast.error(t('chat.deleteFailed'));
      };

      bottomSheet.setBottomSheetContent(
        <DeleteMessageSheet
          canDeleteForEveryone={isOwn}
          onDeleteForMe={() => void runDelete('me')}
          onDeleteForEveryone={() => void runDelete('everyone')}
          onCancel={closeSheet}
        />
      );
      bottomSheet.openBottomSheet(true);
    },
    [resetSelectionState, bottomSheet, conversationId, currentUserId, deleteMessageForScope, t]
  );

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
      {
        label: 'Delete',
        icon: <TrashIcon size={20} color="#FF3B30" />,
        onPress: () => handleDelete(message),
        destructive: true,
      },
    ];
    if (context === 'media') {
      return actions.filter(action => action.label !== 'Copy');
    }
    return actions;
  }, [theme.colors.text, handleReply, handleForward, handleCopy, handleInfo, handleDelete]);

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

  // Voice recorder hooks
  const voiceRecorder = useVoiceRecorder({
    conversationId: conversationId || '',
    senderId: currentUserId,
    recipientUserId,
  });

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
                subtitle: headerSubtitle,
                leftComponents: !isLargeScreen ? [
                  <HeaderIconButton
                    key="back"
                    onPress={() => router.back()}
                  >
                    <BackArrowIcon size={20} color={theme.colors.text} />
                  </HeaderIconButton>,
                ] : [],
                rightComponents: [
                  // Voice + video call buttons (1:1 conversations only).
                  !isGroup && recipientUserId ? (
                    <HeaderIconButton
                      key="call-voice"
                      onPress={() => {
                        void useCallsStore
                          .getState()
                          .startCall(recipientUserId, 'audio', conversationId)
                          .then(() => {
                            const active = useCallsStore.getState().active;
                            if (active) {
                              router.push(`/(chat)/call/${active.callId}` as any);
                            }
                          });
                      }}
                    >
                      <IconAdapter name="call-outline" size={20} color={theme.colors.text} />
                    </HeaderIconButton>
                  ) : null,
                  !isGroup && recipientUserId ? (
                    <HeaderIconButton
                      key="call-video"
                      onPress={() => {
                        void useCallsStore
                          .getState()
                          .startCall(recipientUserId, 'video', conversationId)
                          .then(() => {
                            const active = useCallsStore.getState().active;
                            if (active) {
                              router.push(`/(chat)/call/${active.callId}` as any);
                            }
                          });
                      }}
                    >
                      <IconAdapter name="videocam-outline" size={20} color={theme.colors.text} />
                    </HeaderIconButton>
                  ) : null,
                  isGroup && conversationMetadata.participants.length > 0 ? (
                    <TouchableOpacity
                      key="group-avatar"
                      onPress={handleHeaderPress}
                      activeOpacity={0.7}
                      hitSlop={MESSAGING_CONSTANTS.AVATAR_HIT_SLOP}
                    >
                      <GroupAvatar
                        participants={getOtherParticipants(conversation!, currentUserId)}
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
                ref={flatListRef as any}
                data={messageGroups}
                renderItem={renderMessageGroup}
                keyExtractor={getGroupKey}
                estimatedItemSize={80}
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

          {/* Fullscreen media viewer */}
          <MediaViewer
            visible={mediaViewerState.visible}
            media={mediaViewerState.media}
            initialIndex={mediaViewerState.initialIndex}
            getMediaUrl={getMediaUrl}
            onClose={() =>
              setMediaViewerState((prev) => ({ ...prev, visible: false }))
            }
          />

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
            <View style={styles.inputContainer}>
              {/* Attach Button */}
              <TouchableOpacity
                style={styles.attachButton}
                onPress={handleAttach}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Plus
                  color={theme.colors.textSecondary}
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
                      color={theme.colors.textSecondary}
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
                onRecordStart={voiceRecorder.handleRecordStart}
                onRecordEnd={voiceRecorder.handleRecordEnd}
                onRecordCancel={voiceRecorder.handleRecordCancel}
              />
            </View>
          </KeyboardAvoidingView>
        </ThemedView>
      </ImageBackground>
    </SafeAreaView>
  );
}
