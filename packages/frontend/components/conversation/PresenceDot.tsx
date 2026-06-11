import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { usePresence } from '@/stores/presenceStore';

/** Default dot diameter (px). */
const DEFAULT_SIZE = 12;
/** Default ring width around the dot so it reads against the avatar (px). */
const DEFAULT_BORDER_WIDTH = 2;

interface PresenceDotProps {
  /** User whose online state this dot reflects. */
  userId?: string;
  /** Dot diameter in px. */
  size?: number;
  /** Ring width in px. */
  borderWidth?: number;
}

/**
 * A small online-status dot for a single user.
 *
 * Subscribes to ITS OWN user's presence via the `usePresence(userId)` selector,
 * so in a FlashList only the affected row re-renders when that user's presence
 * changes. Renders nothing unless the user is online. Intended to be placed
 * inside a `position: relative` container (e.g. an avatar wrapper); it positions
 * itself absolutely at the bottom-right.
 */
export function PresenceDot({
  userId,
  size = DEFAULT_SIZE,
  borderWidth = DEFAULT_BORDER_WIDTH,
}: PresenceDotProps) {
  const theme = useTheme();
  const presence = usePresence(userId);

  if (!userId || !presence?.online) {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth,
          // `success` is the Bloom semantic token for a positive/online state.
          backgroundColor: theme.colors.success,
          // Ring matches the surrounding row so the dot reads as a status badge.
          borderColor: theme.colors.background,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
  },
});
