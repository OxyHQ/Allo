import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { useConnectionStatusStore, ConnectionStatus, startConnectionMonitoring } from '@/lib/network/connectionStatus';
import { useTheme } from '@/hooks/useTheme';

/**
 * Connection Status Indicator
 *
 * WhatsApp/Telegram-level: Shows connection status banner
 * Displays "Connecting...", "Offline", or nothing when online
 */

export function ConnectionStatusIndicator(): JSX.Element | null {
  const theme = useTheme();
  const status = useConnectionStatusStore((state) => state.status);
  const [slideAnim] = React.useState(new Animated.Value(-50));

  // Start monitoring on mount
  useEffect(() => {
    const unsubscribe = startConnectionMonitoring();
    return unsubscribe;
  }, []);

  // Animate banner in/out
  useEffect(() => {
    if (status === 'online') {
      // Slide out
      Animated.timing(slideAnim, {
        toValue: -50,
        duration: 300,
        useNativeDriver: true,
      }).start();
    } else {
      // Slide in
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [status, slideAnim]);

  if (status === 'online') {
    return null;
  }

  const backgroundColor = status === 'offline' ? '#FF3B30' : '#FF9500';
  const text = status === 'offline' ? 'No internet connection' : 'Connecting...';

  return (
    <Animated.View
      style={[
        styles.container,
        {
          backgroundColor,
          transform: [{ translateY: slideAnim }],
        },
      ]}
    >
      <Text style={styles.text}>{text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  text: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
