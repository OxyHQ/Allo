import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useFocusEffect } from '@react-navigation/native';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@/hooks/useTheme';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import { useDeviceListRefreshStore } from '@/stores/deviceListRefreshStore';
import { api } from '@/utils/api';
import { confirmDialog, alertDialog } from '@/utils/alerts';
import { SPACING, SPACING_CLASSES } from '@/constants/spacing';

const IconComponent = Ionicons as unknown as React.ComponentType<{
  name: string;
  size: number;
  color: string;
}>;

/** Public device shape returned by `GET /api/devices`. */
interface LinkedDevice {
  deviceId: number;
  deviceName?: string;
  platform?: 'ios' | 'android' | 'web';
  lastSeen?: string;
  createdAt?: string;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Ionicons glyph for a device platform. */
function platformIcon(platform: LinkedDevice['platform']): string {
  switch (platform) {
    case 'ios':
      return 'phone-portrait-outline';
    case 'android':
      return 'logo-android';
    case 'web':
      return 'desktop-outline';
    default:
      return 'hardware-chip-outline';
  }
}

export default function LinkedDevicesScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const ownDeviceId = useDeviceKeysStore((state) => state.deviceKeys?.deviceId);
  const refreshRevision = useDeviceListRefreshStore((state) => state.revision);

  const [devices, setDevices] = useState<LinkedDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);

  const fetchDevices = useCallback(async () => {
    try {
      setError(null);
      const response = await api.get('/devices');
      const body = response.data as { data?: { devices?: LinkedDevice[] } } | { devices?: LinkedDevice[] };
      const payload = 'data' in body && body.data ? body.data : (body as { devices?: LinkedDevice[] });
      const list = Array.isArray(payload.devices) ? payload.devices : [];
      // Own device first, then most-recently-seen.
      list.sort((a, b) => {
        if (a.deviceId === ownDeviceId) return -1;
        if (b.deviceId === ownDeviceId) return 1;
        const aTime = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
        const bTime = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
        return bTime - aTime;
      });
      setDevices(list);
    } catch (err) {
      console.error('[LinkedDevices] Failed to fetch devices:', err);
      setError(t('settings.linkedDevices.loadError', 'Could not load your devices.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [ownDeviceId, t]);

  // Refetch when the screen gains focus.
  useFocusEffect(
    useCallback(() => {
      void fetchDevices();
    }, [fetchDevices])
  );

  // Refetch while mounted whenever the realtime `deviceListChanged` event bumps
  // the refresh signal (a device was linked or revoked on another device). This
  // is an external-event subscription, not derivable state, so an effect is the
  // correct tool. The initial render is covered by the focus effect above.
  useEffect(() => {
    if (refreshRevision === 0) return;
    void fetchDevices();
  }, [refreshRevision, fetchDevices]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void fetchDevices();
  }, [fetchDevices]);

  const formatLastSeen = useCallback(
    (device: LinkedDevice): string => {
      const iso = device.lastSeen ?? device.createdAt;
      if (!iso) return t('settings.linkedDevices.lastSeenUnknown', 'Last activity unknown');
      const then = new Date(iso).getTime();
      if (Number.isNaN(then)) return t('settings.linkedDevices.lastSeenUnknown', 'Last activity unknown');
      const diff = Date.now() - then;
      if (diff < MINUTE_MS) return t('settings.linkedDevices.lastSeenNow', 'Active now');
      if (diff < HOUR_MS) {
        const minutes = Math.floor(diff / MINUTE_MS);
        return t('settings.linkedDevices.lastSeenMinutes', { count: minutes, defaultValue: '{{count}}m ago' });
      }
      if (diff < DAY_MS) {
        const hours = Math.floor(diff / HOUR_MS);
        return t('settings.linkedDevices.lastSeenHours', { count: hours, defaultValue: '{{count}}h ago' });
      }
      const days = Math.floor(diff / DAY_MS);
      return t('settings.linkedDevices.lastSeenDays', { count: days, defaultValue: '{{count}}d ago' });
    },
    [t]
  );

  const onRevoke = useCallback(
    async (device: LinkedDevice) => {
      const isSelf = device.deviceId === ownDeviceId;
      const confirmed = await confirmDialog({
        title: t('settings.linkedDevices.revokeTitle', 'Remove device?'),
        message: isSelf
          ? t(
              'settings.linkedDevices.revokeSelfMessage',
              'This is the device you are using. Removing it will sign this device out of encrypted messaging and re-link it as a new device.'
            )
          : t(
              'settings.linkedDevices.revokeMessage',
              'This device will be signed out of encrypted messaging and will no longer receive your messages.'
            ),
        okText: t('settings.linkedDevices.revokeConfirm', 'Remove'),
        cancelText: t('common.cancel', 'Cancel'),
        destructive: true,
      });
      if (!confirmed) return;

      setRevokingId(device.deviceId);
      try {
        await api.delete(`/devices/${device.deviceId}`);
        // Optimistically drop it; the realtime `deviceListChanged` will reconcile.
        setDevices((prev) => prev.filter((d) => d.deviceId !== device.deviceId));
      } catch (err) {
        console.error('[LinkedDevices] Failed to revoke device:', err);
        await alertDialog({
          title: t('common.error', 'Error'),
          message: t('settings.linkedDevices.revokeError', 'Could not remove this device. Please try again.'),
        });
      } finally {
        setRevokingId(null);
      }
    },
    [ownDeviceId, t]
  );

  const content = useMemo(() => {
    if (loading) {
      return (
        <View className="flex-1 items-center justify-center py-10">
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      );
    }

    if (error) {
      return (
        <View className={`items-center justify-center py-10 px-${SPACING.screen.horizontal}`}>
          <IconComponent name="cloud-offline-outline" size={40} color={theme.colors.textTertiary} />
          <Text className="text-[15px] text-center mt-3" style={{ color: theme.colors.textSecondary }}>
            {error}
          </Text>
          <TouchableOpacity
            className="mt-4 px-5 py-2.5 rounded-full"
            style={{ backgroundColor: theme.colors.primary }}
            onPress={() => {
              setLoading(true);
              void fetchDevices();
            }}
            activeOpacity={0.85}
          >
            <Text className="text-[15px] font-medium" style={{ color: theme.colors.card }}>
              {t('settings.linkedDevices.retry', 'Try again')}
            </Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (devices.length === 0) {
      return (
        <View className={`items-center justify-center py-10 px-${SPACING.screen.horizontal}`}>
          <IconComponent name="phone-portrait-outline" size={40} color={theme.colors.textTertiary} />
          <Text className="text-[15px] text-center mt-3" style={{ color: theme.colors.textSecondary }}>
            {t('settings.linkedDevices.empty', 'No linked devices yet.')}
          </Text>
        </View>
      );
    }

    return (
      <View className="rounded-2xl border overflow-hidden" style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}>
        {devices.map((device, index) => {
          const isSelf = device.deviceId === ownDeviceId;
          const isRevoking = revokingId === device.deviceId;
          const name =
            device.deviceName ||
            t(`settings.linkedDevices.platform.${device.platform ?? 'unknown'}`, {
              defaultValue: t('settings.linkedDevices.platform.unknown', 'Unknown device'),
            });
          return (
            <View key={device.deviceId}>
              {index > 0 ? (
                <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />
              ) : null}
              <View
                className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}
              >
                <View className="flex-row items-center flex-1">
                  <View
                    className={`w-10 h-10 rounded-full items-center justify-center mr-${SPACING.item.iconMargin}`}
                    style={{ backgroundColor: theme.colors.background }}
                  >
                    <IconComponent name={platformIcon(device.platform)} size={20} color={theme.colors.primary} />
                  </View>
                  <View className="flex-1 pr-3">
                    <View className="flex-row items-center">
                      <Text className="text-[15px] font-medium" style={{ color: theme.colors.text }} numberOfLines={1}>
                        {name}
                      </Text>
                      {isSelf ? (
                        <View
                          className="ml-2 px-2 py-0.5 rounded-full"
                          style={{ backgroundColor: theme.colors.primary }}
                        >
                          <Text className="text-[11px] font-semibold" style={{ color: theme.colors.card }}>
                            {t('settings.linkedDevices.thisDevice', 'This device')}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text className="text-[13px] mt-0.5" style={{ color: theme.colors.textSecondary }} numberOfLines={1}>
                      {formatLastSeen(device)}
                    </Text>
                  </View>
                </View>
                {isRevoking ? (
                  <ActivityIndicator color={theme.colors.error} />
                ) : (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.linkedDevices.revokeConfirm', 'Remove')}
                    onPress={() => onRevoke(device)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    activeOpacity={0.7}
                  >
                    <IconComponent name="close-circle-outline" size={22} color={theme.colors.error} />
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        })}
      </View>
    );
  }, [devices, error, fetchDevices, formatLastSeen, loading, onRevoke, ownDeviceId, revokingId, t, theme.colors]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.linkedDevices.title', 'Linked Devices'),
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView
        className={SPACING_CLASSES.screen}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
        }
      >
        <Text className={`text-[13px] mb-${SPACING.content.gapLarge} px-1`} style={{ color: theme.colors.textSecondary }}>
          {t(
            'settings.linkedDevices.subtitle',
            'Devices linked to your account. Each has its own end-to-end encryption keys. Remove any device you no longer use.'
          )}
        </Text>

        {/* History transfer actions (Fase 1C) */}
        <View
          className="rounded-2xl border overflow-hidden mb-4"
          style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}
        >
          <TouchableOpacity
            className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}
            onPress={() => router.push('/settings/transfer-history-send')}
            activeOpacity={0.7}
          >
            <View className="flex-row items-center flex-1">
              <View
                className={`w-10 h-10 rounded-full items-center justify-center mr-${SPACING.item.iconMargin}`}
                style={{ backgroundColor: theme.colors.background }}
              >
                <IconComponent name="cloud-upload-outline" size={20} color={theme.colors.primary} />
              </View>
              <View className="flex-1 pr-3">
                <Text className="text-[15px] font-medium" style={{ color: theme.colors.text }}>
                  {t('settings.transferHistory.sendRow', 'Transfer history to a device')}
                </Text>
                <Text className="text-[13px] mt-0.5" style={{ color: theme.colors.textSecondary }}>
                  {t(
                    'settings.transferHistory.sendRowDescription',
                    'Copy your chats to a device you are signing in on'
                  )}
                </Text>
              </View>
            </View>
            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
          </TouchableOpacity>

          <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

          <TouchableOpacity
            className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}
            onPress={() => router.push('/settings/transfer-history')}
            activeOpacity={0.7}
          >
            <View className="flex-row items-center flex-1">
              <View
                className={`w-10 h-10 rounded-full items-center justify-center mr-${SPACING.item.iconMargin}`}
                style={{ backgroundColor: theme.colors.background }}
              >
                <IconComponent name="cloud-download-outline" size={20} color={theme.colors.primary} />
              </View>
              <View className="flex-1 pr-3">
                <Text className="text-[15px] font-medium" style={{ color: theme.colors.text }}>
                  {t('settings.transferHistory.receiveRow', 'Receive history on this device')}
                </Text>
                <Text className="text-[13px] mt-0.5" style={{ color: theme.colors.textSecondary }}>
                  {t(
                    'settings.transferHistory.receiveRowDescription',
                    'Get your existing chats from another device'
                  )}
                </Text>
              </View>
            </View>
            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
          </TouchableOpacity>
        </View>

        {content}
      </ScrollView>
    </ThemedView>
  );
}
