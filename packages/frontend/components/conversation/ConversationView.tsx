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
import LottieView from 'lottie-react-native';
import { toast } from '@oxy.so/bloom/toast';

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
import { useOxy } from '@oxy.so/services';
import { useUserById } from '@/stores/usersStore';
import { useUsersStore } from '@/stores/usersStore';
import { useRealtimeMessaging } from '@/hooks/useRealtimeMessaging';
import { useTypingIndicator } from '@/hooks/useTypingIndicator';
import { useSenderInfo } from '@/hooks/useSenderInfo';
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
  const messages = useMessagesStore(state =>
    conversationId ? (state.messagesByConversation[conversationId] || EMPTY_MESSAGES) : EMPTY_MESSAGES
  );

  // The store-backed indicator is re-emitted as a DOM event and so only ever
  // fires on web.
  const typingUserIds = storedTypingUserIds;

  /**
   * Says the viewer is typing.
   *
   * The throttling around this — one notice per five seconds, a stop after three
   * idle — belongs to the composer.
   */
  const notifyTyping = sendTypingIndicator;

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
          participants={conversationMetadata.participants}
          groupName={conversationMetadata.groupInfo?.name}
          groupAvatar={conversationMetadata.groupInfo?.avatar}
          currentUserId={currentUserId}
          conversationTheme={conversation?.theme}
        />
      );
      bottomSheet.openBottomSheet(true);
    }
  }, [conversationId, conversation, isLargeScreen, isGroup, bottomSheet, conversationMetadata, currentUserId, router]);

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
  }, [conversationId, inputText, sendMessage, setInputText, messageTextSize, setMessageTextSize, conversation, isGroup, currentUserId, notifyTyping]);

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
   * Sends what was picked, and says so when it cannot.
   *
   * The legacy API has no upload endpoint, so today this says so instead of
   * opening a picker that leads nowhere. The pickers stay wired because the
   * platform client that replaces this path sends attachments through the same
   * call.
   */
  const sendAttachments = useCallback(async (attachments: PickedAttachments) => {
    if (attachments.length === 0) {
      return;
    }
    toast.error('Attachments are not available yet.');
  }, []);

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


  /**
   * Resolve a media download URL from a media ID.
   *
   * The id is an Oxy Cloud file id and the URL is built from it, with a
   * rendition variant that depends on the item's kind (`mediaVariantForKind`).
   *
   * Returns an empty string when there is nothing yet, so the image renderer
   * surfaces its own empty state instead of a masking placeholder.
   */
  const getMediaUrl = useCallback((mediaId: string, kind: MediaItem['type']): string => {
    try {
      return oxyServices.getFileDownloadUrl(mediaId, mediaVariantForKind(kind));
    } catch (error) {
      console.error('Error getting media URL:', error);
      return '';
    }
  }, [oxyServices]);

  /**
   * The same media, at full size, for the viewer.
   *
   * `getMediaUrl` asks Oxy Cloud for a rendition sized for a 250pt bubble —
   * `w1280` for a picture, `poster` (a still frame) for a video — and both are
   * the wrong answer full screen: one is soft on a modern display and the other
   * is a photograph of a video. Omitting the variant serves the bytes as
   * uploaded, which is what "full size" means.
   */
  const getFullMediaUrl = useCallback((mediaId: string, kind: MediaItem['type']): string => {
    try {
      return oxyServices.getFileDownloadUrl(mediaId, undefined);
    } catch (error) {
      logger.error('[Conversation] Error getting full-size media URL:', error);
      return '';
    }
  }, [oxyServices]);

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
    try {
      return oxyServices.getFileDownloadUrl(source, undefined);
    } catch (error) {
      logger.error('[Conversation] Error getting attachment URL:', error);
      return '';
    }
  }, [oxyServices]);

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
   * message's: five photographs sent one at a time are five messages, and a
   * viewer built from one of them could never be swiped.
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
      const currentReactions = selectedMessage.reactions || {};
      const hasReacted = currentReactions[emoji]?.includes(currentUserId || '') || false;

      if (hasReacted) {
        await removeReaction(conversationId, selectedMessage.id, emoji);
      } else {
        await addReaction(conversationId, selectedMessage.id, emoji);
      }
    } catch (error) {
      console.error('[Conversation] Error toggling reaction:', error);
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
   * The legacy API has no endpoint that removes a message, so there is nothing
   * to call and no reason to pretend otherwise by clearing it here: a message
   * gone from this device and present on every other one is worse than one that
   * is still there.
   */
  const handleDelete = useCallback((_message: Message) => {
    resetSelectionState({ preserveMessage: true });
    toast.error('Deleting messages is not available on this account.');
  }, [resetSelectionState]);

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
    if (message.isSent) {
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
