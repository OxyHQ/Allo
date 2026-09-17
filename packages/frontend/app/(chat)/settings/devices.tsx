import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { toast } from '@oxy.so/bloom/toast';
import { useOwnInstances, usePendingEnrollments, type InstanceView, type PendingEnrollmentView } from '@allo/react';

import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { ThemedText } from '@/components/ThemedText';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { confirmDialog } from '@/utils/alerts';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * THE ACCOUNT'S DEVICES.
 *
 * Two lists, from the SDK. The devices waiting to be approved come first,
 * because that is the one thing a person opens this screen to do: each shows
 * the device's name, its platform and the verification code the device itself
 * is showing, and a one-tap approve once the two have been compared — the
 * challenge is passed back to the SDK so a swapped one is refused before
 * anything is signed. Below them, every enrolled device with its status and
 * when it was last seen, and a way to remove any that is not this one.
 *
 * Removing THIS device is not offered here: that is signing out, and it lives
 * where signing out lives.
 */
export default function DevicesScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const own = useOwnInstances();
  const pending = usePendingEnrollments();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([own.refresh(), pending.refresh()]);
    } catch (error: unknown) {
      logger.error('[Devices] refresh failed:', error);
      toast.error(getErrorMessage(error) || t('devices.refreshFailed', 'The device list could not be refreshed'));
    } finally {
      setLoaded(true);
    }
  }, [own, pending, t]);

  useEffect(() => {
    void refreshAll();
    // Once on mount: the lists then follow the SDK's `instances` topic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(async (id: string, action: () => Promise<void>, failure: string) => {
    if (busyId !== null) return;
    setBusyId(id);
    try {
      await action();
    } catch (error: unknown) {
      logger.error('[Devices] action failed:', error);
      toast.error(getErrorMessage(error) || failure);
    } finally {
      setBusyId(null);
    }
  }, [busyId]);

  const approve = useCallback((enrollment: PendingEnrollmentView) => {
    void run(
      enrollment.instance.id,
      async () => {
        await pending.approve(enrollment.instance.id, enrollment.challenge);
        toast.success(t('devices.approved', 'Device approved'));
      },
      t('devices.approveFailed', 'The device could not be approved'),
    );
  }, [pending, run, t]);

  const reject = useCallback(async (enrollment: PendingEnrollmentView) => {
    const confirmed = await confirmDialog({
      title: t('devices.reject', 'Reject'),
      message: t('devices.rejectConfirm', 'The device will not be able to read your messages. You can still approve it later if it asks again.'),
      okText: t('devices.reject', 'Reject'),
      cancelText: t('common.cancel', 'Cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    void run(
      enrollment.instance.id,
      async () => {
        await pending.reject(enrollment.instance.id);
        toast.success(t('devices.rejected', 'Device rejected'));
      },
      t('devices.rejectFailed', 'The device could not be rejected'),
    );
  }, [pending, run, t]);

  const revoke = useCallback(async (instance: InstanceView) => {
    const confirmed = await confirmDialog({
      title: t('devices.remove', 'Remove device'),
      message: t('devices.removeConfirm', '{{name}} will be signed out of your conversations and will have to be approved again to come back.', { name: instance.displayName }),
      okText: t('devices.remove', 'Remove device'),
      cancelText: t('common.cancel', 'Cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    void run(
      instance.id,
      async () => {
        await own.revoke(instance.id);
        toast.success(t('devices.removed', 'Device removed'));
      },
      t('devices.removeFailed', 'The device could not be removed'),
    );
  }, [own, run, t]);

  const styles = useMemo(() => StyleSheet.create({
    content: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 32,
    },
    pendingCard: {
      padding: 16,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.backgroundSecondary,
      marginBottom: 12,
      gap: 8,
    },
    pendingTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    pendingDetail: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    fingerprint: {
      fontSize: 22,
      fontWeight: '700',
      letterSpacing: 2,
      fontVariant: ['tabular-nums'],
      color: theme.colors.text,
      textAlign: 'center',
      paddingVertical: 8,
    },
    pendingActions: {
      flexDirection: 'row',
      gap: 12,
      marginTop: 4,
    },
    button: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    approveButton: {
      backgroundColor: theme.colors.primary,
    },
    approveText: {
      color: theme.colors.background,
      fontWeight: '600',
    },
    rejectButton: {
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    rejectText: {
      color: theme.colors.error,
      fontWeight: '600',
    },
    empty: {
      paddingVertical: 24,
      alignItems: 'center',
    },
    emptyText: {
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
  }), [theme]);

  const enrolled = useMemo(
    () => [...own.instances].sort((a, b) => Number(b.isThis) - Number(a.isThis) || a.displayName.localeCompare(b.displayName)),
    [own.instances],
  );

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('devices.title', 'Devices'),
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
          rightComponents: [
            <HeaderIconButton key="refresh" onPress={() => { void refreshAll(); }}>
              <Ionicons name="refresh" size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder
        disableSticky
      />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {pending.pending.length > 0 && (
          <SettingsListGroup title={t('devices.waiting', 'Waiting for approval')}>
            {pending.pending.map((enrollment) => {
              const busy = busyId === enrollment.instance.id;
              return (
                <View key={enrollment.instance.id} style={styles.pendingCard}>
                  <ThemedText style={styles.pendingTitle}>{enrollment.instance.displayName}</ThemedText>
                  <ThemedText style={styles.pendingDetail}>
                    {`${platformLabel(enrollment.instance.platform)} · ${t('devices.requestedAt', 'asked {{when}}', { when: formatWhen(enrollment.instance.createdAt) })}`}
                  </ThemedText>
                  <ThemedText style={styles.pendingDetail}>
                    {t('devices.compareCode', 'Compare this code with the one on the new device before approving.')}
                  </ThemedText>
                  <Text style={styles.fingerprint} accessibilityLabel={t('enrollment.fingerprint', 'Verification code')}>
                    {enrollment.fingerprint}
                  </Text>
                  <View style={styles.pendingActions}>
                    <TouchableOpacity
                      style={[styles.button, styles.rejectButton]}
                      onPress={() => { void reject(enrollment); }}
                      disabled={busy}
                      accessibilityRole="button"
                    >
                      <Text style={styles.rejectText}>{t('devices.reject', 'Reject')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.button, styles.approveButton]}
                      onPress={() => approve(enrollment)}
                      disabled={busy}
                      accessibilityRole="button"
                    >
                      {busy ? <ActivityIndicator color={theme.colors.background} /> : <Text style={styles.approveText}>{t('devices.approve', 'Approve')}</Text>}
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </SettingsListGroup>
        )}

        <SettingsListGroup title={t('devices.enrolled', 'Your devices')}>
          {!loaded && enrolled.length === 0 ? (
            <View style={styles.empty}>
              <ActivityIndicator color={theme.colors.primary} />
            </View>
          ) : enrolled.length === 0 ? (
            <View style={styles.empty}>
              <ThemedText style={styles.emptyText}>{t('devices.none', 'No devices are enrolled yet.')}</ThemedText>
            </View>
          ) : (
            enrolled.map((instance) => (
              <SettingsListItem
                key={instance.id}
                icon={<Ionicons name={platformIcon(instance.platform)} size={20} color={theme.colors.textSecondary} />}
                title={instance.isThis ? t('devices.thisDevice', '{{name}} (this device)', { name: instance.displayName }) : instance.displayName}
                description={describeInstance(instance, t)}
                showChevron={false}
                rightElement={
                  instance.isThis || instance.status === 'revoked' ? undefined : (
                    <TouchableOpacity
                      onPress={() => { void revoke(instance); }}
                      disabled={busyId !== null}
                      accessibilityRole="button"
                      accessibilityLabel={t('devices.remove', 'Remove device')}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      {busyId === instance.id ? (
                        <ActivityIndicator color={theme.colors.error} />
                      ) : (
                        <Ionicons name="trash-outline" size={20} color={theme.colors.error} />
                      )}
                    </TouchableOpacity>
                  )
                }
              />
            ))
          )}
        </SettingsListGroup>
      </ScrollView>
    </ThemedView>
  );
}

function platformLabel(platform: InstanceView['platform']): string {
  switch (platform) {
    case 'ios':
      return 'iOS';
    case 'android':
      return 'Android';
    case 'web':
      return 'Web';
    case 'desktop':
      return 'Desktop';
    default:
      return platform;
  }
}

function platformIcon(platform: InstanceView['platform']): React.ComponentProps<typeof Ionicons>['name'] {
  switch (platform) {
    case 'ios':
    case 'android':
      return 'phone-portrait-outline';
    case 'web':
      return 'globe-outline';
    default:
      return 'desktop-outline';
  }
}

function describeInstance(instance: InstanceView, t: (key: string, fallback: string, options?: Record<string, unknown>) => string): string {
  const status =
    instance.status === 'active'
      ? t('devices.status.active', 'Active')
      : instance.status === 'pending'
        ? t('devices.status.pending', 'Waiting for approval')
        : t('devices.status.revoked', 'Removed');
  const seen = instance.lastSeenAt
    ? t('devices.lastSeen', 'last seen {{when}}', { when: formatWhen(instance.lastSeenAt) })
    : t('devices.neverSeen', 'never seen');
  return `${platformLabel(instance.platform)} · ${status} · ${seen}`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
