import React from 'react';
import { View, StyleSheet } from 'react-native';
import { ConversationListSkeleton } from '@/components/shared/Skeleton';

/**
 * Loading fallback component for Suspense boundaries
 *
 * Follows React 18+ Suspense patterns and Expo Router 54 best practices
 * Used across the application for consistent loading states
 */
export const LoadingFallback: React.FC = () => {
  return (
    <View style={styles.container}>
      <ConversationListSkeleton count={8} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});




