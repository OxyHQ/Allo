import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useConnectionStatusStore } from '@/lib/network/connectionStatus';
import { useTheme } from '@/hooks/useTheme';

/**
 * Offline banner displayed at the top of screens when the device is disconnected.
 * Mimics WhatsApp/Telegram behavior: appears instantly, disappears on reconnect.
 */
export const OfflineBanner: React.FC = React.memo(() => {
  const isConnected = useConnectionStatusStore(state => state.isConnected);
  const theme = useTheme();

  const styles = useMemo(() => StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 6,
      paddingHorizontal: 16,
      gap: 6,
      backgroundColor: theme.isDark ? '#3a3a00' : '#fff3cd',
    },
    text: {
      fontSize: 13,
      fontWeight: '500',
      color: theme.isDark ? '#ffd60a' : '#856404',
    },
  }), [theme.isDark]);

  if (isConnected) return null;

  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)}>
      <View style={styles.banner}>
        <Ionicons
          name="cloud-offline-outline"
          size={16}
          color={theme.isDark ? '#ffd60a' : '#856404'}
        />
        <Text style={styles.text}>No internet connection</Text>
      </View>
    </Animated.View>
  );
});

OfflineBanner.displayName = 'OfflineBanner';
