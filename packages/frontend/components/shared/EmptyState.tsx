import React, { useMemo } from 'react';
import { View, StyleSheet, Image, ImageSourcePropType } from 'react-native';
import LottieView from 'lottie-react-native';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';

export interface EmptyStateProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  lottieSource?: any;
  imageSource?: ImageSourcePropType;
  lottieSize?: number;
  imageSize?: number;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  subtitle,
  icon,
  lottieSource,
  imageSource,
  lottieSize = 200,
  imageSize = 200
}) => {
  const theme = useTheme();

  const minSize = Math.min(Math.max(lottieSize, 50), 120);
  const finalImageSize = Math.min(Math.max(imageSize, 50), 200);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
      backgroundColor: theme.colors.background,
    },
    content: {
      alignItems: 'center',
      maxWidth: 400,
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
      height: minSize,
      marginBottom: 24,
    },
    image: {
      width: finalImageSize,
      height: finalImageSize,
      marginBottom: 24,
      resizeMode: 'contain',
    },
  }), [theme.colors, subtitle, minSize, finalImageSize]);

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {imageSource && <Image source={imageSource} style={styles.image} />}
        {!imageSource && lottieSource && (
          <LottieView
            source={lottieSource}
            autoPlay
            loop
            style={styles.lottieAnimation}
            webStyle={{ width: minSize, height: minSize }}
          />
        )}
        {!imageSource && !lottieSource && icon && <View style={styles.iconContainer}>{icon}</View>}
        <ThemedText style={styles.title}>{title}</ThemedText>
        {subtitle && <ThemedText style={styles.subtitle}>{subtitle}</ThemedText>}
      </View>
    </View>
  );
};




