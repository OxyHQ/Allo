import React from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

/**
 * Loading fallback component for Suspense boundaries
 * 
 * Follows React 18+ Suspense patterns and Expo Router 54 best practices
 * Used across the application for consistent loading states
 */
export const LoadingFallback: React.FC = () => {
  const theme = useTheme();
  
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});


