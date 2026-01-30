import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import LottieView from 'lottie-react-native';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';

export interface EmptyStateProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  lottieSource?: any; // Lottie animation source
  lottieSize?: number; // Size of Lottie animation (default: 200)
}

/**
 * Empty state component for displaying placeholder content
 *
 * Used across the application for consistent empty states
 * Follows design system patterns
 * Now supports Lottie animations for engaging empty states
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  subtitle,
  icon,
  lottieSource,
  lottieSize = 200
}) => {
  const theme = useTheme();

  // Constrain lottieSize to reasonable limits (WhatsApp/Telegram pattern)
  const constrainedSize = Math.min(lottieSize, 200); // Max 200px
  const minSize = Math.max(constrainedSize, 120); // Min 120px

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
      backgroundColor: theme.colors.background,
      maxWidth: 400, // Constrain content width
      alignSelf: 'center',
      width: '100%',
    },
    title: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginBottom: subtitle ? 8 : 0,
      maxWidth: 320, // Prevent text from being too wide
    },
    subtitle: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 24,
      maxWidth: 320, // Prevent text from being too wide
    },
    iconContainer: {
      marginBottom: 16,
    },
    lottieAnimation: {
      width: minSize,
      aspectRatio: 1, // Maintain square aspect ratio
      marginBottom: 24,
    },
  }), [theme.colors, subtitle, minSize]);

  return (
    <View style={styles.container}>
      {lottieSource && (
        <LottieView
          source={lottieSource}
          autoPlay
          loop
          style={styles.lottieAnimation}
        />
      )}
      {!lottieSource && icon && <View style={styles.iconContainer}>{icon}</View>}
      <ThemedText style={styles.title}>{title}</ThemedText>
      {subtitle && <ThemedText style={styles.subtitle}>{subtitle}</ThemedText>}
    </View>
  );
};




