import React, { Suspense, useMemo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, usePathname } from 'expo-router';

// Components
import { ThemedView } from '@/components/ThemedView';
import { EmptyState } from '@/components/shared/EmptyState';
import { LoadingFallback } from '@/components/shared/LoadingFallback';
import { ContactDetails } from '@/components/ContactDetails';
import ConversationsList from '../(chat)/index';

// Hooks
import { useTheme } from '@/hooks/useTheme';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { useConversation } from '@/hooks/useConversation';
import { getContactInfo, getGroupInfo } from '@/utils/conversationUtils';

// Constants
import { BREAKPOINTS } from '@/constants/responsive';

// Utils
import {
  getConversationDisplayName,
  getConversationAvatar,
  getOtherParticipants,
  isGroupConversation,
} from '@/utils/conversationUtils';

// Dynamic imports for code splitting (Expo Router 54 best practice)
const ConversationView = React.lazy(() => import('./[id]'));

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
  const isLargeScreen = useOptimizedMediaQuery({ minWidth: BREAKPOINTS.TABLET });
  // Show contact details only on desktop screens (>= 1024px)
  const isExtraLargeScreen = useOptimizedMediaQuery({ minWidth: BREAKPOINTS.DESKTOP });

  // Extract conversation ID using route pattern
  const conversationIdMatch = pathname?.match(/\/c\/([^/]+)$/);
  const conversationId = conversationIdMatch?.[1] || null;

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

  /**
   * Renders the conversation view with error boundary
   * Uses React.lazy for code splitting
   */
  const renderConversationView = useCallback(() => {
    if (!conversationId) {
      return (
        <EmptyState
          title="Select a conversation"
          subtitle="Choose a conversation from the list to start messaging"
        />
      );
    }

    return (
      <Suspense fallback={<LoadingFallback />}>
        <ConversationView conversationId={conversationId} />
      </Suspense>
    );
  }, [conversationId]);

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
    const showContactDetails = isExtraLargeScreen && conversationId && conversation;

    return (
      <ThemedView style={styles.container}>
        {/* Left pane - conversations list */}
        <View style={styles.leftPane}>
          <ConversationsList />
        </View>

        {/* Middle pane - conversation detail */}
        <View style={[
          styles.middlePane,
          // Only show right border if third column is visible
          showContactDetails && styles.middlePaneWithBorder,
        ]}>
          {renderConversationView()}
        </View>

        {/* Right pane - contact details (only on extra large screens) */}
        {showContactDetails && (
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
              currentUserId="current-user" // TODO: Replace with actual current user ID
            />
          </View>
        )}
      </ThemedView>
    );
  }

  // On small screens, use Stack navigator with file-based routing
  // Expo Router automatically discovers [id].tsx route from the file system
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

