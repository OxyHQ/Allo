import React, { useMemo, useRef, useEffect, useContext, useCallback, useState } from 'react';
import {
  StyleSheet,
  View,
  TextInput,
  FlatList,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  ImageBackground,
} from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useRouter, usePathname, useSegments } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { ContactDetails } from '@/components/ContactDetails';
import Avatar from '@/components/Avatar';
import { GroupAvatar } from '@/components/GroupAvatar';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { MessageBlock } from '@/components/messages/MessageBlock';
import { MessageBubble } from '@/components/messages/MessageBubble';
import { DaySeparator } from '@/components/messages/DaySeparator';
import { AttachmentMenu } from '@/components/messages/AttachmentMenu';
import { MessageActionsMenu, MessageAction } from '@/components/messages/MessageActionsMenu';
import { MessageInfoScreen } from '@/components/messages/MessageInfoScreen';
import { SwipeableMessage } from '@/components/messages/SwipeableMessage';
import { MediaCarousel } from '@/components/messages/MediaCarousel';
import { MicSendButton } from '@/components/messages/MicSendButton';
import { ReplyIcon } from '@/assets/icons/reply-icon';
import { ForwardIcon } from '@/assets/icons/forward-icon';
import { CopyIcon } from '@/assets/icons/copy-icon';
import { TrashIcon } from '@/assets/icons/trash-icon';

// Icons
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Plus } from '@/assets/icons/plus-icon';
import { EmojiIcon } from '@/assets/icons/emoji-icon';
import ChatBackgroundImage from '@/assets/images/background.png';

// Hooks
import { useTheme } from '@/hooks/useTheme';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { useConversation } from '@/hooks/useConversation';
import { getContactInfo, getGroupInfo } from '@/utils/conversationUtils';

// Context
import { BottomSheetContext } from '@/context/BottomSheetContext';

// Utils
import { colors } from '@/styles/colors';
import {
  getConversationDisplayName,
  getConversationAvatar,
  getOtherParticipants,
  isGroupConversation,
} from '@/utils/conversationUtils';
import { getConversationId, getSenderNameFromParticipants } from '@/utils/conversationHelpers';
import { useMessagesStore, useChatUIStore, useMessagePreferencesStore } from '@/stores';
import { oxyServices } from '@/lib/oxyServices';
import { useOxy } from '@oxyhq/services';

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
}

type SelectionContext = 'text' | 'media';

// Get current user ID from Oxy hook (will be used in component)

// Stable empty array to prevent Zustand selector from creating new references
const EMPTY_MESSAGES: Message[] = [];


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
  const theme = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const segments = useSegments();
  const bottomSheet = useContext(BottomSheetContext);
  const messageTextSize = useMessagePreferencesStore((state) => state.messageTextSize);
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
  const conversationId = useMemo(
    () => getConversationId(propConversationId, pathname, segments),
    [propConversationId, pathname, segments]
  );

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


  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);
  const lastFetchedConversationId = useRef<string | null>(null);

  // Message actions state
  const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [selectionContext, setSelectionContext] = useState<SelectionContext | null>(null);
  const [actionsMenuVisible, setActionsMenuVisible] = useState(false);
  const [actionsMenuPosition, setActionsMenuPosition] = useState<{ x: number; y: number; width?: number; height?: number } | undefined>();
  const [infoScreenVisible, setInfoScreenVisible] = useState(false);
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

  // Get conversation data
  const conversation = useConversation(conversationId);
  const isGroup = useMemo(
    () => conversation ? isGroupConversation(conversation) : false,
    [conversation]
  );

  // Extract conversation metadata
  const conversationMetadata = useMemo(() => {
    const contactInfo = getContactInfo(conversation ?? null);
    const groupInfo = getGroupInfo(conversation ?? null);
    const displayName = conversation
      ? getConversationDisplayName(conversation, currentUserId)
      : 'Unknown';
    const avatar = conversation
      ? getConversationAvatar(conversation, currentUserId)
      : undefined;
    const participants = isGroup && conversation ? (conversation.participants || []) : [];

    return {
      contactInfo,
      groupInfo,
      displayName,
      avatar,
      participants,
      contactName: contactInfo?.name || groupInfo?.name || displayName,
      contactUsername: contactInfo?.username || undefined,
      contactAvatar: contactInfo?.avatar || groupInfo?.avatar || avatar,
      isOnline: contactInfo?.isOnline || false,
    };
  }, [conversation, isGroup]);

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
          currentUserId={CURRENT_USER_ID}
        />
      );
      bottomSheet.openBottomSheet(true);
    }
  }, [conversationId, conversation, isLargeScreen, isGroup, bottomSheet, conversationMetadata]);

  // Styles memoized for performance
  const styles = useMemo(() => StyleSheet.create({
    safeArea: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    background: {
      flex: 1,
      width: '100%',
    },
    backgroundImage: {
      opacity: 0.18,
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
    emptyStateText: {
      fontSize: 16,
      color: theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5,
      textAlign: 'center',
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

  const handleSend = useCallback(async (sizeToUse?: number) => {
    if (!conversationId || inputText.trim().length === 0) return;

    const text = inputText.trim();
    const originalSize = messageTextSize;
    const finalSize = sizeToUse ?? messageTextSize;

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
      await sendMessage(conversationId, text, currentUserId, recipientUserId, sizeToUse && sizeToUse !== originalSize ? sizeToUse : undefined);
      
      // Scroll to bottom after sending
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    } catch (error) {
      console.error('Error sending message:', error);
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
  }, [conversationId, inputText, sendMessage, setInputText, messageTextSize, setMessageTextSize, conversation, isGroup, currentUserId]);

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
   * Handle attach button press
   * Opens WhatsApp-style attachment menu in bottom sheet
   */
  const handleAttach = useCallback(() => {
    if (!bottomSheet) return;

    bottomSheet.setBottomSheetContent(
      <AttachmentMenu
        onClose={() => bottomSheet.openBottomSheet(false)}
        onSelectPhoto={() => {
          // TODO: Implement photo picker
          console.log('Photo selected');
        }}
        onSelectDocument={() => {
          // TODO: Implement document picker
          console.log('Document selected');
        }}
        onSelectLocation={() => {
          // TODO: Implement location picker
          console.log('Location selected');
        }}
        onSelectCamera={() => {
          // TODO: Implement camera
          console.log('Camera selected');
        }}
        onSelectContact={() => {
          // TODO: Implement contact picker
          console.log('Contact selected');
        }}
        onSelectPoll={() => {
          // TODO: Implement poll creator
          console.log('Poll selected');
        }}
      />
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet]);

  /**
   * Handle emoji button press
   * TODO: Implement emoji picker
   */
  const handleEmoji = useCallback(() => {
    // Placeholder for emoji picker functionality
    console.log('Emoji pressed');
  }, []);

  /**
   * Get sender name for group conversations
   */
  const getSenderName = useCallback((senderId: string): string | undefined => {
    return getSenderNameFromParticipants(senderId, conversation ?? null);
  }, [conversation]);

  /**
   * Get sender avatar for incoming messages
   */
  const getSenderAvatar = useCallback((senderId: string): string | undefined => {
    if (!conversation) {
      return undefined;
    }

    // Direct conversation: use contact avatar
    if (!isGroup) {
      return conversationMetadata.contactAvatar;
    }

    const participants = conversation.participants || [];
    const participant = participants.find(
      (p) => p.id === senderId || ('userId' in p && p.userId === senderId)
    );
    return participant?.avatar;
  }, [conversation, conversationMetadata.contactAvatar, isGroup]);

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
   * Get media URL from media ID
   * Uses oxyServices to get the file download URL
   * For mock data, uses placeholder images
   */
  const getMediaUrl = useCallback((mediaId: string): string => {
    try {
      // Check if this is a mock media ID (starts with 'img-')
      // For mock data, use placeholder images that actually work
      if (mediaId.startsWith('img-')) {
        // Use picsum.photos for reliable placeholder images
        const seed = mediaId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
        const hash = seed.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
        return `https://picsum.photos/seed/${hash}/400/300`;
      }

      // For real media IDs, use oxyServices to get the file download URL
      // Use 'full' for full resolution images in messages
      return oxyServices.getFileDownloadUrl(mediaId, 'full');
    } catch (error) {
      console.error('Error getting media URL:', error);
      // Fallback to placeholder if service fails
      const seed = mediaId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
      const hash = seed.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      return `https://picsum.photos/seed/${hash}/400/300`;
    }
  }, []);
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
          onMediaPress={() => {}}
          onMediaLongPress={() => {}}
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
          onPress={() => {}}
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
   * Handle media press (open in fullscreen, etc.)
   */
  const handleMediaPress = useCallback((mediaId: string, index: number) => {
    // TODO: Implement media viewer
    console.log('Media pressed:', mediaId, index);
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

  const handleReactionSelect = useCallback((emoji: string) => {
    if (selectedMessage) {
      // TODO: Implement reaction functionality
      console.log('Add reaction:', emoji, 'to message:', selectedMessage.id);
      // Could add reaction to message via store
    }
    resetSelectionState();
  }, [selectedMessage, resetSelectionState]);

  /**
   * Handle reply action
   */
  const handleReply = useCallback((message: Message) => {
    resetSelectionState({ preserveMessage: true });
    // TODO: Implement reply functionality
    console.log('Reply to message:', message.id);
    // Could scroll to input and add quote or allo
    inputRef.current?.focus();
  }, [resetSelectionState]);

  /**
   * Handle forward action
   */
  const handleForward = useCallback((message: Message) => {
    resetSelectionState({ preserveMessage: true });
    // TODO: Implement forward functionality
    console.log('Forward message:', message.id);
  }, [resetSelectionState]);

  /**
   * Handle copy action
   */
  const handleCopy = useCallback((message: Message) => {
    resetSelectionState({ preserveMessage: true });
    // TODO: Implement copy to clipboard
    console.log('Copy message:', message.text);
  }, [resetSelectionState]);

  /**
   * Handle delete action
   */
  const handleDelete = useCallback((message: Message) => {
    resetSelectionState({ preserveMessage: true });
    // TODO: Implement delete functionality
    console.log('Delete message:', message.id);
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
                  isGroup && conversationMetadata.participants.length > 0 ? (
                    <TouchableOpacity
                      key="group-avatar"
                      onPress={handleHeaderPress}
                      activeOpacity={0.7}
                      hitSlop={MESSAGING_CONSTANTS.AVATAR_HIT_SLOP}
                    >
                      <GroupAvatar
                        participants={getOtherParticipants(conversation!, CURRENT_USER_ID)}
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
            <FlatList
              ref={flatListRef}
              style={styles.messagesList}
              data={messageGroups}
              renderItem={renderMessageGroup}
              keyExtractor={getGroupKey}
              contentContainerStyle={{ paddingVertical: 12 }}
              inverted={false}
            />
          ) : (
            <View style={styles.emptyState}>
              <ThemedText style={styles.emptyStateText}>
                No messages yet.{'\n'}Start the conversation!
              </ThemedText>
            </View>
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
                  onChangeText={(text) => {
                    if (conversationId) {
                      setInputText(conversationId, text);
                    }
                  }}
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
                  console.log('Recording started');
                }}
                onRecordEnd={(uri, duration) => {
                  console.log('Recording ended:', uri, duration);
                  // TODO: Send audio message
                }}
                onRecordCancel={() => {
                  console.log('Recording cancelled');
                }}
              />
            </View>
          </KeyboardAvoidingView>
        </ThemedView>
      </ImageBackground>
    </SafeAreaView>
  );
}
