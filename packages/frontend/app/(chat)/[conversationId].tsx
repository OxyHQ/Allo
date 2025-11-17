import React, { useState, useMemo, useRef, useEffect } from 'react';
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { colors } from '@/styles/colors';

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

export default function ConversationView() {
  const theme = useTheme();
  const router = useRouter();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });
  const [messages, setMessages] = useState<Message[]>(MOCK_MESSAGES);
  const [inputText, setInputText] = useState('');
  const flatListRef = useRef<FlatList>(null);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.background,
    },
    backButton: {
      marginRight: 12,
      padding: 4,
    },
    backButtonText: {
      fontSize: 16,
      color: theme.colors.text,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
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
  }), [theme, conversationId]);

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
        {!isLargeScreen && (
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => router.back()}
            >
              <ThemedText style={styles.backButtonText}>← Back</ThemedText>
            </TouchableOpacity>
            <ThemedText style={styles.headerTitle}>
              Conversation {conversationId}
            </ThemedText>
          </View>
        )}

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

