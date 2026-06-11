/**
 * LocationMessage — renders a shared location as a styled, map-like card with a
 * pin, the place label/address, coordinates, and an "open in maps" affordance.
 *
 * No third-party static-map tiles are fetched (free providers require an API key
 * or forbid static use), so the preview is a key-free gradient card. Tapping
 * opens the platform maps app: the `geo:` scheme on Android, `maps:` on iOS, and
 * an OpenStreetMap web URL on web.
 */
import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity, Linking, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import type { LocationData } from '@/stores/messagesStore';

interface LocationMessageProps {
  location: LocationData;
  isSent: boolean;
}

/** Accent used for the location pin (matches the attachment-menu entry). */
const LOCATION_ACCENT = '#00B894';

export const LocationMessage: React.FC<LocationMessageProps> = ({ location, isSent }) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const openInMaps = useCallback(() => {
    const { latitude, longitude, label } = location;
    const query = label ? encodeURIComponent(label) : undefined;
    const url =
      Platform.OS === 'ios'
        ? `http://maps.apple.com/?ll=${latitude},${longitude}${query ? `&q=${query}` : ''}`
        : Platform.OS === 'android'
          ? `geo:${latitude},${longitude}?q=${latitude},${longitude}${query ? `(${query})` : ''}`
          : `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
    Linking.openURL(url).catch((error) =>
      console.warn('[LocationMessage] openURL failed:', error)
    );
  }, [location]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          width: 240,
          borderRadius: 16,
          overflow: 'hidden',
          backgroundColor: isSent
            ? theme.colors.messageBubbleSent
            : theme.colors.messageBubbleReceived,
        },
        map: {
          height: 120,
          alignItems: 'center',
          justifyContent: 'center',
        },
        pinShadow: {
          width: 48,
          height: 48,
          borderRadius: 24,
          backgroundColor: 'rgba(255,255,255,0.85)',
          alignItems: 'center',
          justifyContent: 'center',
        },
        body: { paddingHorizontal: 12, paddingVertical: 10, gap: 2 },
        title: {
          fontSize: 15,
          fontWeight: '700',
          color: isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived,
        },
        coords: {
          fontSize: 12,
          color: isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived,
          opacity: 0.7,
        },
        link: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          marginTop: 4,
        },
        linkText: {
          fontSize: 13,
          fontWeight: '600',
          color: theme.colors.primary,
        },
      }),
    [theme, isSent]
  );

  return (
    <TouchableOpacity style={styles.container} onPress={openInMaps} activeOpacity={0.85}>
      <LinearGradient
        colors={['#1FA98A', LOCATION_ACCENT, '#0E8C72']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.map}
      >
        <View style={styles.pinShadow}>
          <Ionicons name="location" size={28} color={LOCATION_ACCENT} />
        </View>
      </LinearGradient>
      <View style={styles.body}>
        <ThemedText style={styles.title} numberOfLines={1}>
          {location.label || location.address || t('chat.locationShared')}
        </ThemedText>
        <ThemedText style={styles.coords}>
          {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
        </ThemedText>
        <View style={styles.link}>
          <Ionicons name="navigate-outline" size={14} color={theme.colors.primary} />
          <ThemedText style={styles.linkText}>{t('chat.openInMaps')}</ThemedText>
        </View>
      </View>
    </TouchableOpacity>
  );
};
