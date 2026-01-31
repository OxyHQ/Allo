import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, usePathname } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { ThemedView } from '@/components/ThemedView';
import { ContactDetails } from '@/components/ContactDetails';
import { EmptyState } from '@/components/shared/EmptyState';
import ConversationsList from './index';
import { useConversationsStore } from '@/stores';
import { useUserById } from '@/stores/usersStore';
import { useOxy } from '@oxyhq/services';
import { getContactInfo, getGroupInfo } from '@/utils/conversationUtils';
import { BREAKPOINTS } from '@/constants/responsive';
import { useRealtimeMessaging } from '@/hooks/useRealtimeMessaging';

const ConversationViewWrapper = ({ conversationId }: { conversationId: string }) => {
  try {
    const ConversationView = require('./c/[id]').default;
    return <ConversationView conversationId={conversationId} />;
  } catch (error) {
    console.error('Failed to load conversation view:', error);
    return null;
  }
};

export default function ChatLayout() {
  const theme = useTheme();
  const pathname = usePathname();

  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });
  const isExtraLargeScreen = useOptimizedMediaQuery({ minWidth: BREAKPOINTS.DESKTOP });

  const { user: currentUser } = useOxy();
  const conversations = useConversationsStore(state => state.conversations);

  useRealtimeMessaging(undefined);

  const isSettingsRoute = pathname?.includes('/settings');
  const isSettingsIndexRoute = pathname === '/(chat)/settings' || pathname?.endsWith('/settings');
  const isNestedSettingsRoute = isSettingsRoute && !isSettingsIndexRoute;
  const isNewChatRoute = pathname === '/(chat)/new' || pathname === '/new' || pathname?.endsWith('/new');

  const conversationIdMatch = pathname?.match(/\/c\/([^/]+)$/);
  const isConversationRoute = conversationIdMatch &&
    !pathname.includes('/settings') &&
    !isNewChatRoute;

  const userRouteMatch = pathname?.match(/\/u\/([^/]+)$/);
  const isUserRoute = userRouteMatch &&
    !pathname.includes('/settings') &&
    !isNewChatRoute;

  const targetUserId = isUserRoute && userRouteMatch ? userRouteMatch[1] : undefined;
  const targetUser = useUserById(targetUserId);

  const activeConversation = useMemo(() => {
    if (isConversationRoute && conversationIdMatch) {
      return conversations.find(c => c.id === conversationIdMatch[1]);
    }
    if (targetUserId) {
      return conversations.find(c =>
        c.type === 'direct' &&
        c.participants?.some(p => p.id === targetUserId)
      );
    }
    return null;
  }, [isConversationRoute, conversationIdMatch, targetUserId, conversations]);

  const showContactDetails = isExtraLargeScreen && (activeConversation || targetUser);

  const contactDetailsProps = useMemo(() => {
    if (activeConversation) {
      const contactInfo = getContactInfo(activeConversation);
      const groupInfo = getGroupInfo(activeConversation);

      return {
        conversationId: activeConversation.id,
        conversationType: activeConversation.type,
        contactName: contactInfo?.name || groupInfo?.name || activeConversation.name,
        contactUsername: contactInfo?.username,
        contactAvatar: contactInfo?.avatar || groupInfo?.avatar || activeConversation.avatar,
        isOnline: contactInfo?.isOnline,
        lastSeen: contactInfo?.lastSeen,
        participants: activeConversation.participants,
        groupName: groupInfo?.name,
        groupAvatar: groupInfo?.avatar,
        currentUserId: currentUser?.id,
      };
    }

    if (targetUser) {
      let contactName = targetUser.username || 'Unknown';
      if (targetUser.name) {
        if (typeof targetUser.name === 'string') {
          contactName = targetUser.name;
        } else if (targetUser.name.first) {
          contactName = `${targetUser.name.first} ${targetUser.name.last || ''}`.trim();
        }
      }

      return {
        conversationId: undefined,
        conversationType: 'direct' as const,
        contactName,
        contactUsername: targetUser.username,
        contactAvatar: targetUser.avatar,
        isOnline: targetUser.isOnline,
        lastSeen: targetUser.lastSeen,
        currentUserId: currentUser?.id,
      };
    }

    return null;
  }, [activeConversation, targetUser, currentUser?.id]);

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
    rightPane: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    middlePaneWithBorder: {
      borderRightWidth: 1,
      borderRightColor: theme.colors.border,
    },
    thirdPane: {
      width: 350,
      backgroundColor: theme.colors.background,
    },
    mobileContainer: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
  }), [theme.colors.background, theme.colors.border]);

  if (isLargeScreen) {
    const ChatSettings = isSettingsRoute ? require('./settings/index').default : null;

    return (
      <ThemedView style={styles.container}>
        <View style={styles.leftPane}>
          {isSettingsRoute && ChatSettings ? (
            <ChatSettings />
          ) : (
            <ConversationsList />
          )}
        </View>

        <View style={[
          styles.rightPane,
          showContactDetails && styles.middlePaneWithBorder
        ]}>
          {isNestedSettingsRoute ? (
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: theme.colors.background },
              }}
            >
              {/* First level nested routes */}
              <Stack.Screen name="settings/appearance" />
              <Stack.Screen name="settings/language" />
              <Stack.Screen name="settings/privacy" />
              <Stack.Screen name="settings/profile-customization" />
              {/* Second level nested routes under privacy */}
              <Stack.Screen name="settings/privacy/profile-visibility" />
              <Stack.Screen name="settings/privacy/tags-allos" />
              <Stack.Screen name="settings/privacy/online-status" />
              <Stack.Screen name="settings/privacy/restricted" />
              <Stack.Screen name="settings/privacy/blocked" />
              <Stack.Screen name="settings/privacy/hidden-words" />
              <Stack.Screen name="settings/privacy/hide-counts" />
            </Stack>
          ) : isNewChatRoute ? (
            // Show new chat screen
            (() => {
              try {
                const NewChatScreen = require('./new').default;
                return <NewChatScreen />;
              } catch (error) {
                console.error('Failed to load new chat screen:', error);
                return null;
              }
            })()
          ) : isConversationRoute && conversationIdMatch ? (
            // Show conversation detail from /c/:id route
            // Use the wrapper component that handles the require path correctly
            <ConversationViewWrapper conversationId={conversationIdMatch[1]} />
          ) : isUserRoute ? (
            // Show user conversation route
            (() => {
              try {
                const UserRoute = require('./u/[id]').default;
                return <UserRoute userId={userRouteMatch[1]} />;
              } catch (error) {
                console.error('Failed to load user route:', error);
                return null;
              }
            })()
          ) : (
            <EmptyState
              imageSource={require('@/assets/images/welcome.png')}
              title="Select a conversation"
              subtitle="Choose a conversation from the list to start messaging"
            />
          )}
        </View>

        {/* 3rd Pane - Contact Details */}
        {showContactDetails && contactDetailsProps && (
          <View style={styles.thirdPane}>
            <ContactDetails {...contactDetailsProps} />
          </View>
        )}
      </ThemedView>
    );
  }

  // On small screens, use standard stack navigation for all routes
  return (
    <ThemedView style={styles.mobileContainer}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="new" />
        <Stack.Screen name="c/[id]" />
        <Stack.Screen name="u/[id]" />
        <Stack.Screen name="settings/index" />
        <Stack.Screen name="settings/appearance" />
        <Stack.Screen name="settings/language" />
        <Stack.Screen name="settings/privacy" />
        <Stack.Screen name="settings/profile-customization" />
      </Stack>
    </ThemedView>
  );
}
