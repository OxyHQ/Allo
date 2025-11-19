import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, usePathname, Slot, useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { ContactDetails } from '@/components/ContactDetails';
import ConversationsList from './index';
import StatusScreen from './status';
import { useConversationsStore } from '@/stores';
import { useUserById } from '@/stores/usersStore';
import { useOxy } from '@oxyhq/services';
import { getContactInfo, getGroupInfo } from '@/utils/conversationUtils';
import { BREAKPOINTS } from '@/constants/responsive';

// Wrapper component to render conversation view with ID from pathname
const ConversationViewWrapper = ({ conversationId }: { conversationId: string }) => {
  try {
    const ConversationView = require('./c/[id]').default;
    // Pass the conversation ID as a prop so it works when rendered outside the route context
    return <ConversationView conversationId={conversationId} />;
  } catch (error) {
    console.error('Failed to load conversation view:', error);
    return null;
  }
};

/**
 * Chat Layout with responsive two-pane support
 * - Large screens (>= 768px): Two-pane layout (conversations list + current conversation)
 * - Small screens (< 768px): Single-pane layout (stack navigation)
 * 
 * Routes:
 * - / (index.tsx) - Conversations list
 * - /c/:id - Individual conversation (handled by app/c/_layout.tsx)
 * - /settings (settings/index.tsx) - Chat settings (shown in left pane on large screens)
 * - /settings/:subroute (settings/*.tsx) - Nested settings (shown in right pane on large screens)
 */
export default function ChatLayout() {
  const theme = useTheme();
  const pathname = usePathname();

  // Check if we're on a large screen (tablet/desktop)
  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });
  // Show contact details only on desktop screens (>= 1024px)
  const isExtraLargeScreen = useOptimizedMediaQuery({ minWidth: BREAKPOINTS.DESKTOP });

  const { user: currentUser } = useOxy();
  const conversations = useConversationsStore(state => state.conversations);

  // Determine current route types
  const isSettingsRoute = pathname?.includes('/settings');
  const isSettingsIndexRoute = pathname === '/(chat)/settings' || pathname?.endsWith('/settings');
  const isNestedSettingsRoute = isSettingsRoute && !isSettingsIndexRoute;
  const isNewChatRoute = pathname === '/(chat)/new' || pathname === '/new' || pathname?.endsWith('/new');

  // Check if we're on a conversation route - check /c/:id format
  const conversationIdMatch = pathname?.match(/\/c\/([^/]+)$/);
  const isConversationRoute = conversationIdMatch &&
    !pathname.includes('/settings') &&
    !isNewChatRoute;

  // Check if we're on a user route - check /u/:id format
  const userRouteMatch = pathname?.match(/\/u\/([^/]+)$/);
  const isUserRoute = userRouteMatch &&
    !pathname.includes('/settings') &&
    !isNewChatRoute;

  const targetUserId = isUserRoute && userRouteMatch ? userRouteMatch[1] : undefined;
  const targetUser = useUserById(targetUserId);

  // Find active conversation for 3rd pane
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

  // Prepare contact details props
  const contactDetailsProps = useMemo(() => {
    if (activeConversation) {
      const isGroup = activeConversation.type === 'group';
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

    // Fallback: if no conversation but we have a target user (from /u/:id)
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
        isOnline: false,
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
    rightPaneEmpty: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
      backgroundColor: theme.colors.background,
    },
    emptyTitle: {
      fontSize: 24,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginBottom: 12,
      textAlign: 'center',
    },
    emptySubtitle: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 24,
    },
    mobileContainer: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
  }), [theme.colors.background, theme.colors.border, theme.colors.text, theme.colors.textSecondary]);

  // On large screens, show two-pane layout
  if (isLargeScreen) {
    // Dynamically import settings only when needed to avoid circular imports
    const ChatSettings = isSettingsRoute ? require('./settings/index').default : null;

    return (
      <ThemedView style={styles.container}>
        {/* Left pane - show conversations list or settings index */}
        <View style={styles.leftPane}>
          {isSettingsRoute && ChatSettings ? (
            <ChatSettings />
          ) : (
            <ConversationsList />
          )}
        </View>

        {/* Right pane - show conversation detail, nested settings, new chat, or empty state */}
        <View style={[
          styles.rightPane,
          showContactDetails && styles.middlePaneWithBorder
        ]}>
          {isNestedSettingsRoute ? (
            // Show nested settings route - use Stack with all possible nested routes
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: theme.colors.background },
              }}
            >
              {/* First level nested routes */}
              <Stack.Screen
                name="settings/appearance"
                options={{ title: 'Appearance' }}
              />
              <Stack.Screen
                name="settings/language"
                options={{ title: 'Language' }}
              />
              <Stack.Screen
                name="settings/privacy"
                options={{ title: 'Privacy' }}
              />
              <Stack.Screen
                name="settings/profile-customization"
                options={{ title: 'Profile Customization' }}
              />
              {/* Second level nested routes under privacy */}
              <Stack.Screen
                name="settings/privacy/profile-visibility"
                options={{ title: 'Profile Visibility' }}
              />
              <Stack.Screen
                name="settings/privacy/tags-allos"
                options={{ title: 'Tags & allos' }}
              />
              <Stack.Screen
                name="settings/privacy/online-status"
                options={{ title: 'Online Status' }}
              />
              <Stack.Screen
                name="settings/privacy/restricted"
                options={{ title: 'Restricted' }}
              />
              <Stack.Screen
                name="settings/privacy/blocked"
                options={{ title: 'Blocked' }}
              />
              <Stack.Screen
                name="settings/privacy/hidden-words"
                options={{ title: 'Hidden Words' }}
              />
              <Stack.Screen
                name="settings/privacy/hide-counts"
                options={{ title: 'Hide Counts' }}
              />
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
            // Empty state when on index route
            <View style={styles.rightPaneEmpty}>
              <ThemedText style={styles.emptyTitle}>Select a conversation</ThemedText>
              <ThemedText style={styles.emptySubtitle}>
                Choose a conversation from the list to start messaging
              </ThemedText>
            </View>
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
        <Stack.Screen
          name="index"
          options={{ title: 'Conversations' }}
        />
        <Stack.Screen
          name="new"
          options={{ title: 'New Chat' }}
        />
        <Stack.Screen
          name="c/[id]"
          options={{ title: 'Chat' }}
        />
        <Stack.Screen
          name="u/[id]"
          options={{ title: 'Chat' }}
        />
        <Stack.Screen
          name="settings/index"
          options={{ title: 'Settings' }}
        />
        <Stack.Screen
          name="settings/appearance"
          options={{ title: 'Appearance' }}
        />
        <Stack.Screen
          name="settings/language"
          options={{ title: 'Language' }}
        />
        <Stack.Screen
          name="settings/privacy"
          options={{ title: 'Privacy' }}
        />
        <Stack.Screen
          name="settings/profile-customization"
          options={{ title: 'Profile Customization' }}
        />
      </Stack>
    </ThemedView>
  );
}
