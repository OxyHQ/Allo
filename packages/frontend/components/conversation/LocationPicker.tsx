/**
 * LocationPicker — bottom-sheet content for sharing the current location (F2.6).
 *
 * Flow: request foreground location permission → fetch a one-shot fix → reverse
 * geocode for a human address (native only) → let the user add an optional label
 * → send. Permission denial and unavailability render graceful, i18n'd states
 * with an "open settings" affordance.
 *
 * No third-party static-map tiles are fetched (free providers require an API key
 * or forbid static use), so the preview is a styled, key-free coordinate card
 * with a pin — the same visual language as the sent `LocationMessage` bubble. The
 * actual map opens on demand via the platform maps deep link from that bubble.
 *
 * For encrypted conversations the coordinates travel inside the E2E body (handled
 * by the messages store); this component only produces the `LocationData`.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Linking,
} from 'react-native';
import * as Location from 'expo-location';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import type { LocationData } from '@/stores/messagesStore';

interface LocationPickerProps {
  onSend: (location: LocationData) => void;
  onClose: () => void;
}

/** Coordinate fetch states (drives which UI section renders). */
type PickerState = 'loading' | 'denied' | 'unavailable' | 'ready';

/** Accent used for the location pin / send button (matches the menu entry). */
const LOCATION_ACCENT = '#00B894';

export const LocationPicker: React.FC<LocationPickerProps> = ({ onSend, onClose }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [state, setState] = useState<PickerState>('loading');
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [address, setAddress] = useState<string | undefined>(undefined);
  const [label, setLabel] = useState('');

  const fetchLocation = useCallback(async () => {
    setState('loading');
    try {
      // Web Geolocation is gated by the browser, not expo-location.
      if (Platform.OS === 'web') {
        if (!('navigator' in globalThis) || !navigator.geolocation) {
          setState('unavailable');
          return;
        }
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false,
            timeout: 15000,
          });
        }).catch(() => null);
        if (!position) {
          setState('denied');
          return;
        }
        setCoords({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
        setState('ready');
        return;
      }

      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setState('denied');
        return;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;
      setCoords({ latitude, longitude });
      setState('ready');

      // Reverse geocode is best-effort; a failure just omits the address line.
      try {
        const places = await Location.reverseGeocodeAsync({ latitude, longitude });
        const first = places[0];
        if (first) {
          const parts = [first.name, first.street, first.city, first.region, first.country]
            .filter((part): part is string => Boolean(part))
            .join(', ');
          if (parts.length > 0) setAddress(parts);
        }
      } catch (error) {
        console.warn('[LocationPicker] reverse geocode failed:', error);
      }
    } catch (error) {
      console.error('[LocationPicker] failed to get location:', error);
      setState('unavailable');
    }
  }, []);

  useEffect(() => {
    void fetchLocation();
  }, [fetchLocation]);

  const handleSend = useCallback(() => {
    if (!coords) return;
    const trimmedLabel = label.trim();
    const location: LocationData = {
      latitude: coords.latitude,
      longitude: coords.longitude,
    };
    if (address) location.address = address;
    if (trimmedLabel.length > 0) location.label = trimmedLabel;
    onSend(location);
    onClose();
  }, [coords, label, address, onSend, onClose]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { padding: 16, paddingTop: 0 },
        title: { fontSize: 18, fontWeight: '700', marginBottom: 12, color: theme.colors.text },
        state: { paddingVertical: 48, alignItems: 'center', gap: 12 },
        stateText: { color: theme.colors.textSecondary, textAlign: 'center', maxWidth: 280 },
        settingsButton: {
          marginTop: 4,
          paddingHorizontal: 18,
          paddingVertical: 10,
          borderRadius: 999,
          backgroundColor: theme.colors.card,
        },
        settingsText: { color: theme.colors.primary, fontWeight: '600' },
        retryText: { color: theme.colors.primary, fontWeight: '600' },
        preview: {
          height: 160,
          borderRadius: 16,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 16,
        },
        pinShadow: {
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: 'rgba(255,255,255,0.85)',
          alignItems: 'center',
          justifyContent: 'center',
        },
        coords: { marginTop: 10, color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
        addressLabel: {
          fontSize: 14,
          fontWeight: '600',
          color: theme.colors.text,
          marginBottom: 8,
        },
        input: {
          backgroundColor: theme.colors.card,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          marginBottom: 16,
          color: theme.colors.text,
        },
        sendButton: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          backgroundColor: LOCATION_ACCENT,
          borderRadius: 14,
          paddingVertical: 14,
        },
        sendText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
      }),
    [theme]
  );

  if (state === 'loading') {
    return (
      <View style={styles.container}>
        <ThemedText style={styles.title}>{t('chat.shareLocation')}</ThemedText>
        <View style={styles.state}>
          <ActivityIndicator color={theme.colors.primary} />
          <ThemedText style={styles.stateText}>{t('chat.locationFetching')}</ThemedText>
        </View>
      </View>
    );
  }

  if (state === 'denied' || state === 'unavailable') {
    const message =
      state === 'denied' ? t('chat.locationDeniedHelp') : t('chat.locationUnavailable');
    return (
      <View style={styles.container}>
        <ThemedText style={styles.title}>{t('chat.shareLocation')}</ThemedText>
        <View style={styles.state}>
          <Ionicons name="location-outline" size={36} color={theme.colors.textSecondary} />
          <ThemedText style={styles.stateText}>{message}</ThemedText>
          {state === 'denied' && Platform.OS !== 'web' && (
            <TouchableOpacity
              style={styles.settingsButton}
              activeOpacity={0.7}
              onPress={() => {
                Linking.openSettings().catch((error) =>
                  console.warn('[LocationPicker] openSettings failed:', error)
                );
              }}
            >
              <ThemedText style={styles.settingsText}>{t('chat.openSettings')}</ThemedText>
            </TouchableOpacity>
          )}
          <TouchableOpacity activeOpacity={0.7} onPress={() => void fetchLocation()}>
            <ThemedText style={styles.retryText}>{t('chat.retry')}</ThemedText>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ThemedText style={styles.title}>{t('chat.shareLocation')}</ThemedText>
      <LinearGradient
        colors={['#1FA98A', LOCATION_ACCENT, '#0E8C72']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.preview}
      >
        <View style={styles.pinShadow}>
          <Ionicons name="location" size={32} color={LOCATION_ACCENT} />
        </View>
        {coords && (
          <ThemedText style={styles.coords}>
            {coords.latitude.toFixed(5)}, {coords.longitude.toFixed(5)}
          </ThemedText>
        )}
      </LinearGradient>
      {address && <ThemedText style={styles.addressLabel}>{address}</ThemedText>}
      <TextInput
        style={styles.input}
        value={label}
        onChangeText={setLabel}
        placeholder={t('chat.locationLabelPlaceholder')}
        placeholderTextColor={theme.colors.textSecondary}
        returnKeyType="send"
        onSubmitEditing={handleSend}
      />
      <TouchableOpacity style={styles.sendButton} activeOpacity={0.85} onPress={handleSend}>
        <Ionicons name="send" size={18} color="#FFFFFF" />
        <ThemedText style={styles.sendText}>{t('chat.sendLocation')}</ThemedText>
      </TouchableOpacity>
    </View>
  );
};
