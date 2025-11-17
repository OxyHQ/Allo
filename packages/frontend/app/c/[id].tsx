import React, { useState, useMemo, useRef, useEffect, useContext } from 'react';
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
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { colors } from '@/styles/colors';
import { ContactDetails } from '@/components/ContactDetails';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import Avatar from '@/components/Avatar';
import { GroupAvatar } from '@/components/GroupAvatar';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useConversation, getContactInfo, getGroupInfo } from '@/hooks/useConversation';
import {
  getConversationDisplayName,
  getConversationAvatar,
  getOtherParticipants,
  isGroupConversation,
} from '@/utils/conversationUtils';

interface Message {
  id: string;
  text: string;
  senderId: string;
  timestamp: Date;
  isSent: boolean;
}

// Mock messages - replace with actual data from your store/API
const MOCK_MESSAGES: Message[] = [
  {
    id: '1',
    text: 'Hey! How are you doing?',
    senderId: 'other',
    timestamp: new Date(Date.now() - 3600000),
    isSent: false,
  },
  {
    id: '2',
    text: 'I\'m doing great, thanks for asking!',
    senderId: 'me',
    timestamp: new Date(Date.now() - 3300000),
    isSent: true,
  },
  {
    id: '3',
    text: 'That\'s awesome to hear!',
    senderId: 'other',
    timestamp: new Date(Date.now() - 3000000),
    isSent: false,
  },
];

interface ConversationViewProps {
  conversationId?: string;
}

export default function ConversationView({ conversationId: propConversationId }: ConversationViewProps = {}) {
  const theme = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const segments = useSegments();
  const bottomSheet = useContext(BottomSheetContext);
  
  // Extract ID from pathname to avoid query parameters
  // Pathname will be like '/c/1' - extract the ID from the path
  const pathnameId = pathname?.match(/\/c\/([^/?]+)/)?.[1];
  
  // Also try to get ID from segments (more reliable for dynamic routes)
  // Segments will be like ['c', '1'] for /c/1
  const segmentId = segments[segments.length - 1] === 'c' ? null : 
                    (segments.includes('c') ? segments[segments.indexOf('c') + 1] : null);
  
  // Use prop ID if provided (when rendered from chat layout), otherwise use pathname/segment ID
  // Avoid using useLocalSearchParams as it can pick up unwanted query parameters
  const conversationId = propConversationId || pathnameId || segmentId || undefined;
  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });
  const [messages, setMessages] = useState<Message[]>(MOCK_MESSAGES);
  const [inputText, setInputText] = useState('');
  const flatListRef = useRef<FlatList>(null);

  // Get conversation data from hook/store
  const conversation = useConversation(conversationId);
  const isGroup = conversation ? isGroupConversation(conversation) : false;
  
  // Get contact or group info
  const contactInfo = getContactInfo(conversation);
  const groupInfo = getGroupInfo(conversation);
  
  // Get display information
  const displayName = conversation
    ? getConversationDisplayName(conversation, 'current-user') // Replace with actual current user ID
    : 'Unknown';
  const avatar = conversation
    ? getConversationAvatar(conversation, 'current-user') // Replace with actual current user ID
    : undefined;
  const participants = isGroup && conversation ? (conversation.participants || []) : [];
  
  const contactName = contactInfo?.name || groupInfo?.name || displayName;
  const contactUsername = contactInfo?.username || undefined;
  const contactAvatar = contactInfo?.avatar || groupInfo?.avatar || avatar;
  const isOnline = contactInfo?.isOnline || false;

  const handleHeaderPress = () => {
    if (!conversationId || !conversation) return;
    
    // On mobile, open bottom sheet with contact details
    if (!isLargeScreen && bottomSheet) {
      bottomSheet.setBottomSheetContent(
        <ContactDetails
          conversationId={conversationId || ''}
          conversationType={isGroup ? 'group' : 'direct'}
          contactName={contactName}
          contactUsername={contactUsername}
          contactAvatar={contactAvatar}
          isOnline={isOnline}
          lastSeen={contactInfo?.lastSeen}
          participants={participants}
          groupName={groupInfo?.name}
          groupAvatar={groupInfo?.avatar}
          currentUserId="current-user" // Replace with actual current user ID
        />
      );
      bottomSheet.openBottomSheet(true);
    }
    // On large screens, we could scroll to contact details or do nothing
    // Contact details are already visible in the right pane
  };

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
      height: 48,
      zIndex: 101, // Higher than Header's zIndex (100)
      backgroundColor: 'transparent',
    },
    messagesList: {
      flex: 1,
      paddingHorizontal: 16,
    },
    messageContainer: {
      marginVertical: 4,
      maxWidth: '75%',
      alignSelf: 'flex-start',
    },
    messageContainerSent: {
      alignSelf: 'flex-end',
    },
    messageBubble: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 18,
      backgroundColor: colors.messageBubbleReceived,
    },
    messageBubbleSent: {
      backgroundColor: colors.messageBubbleSent,
    },
    messageText: {
      fontSize: 16,
      color: colors.messageTextReceived,
    },
    messageTextSent: {
      color: colors.messageTextSent,
    },
    messageTimestamp: {
      fontSize: 11,
      color: colors.messageTimestamp,
      marginTop: 4,
      textAlign: 'right',
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
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 20,
      backgroundColor: colors.chatInputBackground,
      borderWidth: 1,
      borderColor: colors.chatInputBorder,
      fontSize: 16,
      color: colors.chatInputText,
      marginRight: 8,
    },
    sendButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
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
  }), [theme, id]);

  useEffect(() => {
    // Scroll to bottom when messages change
    if (flatListRef.current && messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages]);

  const handleSend = () => {
    if (inputText.trim().length === 0) return;

    const newMessage: Message = {
      id: Date.now().toString(),
      text: inputText.trim(),
      senderId: 'me',
      timestamp: new Date(),
      isSent: true,
    };

    setMessages((prev) => [...prev, newMessage]);
    setInputText('');
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isSent = item.isSent;
    const timeString = item.timestamp.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    return (
      <View
        style={[
          styles.messageContainer,
          isSent && styles.messageContainerSent,
        ]}
      >
        <View
          style={[
            styles.messageBubble,
            isSent && styles.messageBubbleSent,
          ]}
        >
          <Text
            style={[
              styles.messageText,
              isSent && styles.messageTextSent,
            ]}
          >
            {item.text}
          </Text>
        </View>
        <Text style={styles.messageTimestamp}>{timeString}</Text>
      </View>
    );
  };

  const canSend = inputText.trim().length > 0;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ThemedView style={styles.container}>
        {/* Header */}
        <View style={styles.headerWrapper}>
          <Header
            options={{
              title: displayName,
              subtitle: contactUsername || (isGroup && groupInfo ? `${groupInfo.participantCount} participants` : undefined),
              leftComponents: !isLargeScreen ? [
                <HeaderIconButton
                  key="back"
                  onPress={() => router.back()}
                >
                  <BackArrowIcon size={20} color={theme.colors.text} />
                </HeaderIconButton>,
              ] : [],
              rightComponents: [
                isGroup && participants.length > 0 ? (
                  <TouchableOpacity
                    key="group-avatar"
                    onPress={handleHeaderPress}
                    activeOpacity={0.7}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <GroupAvatar
                      participants={getOtherParticipants(conversation!, 'current-user')}
                      size={36}
                      maxAvatars={2}
                    />
                  </TouchableOpacity>
                ) : (
                  contactAvatar && (
                    <TouchableOpacity
                      key="avatar"
                      onPress={handleHeaderPress}
                      activeOpacity={0.7}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Avatar
                        source={{ uri: contactAvatar }}
                        size={36}
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
                left: !isLargeScreen ? 56 : 0, // Offset for back button on mobile
                right: (contactAvatar || (isGroup && participants.length > 0)) ? 56 : 0, // Offset for avatar if present
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
          keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
        >
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.input}
              value={inputText}
              onChangeText={setInputText}
              placeholder="Type a message..."
              placeholderTextColor={colors.chatInputPlaceholder}
              multiline
              maxLength={1000}
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

