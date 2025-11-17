import React, { Suspense, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, Slot } from 'expo-router';

// Components
import { ThemedView } from '@/components/ThemedView';
import { EmptyState } from '@/components/shared/EmptyState';
import { LoadingFallback } from '@/components/shared/LoadingFallback';
import ConversationsList from './index';
import StatusScreen from './status';

// Hooks
import { useTheme } from '@/hooks/useTheme';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { useRouteDetection } from '@/hooks/useRouteDetection';

// Constants
import { BREAKPOINTS } from '@/constants/responsive';

// Dynamic imports for code splitting (Expo Router 54 best practice)
const ChatSettings = React.lazy(() => import('./settings/index'));

/**
 * Chat Layout with responsive two-pane support
 * 
 * Follows Expo Router 54 best practices:
 * - Uses file-based routing with proper Slot/Stack usage
 * - Implements code splitting with React.lazy and Suspense
 * - Leverages useSegments and usePathname for type-safe routing
 * - Separates route detection logic into custom hooks
 * 
 * Routes:
 * - / (index.tsx) - Conversations list
 * - /status (status.tsx) - Status screen
 * - /settings (settings/index.tsx) - Chat settings
 * - /settings/:subroute (settings/*.tsx) - Nested settings
 */
export default function ChatLayout() {
  const theme = useTheme();
  const isLargeScreen = useOptimizedMediaQuery({ minWidth: BREAKPOINTS.TABLET });
  const route = useRouteDetection();

  const {
    isSettingsRoute,
    isSettingsIndexRoute,
    isNestedSettingsRoute,
    isStatusRoute,
    isIndexRoute,
    isConversationRoute,
  } = route;

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
    mobileContainer: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
  }), [theme.colors.background, theme.colors.border]);

  // On large screens, show two-pane layout
  if (isLargeScreen) {
    return (
      <ThemedView style={styles.container}>
        {/* Left pane - show status, conversations list, or settings index */}
        <View style={styles.leftPane}>
          {isSettingsRoute && isSettingsIndexRoute ? (
            <Suspense fallback={<LoadingFallback />}>
              <ChatSettings />
            </Suspense>
          ) : isStatusRoute ? (
            <StatusScreen />
          ) : (
            <ConversationsList />
          )}
        </View>

        {/* Right pane - show nested settings, conversation, or empty state */}
        <View style={styles.rightPane}>
          {isStatusRoute ? (
            <EmptyState
              title="Status"
              subtitle="View and manage status updates"
            />
          ) : isNestedSettingsRoute ? (
            <Suspense fallback={<LoadingFallback />}>
              {/* 
                Expo Router automatically discovers nested routes from file system.
                Stack.Screen declarations allow customization of route options.
              */}
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: theme.colors.background },
                }}
              >
                {/* First-level nested settings routes */}
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
                {/* Second-level nested routes under privacy */}
                <Stack.Screen
                  name="settings/privacy/profile-visibility"
                  options={{ title: 'Profile Visibility' }}
                />
                <Stack.Screen
                  name="settings/privacy/tags-mentions"
                  options={{ title: 'Tags & Mentions' }}
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
            </Suspense>
          ) : isConversationRoute ? (
            // Conversation routes are handled by /c/_layout.tsx at the root level
            // For two-pane layout, we show an empty state here
            // The actual conversation will be shown in /c/_layout.tsx
            <EmptyState
              title="Conversation"
              subtitle="Viewing conversation details"
            />
          ) : (
            <EmptyState
              title="Select a conversation"
              subtitle="Choose a conversation from the list to start messaging"
            />
          )}
        </View>
      </ThemedView>
    );
  }

  // On small screens, use Stack navigator with file-based routing
  // Expo Router automatically discovers routes from the file system
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
          name="status"
          options={{ title: 'Status' }}
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
        {/* Conversation routes are handled in /c/_layout.tsx */}
      </Stack>
    </ThemedView>
  );
}
