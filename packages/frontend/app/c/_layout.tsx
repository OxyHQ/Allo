import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { ContactDetails } from '@/components/ContactDetails';
import ConversationsList from '../(chat)/index';
import { useConversation, getContactInfo, getGroupInfo } from '@/hooks/useConversation';
import {
  getConversationDisplayName,
  getConversationAvatar,
  getOtherParticipants,
  isGroupConversation,
} from '@/utils/conversationUtils';

/**
 * Layout for /c/:id routes
 * Responsive layout:
 * - Small screens (< 768px): Single-pane stack navigation
 * - Medium screens (768px - 1023px): Two-pane layout (conversations list + conversation)
 * - Large screens (>= 1024px): Three-pane layout (conversations list + conversation + contact details)
 */
export default function CConversationLayout() {
  const theme = useTheme();
  const pathname = usePathname();
  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });
  // Show contact details only on very large screens (>= 1024px)
  const isExtraLargeScreen = useOptimizedMediaQuery({ minWidth: 1024 });
  
  const conversationIdMatch = pathname?.match(/\/c\/([^/]+)$/);
  const conversationId = conversationIdMatch?.[1];
  
  // Get conversation data
  const conversation = useConversation(conversationId);
  const isGroup = conversation ? isGroupConversation(conversation) : false;
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

  // Wrapper component to render conversation view with ID from pathname
  const ConversationViewWrapper = ({ conversationId }: { conversationId: string }) => {
    try {
      const ConversationView = require('./[id]').default;
      return <ConversationView conversationId={conversationId} />;
    } catch (error) {
      console.error('Failed to load conversation view:', error);
      return null;
    }
  };

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      flexDirection: 'row',
      backgroundColor: theme.colors.background,
    },
    leftPane: {
      width: 350,
      borderRightWidth: 1,
      borderRightColor: theme.colors.border,
      backgroundColor: theme.colors.background,
    },
    middlePane: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    middlePaneWithBorder: {
      borderRightWidth: 1,
      borderRightColor: theme.colors.border,
    },
    rightPane: {
      width: 350,
      backgroundColor: theme.colors.background,
    },
    mobileContainer: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
  }), [theme.colors.background, theme.colors.border]);

  // On large screens (>= 768px), show two-pane layout
  // On extra large screens (>= 1024px), show three-pane layout with contact details
  if (isLargeScreen) {
    return (
      <ThemedView style={styles.container}>
        {/* Left pane - show conversations list */}
        <View style={styles.leftPane}>
          <ConversationsList />
        </View>
        
        {/* Middle pane - show conversation detail */}
        <View style={[
          styles.middlePane,
          // Only show right border if third column is visible
          (isExtraLargeScreen && conversationId) && styles.middlePaneWithBorder,
        ]}>
          {conversationId ? (
            <ConversationViewWrapper conversationId={conversationId} />
          ) : (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
              <ThemedText style={{ fontSize: 24, fontWeight: 'bold', color: theme.colors.text, marginBottom: 12 }}>
                Select a conversation
              </ThemedText>
              <ThemedText style={{ fontSize: 16, color: theme.colors.textSecondary, textAlign: 'center' }}>
                Choose a conversation from the list to start messaging
              </ThemedText>
            </View>
          )}
        </View>

        {/* Right pane - show contact details only on extra large screens when conversation is selected */}
        {conversationId && isExtraLargeScreen && conversation && (
          <View style={styles.rightPane}>
            <ContactDetails
              conversationId={conversationId}
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
          </View>
        )}
      </ThemedView>
    );
  }

  // On small screens, use standard stack navigation
  return (
    <ThemedView style={styles.mobileContainer}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen 
          name="[id]" 
          options={{ title: 'Conversation' }}
        />
      </Stack>
    </ThemedView>
  );
}

