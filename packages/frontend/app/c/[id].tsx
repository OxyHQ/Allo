import React, { useMemo, useRef, useEffect, useContext, useCallback, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  ImageBackground,
  useWindowDimensions,
} from 'react-native';
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
import { MessageReactionBar } from '@/components/messages/MessageReactionBar';
import { SwipeableMessage } from '@/components/messages/SwipeableMessage';
import { MediaCarousel } from '@/components/messages/MediaCarousel';
import { ReplyIcon } from '@/assets/icons/reply-icon';
import { ForwardIcon } from '@/assets/icons/forward-icon';
import { CopyIcon } from '@/assets/icons/copy-icon';
import { TrashIcon } from '@/assets/icons/trash-icon';

// Icons
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Plus } from '@/assets/icons/plus-icon';
import { EmojiIcon } from '@/assets/icons/emoji-icon';
import { SendIcon } from '@/assets/icons/send-icon';
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
import { useMessagesStore, useChatUIStore } from '@/stores';
import { oxyServices } from '@/lib/oxyServices';

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

/**
 * Current user ID constant
 * TODO: Replace with actual authentication system
 */
const CURRENT_USER_ID = 'current-user';

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

  // Get conversation ID from multiple sources (prop > pathname > segments)
  const conversationId = useMemo(
    () => getConversationId(propConversationId, pathname, segments),
    [propConversationId, pathname, segments]
  );

  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

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

  // Get UI state from store
  const inputText = useChatUIStore(state =>
    conversationId ? state.getInputText(conversationId) : ''
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
  const [selectedMediaIndex, setSelectedMediaIndex] = useState<number | null>(null);
  const [reactionBarVisible, setReactionBarVisible] = useState(false);
  const [reactionBarPosition, setReactionBarPosition] = useState<{ x: number; y: number; width?: number; height?: number } | undefined>();
  const [actionsMenuVisible, setActionsMenuVisible] = useState(false);
  const [actionsMenuPosition, setActionsMenuPosition] = useState<{ x: number; y: number; width?: number; height?: number } | undefined>();
  const [infoScreenVisible, setInfoScreenVisible] = useState(false);

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
    fetchMessages(conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]); // Only depend on conversationId - store functions are stable

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
      ? getConversationDisplayName(conversation, CURRENT_USER_ID)
      : 'Unknown';
    const avatar = conversation
      ? getConversationAvatar(conversation, CURRENT_USER_ID)
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
      paddingHorizontal: 12,
      paddingVertical: 8,
      paddingBottom: Platform.OS === 'ios' ? 8 : 12,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.background,
      gap: 8,
    },
    inputWrapper: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'flex-end',
      minHeight: 44,
      maxHeight: 120,
      borderRadius: 22,
      backgroundColor: colors.chatInputBackground,
      borderWidth: 1,
      borderColor: colors.chatInputBorder,
      paddingHorizontal: 4,
      paddingVertical: 4,
    },
    input: {
      flex: 1,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE,
      color: colors.chatInputText,
      textAlignVertical: 'center',
      minHeight: 36,
      maxHeight: 112,
    },
    attachButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: 'transparent',
    },
    emojiButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: 'transparent',
    },
    sendButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.buttonPrimary,
      justifyContent: 'center',
      alignItems: 'center',
      opacity: 1,
    },
    sendButtonDisabled: {
      backgroundColor: 'transparent',
      opacity: 0.4,
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
  }), [theme]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (flatListRef.current && messageGroups.length > 0) {
      const timeoutId = setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, MESSAGING_CONSTANTS.SCROLL_TO_BOTTOM_DELAY);

      return () => clearTimeout(timeoutId);
    }
  }, [messageGroups.length]);

  const handleSend = useCallback(async () => {
    if (!conversationId || inputText.trim().length === 0) return;

    const text = inputText.trim();

    // Clear input immediately for better UX
    setInputText(conversationId, '');

    // Send message via store
    await sendMessage(conversationId, text, CURRENT_USER_ID);

    // Refocus input after sending
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  }, [conversationId, inputText, sendMessage, setInputText]);

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
    setSelectedMediaIndex(null);
    setReactionBarPosition(position);
    setActionsMenuPosition(position); // Same position for actions menu
    setReactionBarVisible(true);
    setActionsMenuVisible(true); // Show both simultaneously
  }, []);

  /**
   * Handle reaction selection
   */
  const handleReactionSelect = useCallback((emoji: string) => {
    if (selectedMessage) {
      // TODO: Implement reaction functionality
      console.log('Add reaction:', emoji, 'to message:', selectedMessage.id);
      // Could add reaction to message via store
    }
    setReactionBarVisible(false);
    setActionsMenuVisible(false);
    setSelectedMessage(null);
    setSelectedMediaId(null);
    setSelectedMediaIndex(null);
  }, [selectedMessage]);

  /**
   * Handle reply action
   */
  const handleReply = useCallback((message: Message) => {
    setActionsMenuVisible(false);
    // TODO: Implement reply functionality
    console.log('Reply to message:', message.id);
    // Could scroll to input and add quote or mention
    inputRef.current?.focus();
  }, []);

  /**
   * Handle forward action
   */
  const handleForward = useCallback((message: Message) => {
    setActionsMenuVisible(false);
    // TODO: Implement forward functionality
    console.log('Forward message:', message.id);
  }, []);

  /**
   * Handle copy action
   */
  const handleCopy = useCallback((message: Message) => {
    setActionsMenuVisible(false);
    // TODO: Implement copy to clipboard
    console.log('Copy message:', message.text);
  }, []);

  /**
   * Handle delete action
   */
  const handleDelete = useCallback((message: Message) => {
    setActionsMenuVisible(false);
    // TODO: Implement delete functionality
    console.log('Delete message:', message.id);
  }, []);

  /**
   * Handle info action
   */
  const handleInfo = useCallback((message: Message) => {
    setActionsMenuVisible(false);
    setSelectedMessage(message);
    setInfoScreenVisible(true);
  }, []);

  /**
   * Get message actions for actions menu
   */
  const getMessageActions = useCallback((message: Message | null): MessageAction[] => {
    if (!message) return [];

    return [
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
              setSelectedMediaIndex(index);
              setReactionBarPosition(position);
              setActionsMenuPosition(position); // Same position for actions menu
              setReactionBarVisible(true);
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
            actions={getMessageActions(selectedMessage)}
            onClose={() => {
              setReactionBarVisible(false);
              setActionsMenuVisible(false);
              setSelectedMessage(null);
              setSelectedMediaId(null);
              setSelectedMediaIndex(null);
            }}
            messagePosition={actionsMenuPosition}
            messageElement={selectedMessage ? (
              <View>
                {/* Show media if selected */}
                {selectedMediaId && selectedMessage.media && (
                  <MediaCarousel
                    media={selectedMessage.media}
                    isAiMessage={selectedMessage.messageType === 'ai'}
                    getMediaUrl={getMediaUrl}
                    onMediaPress={() => { }}
                  />
                )}
                {/* Show message bubble */}
                {selectedMessage.text && (
                  <MessageBubble
                    id={selectedMessage.id}
                    text={selectedMessage.text}
                    timestamp={selectedMessage.timestamp}
                    isSent={selectedMessage.isSent}
                    senderName={isGroup && !selectedMessage.isSent ? getSenderName(selectedMessage.senderId) : undefined}
                    showSenderName={isGroup && !selectedMessage.isSent}
                    showTimestamp={false}
                    isCloseToPrevious={false}
                    messageType={selectedMessage.messageType || 'user'}
                    onPress={() => { }}
                  />
                )}
              </View>
            ) : undefined}
          />

          {/* Message Reaction Bar - rendered last (will be on top) */}
          <MessageReactionBar
            visible={reactionBarVisible}
            position={reactionBarPosition}
            messageElement={selectedMessage ? (
              <View>
                {/* Show media if selected */}
                {selectedMediaId && selectedMessage.media && (
                  <MediaCarousel
                    media={selectedMessage.media}
                    isAiMessage={selectedMessage.messageType === 'ai'}
                    getMediaUrl={getMediaUrl}
                    onMediaPress={() => { }}
                  />
                )}
                {/* Show message bubble */}
                {selectedMessage.text && (
                  <MessageBubble
                    id={selectedMessage.id}
                    text={selectedMessage.text}
                    timestamp={selectedMessage.timestamp}
                    isSent={selectedMessage.isSent}
                    senderName={isGroup && !selectedMessage.isSent ? getSenderName(selectedMessage.senderId) : undefined}
                    showSenderName={isGroup && !selectedMessage.isSent}
                    showTimestamp={false}
                    isCloseToPrevious={false}
                    messageType={selectedMessage.messageType || 'user'}
                    onPress={() => { }}
                  />
                )}
              </View>
            ) : undefined}
            onReactionSelect={handleReactionSelect}
            onClose={() => {
              setReactionBarVisible(false);
              setActionsMenuVisible(false);
              setSelectedMessage(null);
              setSelectedMediaId(null);
              setSelectedMediaIndex(null);
            }}
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
                  placeholderTextColor={colors.chatInputPlaceholder}
                  multiline
                  maxLength={MESSAGING_CONSTANTS.INPUT_MAX_LENGTH}
                  textAlignVertical="center"
                  returnKeyType="send"
                  blurOnSubmit={false}
                  onSubmitEditing={handleSubmitEditing}
                  onKeyPress={handleKeyPress}
                />

                {/* Emoji Button - Only show when input is empty or at end */}
                {inputText.length === 0 && (
                  <TouchableOpacity
                    style={styles.emojiButton}
                    onPress={handleEmoji}
                    activeOpacity={0.7}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <EmojiIcon
                      color={theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5}
                      size={24}
                    />
                  </TouchableOpacity>
                )}
              </View>

              {/* Send Button */}
              <TouchableOpacity
                style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
                onPress={handleSend}
                disabled={!canSend}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                {canSend ? (
                  <SendIcon
                    color="#FFFFFF"
                    size={20}
                  />
                ) : (
                  <EmojiIcon
                    color={theme.colors.textSecondary || colors.COLOR_BLACK_LIGHT_5}
                    size={24}
                  />
                )}
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        </ThemedView>
      </ImageBackground>
    </SafeAreaView>
  );
}

