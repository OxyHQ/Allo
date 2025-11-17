import React, { useState, useMemo, useRef, useEffect, useContext, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
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
import { MessageBubble } from '@/components/messages/MessageBubble';

// Icons
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';

// Hooks
import { useTheme } from '@/hooks/useTheme';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { useConversation, getContactInfo, getGroupInfo } from '@/hooks/useConversation';

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
import { getMockMessages } from '@/utils/mockMessages';
import {
  getConversationId,
  getSenderNameFromParticipants,
} from '@/utils/conversationHelpers';

// Constants
import { MESSAGING_CONSTANTS } from '@/constants/messaging';

/**
 * Message interface
 * Represents a single message in a conversation
 */
export interface Message {
  id: string;
  text: string;
  senderId: string;
  senderName?: string;
  timestamp: Date;
  isSent: boolean;
}

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
  
  // Load mock messages for this conversation
  const initialMessages = useMemo(() => getMockMessages(conversationId), [conversationId]);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [inputText, setInputText] = useState('');
  const flatListRef = useRef<FlatList>(null);
  
  // Track which message has timestamp visible (only one at a time)
  const [visibleTimestampId, setVisibleTimestampId] = useState<string | null>(null);

  // Update messages when conversation changes
  useEffect(() => {
    const newMessages = getMockMessages(conversationId);
    setMessages(newMessages);
    // Reset visible timestamp when conversation changes
    setVisibleTimestampId(null);
  }, [conversationId]);

  // Get conversation data
  const conversation = useConversation(conversationId);
  const isGroup = useMemo(
    () => conversation ? isGroupConversation(conversation) : false,
    [conversation]
  );
  
  // Extract conversation metadata
  const conversationMetadata = useMemo(() => {
    const contactInfo = getContactInfo(conversation);
    const groupInfo = getGroupInfo(conversation);
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
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
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
      paddingHorizontal: 16,
    },
    inputContainer: {
      flexDirection: 'row',
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      backgroundColor: theme.colors.background,
    },
    input: {
      flex: 1,
      paddingHorizontal: MESSAGING_CONSTANTS.INPUT_PADDING_HORIZONTAL,
      paddingVertical: MESSAGING_CONSTANTS.INPUT_PADDING_VERTICAL,
      borderRadius: MESSAGING_CONSTANTS.INPUT_BORDER_RADIUS,
      backgroundColor: colors.chatInputBackground,
      borderWidth: 1,
      borderColor: colors.chatInputBorder,
      fontSize: MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE,
      color: colors.chatInputText,
      marginRight: 8,
    },
    sendButton: {
      width: MESSAGING_CONSTANTS.SEND_BUTTON_SIZE,
      height: MESSAGING_CONSTANTS.SEND_BUTTON_SIZE,
      borderRadius: MESSAGING_CONSTANTS.SEND_BUTTON_SIZE / 2,
      backgroundColor: colors.buttonPrimary,
      justifyContent: 'center',
      alignItems: 'center',
    },
    sendButtonDisabled: {
      backgroundColor: colors.buttonDisabled,
    },
    sendButtonText: {
      color: '#FFFFFF',
      fontSize: 18,
      fontWeight: '600',
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
    if (flatListRef.current && messages.length > 0) {
      const timeoutId = setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, MESSAGING_CONSTANTS.SCROLL_TO_BOTTOM_DELAY);
      
      return () => clearTimeout(timeoutId);
    }
  }, [messages.length]);

  const handleSend = useCallback(() => {
    if (inputText.trim().length === 0) return;

    const newMessage: Message = {
      id: `msg-${Date.now()}`,
      text: inputText.trim(),
      senderId: 'current-user',
      timestamp: new Date(),
      isSent: true,
    };

    setMessages((prev) => [...prev, newMessage]);
    setInputText('');
  }, [inputText]);

  /**
   * Get sender name for group conversations
   */
  const getSenderName = useCallback((senderId: string): string | undefined => {
    return getSenderNameFromParticipants(senderId, conversation, CURRENT_USER_ID);
  }, [conversation]);

  /**
   * Toggle timestamp visibility for a message
   * Only one message's timestamp can be visible at a time
   */
  const toggleTimestamp = useCallback((messageId: string) => {
    setVisibleTimestampId((prev) => {
      // If clicking the same message, hide it. Otherwise, show the new one.
      return prev === messageId ? null : messageId;
    });
  }, []);

  /**
   * Render a single message item
   * Memoized for performance
   */
  const renderMessage = useCallback(({ item, index }: { item: Message; index: number }) => {
    const showSenderName = isGroup && !item.isSent;
    const senderName = showSenderName
      ? (item.senderName || getSenderName(item.senderId))
      : undefined;
    
    // Check if this is the first message from this sender (for spacing)
    const prevMessage = index > 0 ? messages[index - 1] : null;
    const isFirstFromSender = !prevMessage || prevMessage.senderId !== item.senderId;
    const showSenderNameLabel = showSenderName && senderName && isFirstFromSender;
    
    const showTimestamp = visibleTimestampId === item.id;

    return (
      <MessageBubble
        id={item.id}
        text={item.text}
        timestamp={item.timestamp}
        isSent={item.isSent}
        senderName={senderName}
        showSenderName={showSenderNameLabel}
        showTimestamp={showTimestamp}
        onPress={() => toggleTimestamp(item.id)}
      />
    );
  }, [isGroup, messages, visibleTimestampId, getSenderName, toggleTimestamp]);

  const canSend = inputText.trim().length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
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
        {messages.length > 0 ? (
          <FlatList
            ref={flatListRef}
            style={styles.messagesList}
            data={messages}
            renderItem={renderMessage}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingVertical: 16 }}
            inverted={false}
          />
        ) : (
          <View style={styles.emptyState}>
            <ThemedText style={styles.emptyStateText}>
              No messages yet.{'\n'}Start the conversation!
            </ThemedText>
          </View>
        )}

        {/* Input */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? MESSAGING_CONSTANTS.KEYBOARD_OFFSET_IOS : 0}
        >
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.input}
              value={inputText}
              onChangeText={setInputText}
              placeholder="Type a message..."
              placeholderTextColor={colors.chatInputPlaceholder}
              multiline
              maxLength={MESSAGING_CONSTANTS.INPUT_MAX_LENGTH}
            />
            <TouchableOpacity
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              onPress={handleSend}
              disabled={!canSend}
              activeOpacity={0.7}
            >
              <Text style={styles.sendButtonText}>→</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </ThemedView>
    </SafeAreaView>
  );
}

