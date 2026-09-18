import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useOwnInstances, usePendingEnrollments, type InstanceView, type PendingEnrollmentView } from '@allo/react';
import { Button, GlyphButton } from '@oxy.so/bloom/button';
import {
  RiComputerLine,
  RiDeleteBinLine,
  RiGlobalLine,
  RiRefreshLine,
  RiSmartphoneLine,
  type BloomIconComponent,
} from '@oxy.so/bloom/icons';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';

import { Page } from '@/components/shell/Page';
import { confirmDialog } from '@/utils/alerts';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

type Translate = ReturnType<typeof useTranslation>['t'];

/**
 * THE ACCOUNT'S DEVICES.
 *
 * The devices waiting to be approved come first, because approving one is what
 * a person opens this screen to do: each shows its name, platform and the
 * verification code the device itself is showing, and approving passes the
 * challenge back to the SDK so a swapped one is refused before anything is
 * signed. Below, every enrolled device with its status and when it was last
 * seen, and a way to remove any that is not this one — removing THIS device is
 * signing out, which lives where signing out lives.
 */
export default function DevicesScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const own = useOwnInstances();
  const pending = usePendingEnrollments();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([own.refresh(), pending.refresh()]);
    } catch (error: unknown) {
      logger.error('[Devices] refresh failed:', error);
      toast.error(getErrorMessage(error) || t('devices.refreshFailed'));
    } finally {
      setLoaded(true);
    }
  }, [own, pending, t]);

  useEffect(() => {
    void refreshAll();
    // Once on mount: the lists then follow the SDK's `instances` topic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(
    async (id: string, action: () => Promise<void>, failure: string) => {
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
    },
    [busyId],
  );

  const approve = useCallback(
    (enrollment: PendingEnrollmentView) =>
      run(
        enrollment.instance.id,
        async () => {
          await pending.approve(enrollment.instance.id, enrollment.challenge);
          toast.success(t('devices.approved'));
        },
        t('devices.approveFailed'),
      ),
    [pending, run, t],
  );

  const reject = useCallback(
    async (enrollment: PendingEnrollmentView) => {
      const confirmed = await confirmDialog({
        title: t('devices.reject'),
        message: t('devices.rejectConfirm'),
        okText: t('devices.reject'),
        cancelText: t('common.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      await run(
        enrollment.instance.id,
        async () => {
          await pending.reject(enrollment.instance.id);
          toast.success(t('devices.rejected'));
        },
        t('devices.rejectFailed'),
      );
    },
    [pending, run, t],
  );

  const revoke = useCallback(
    async (instance: InstanceView) => {
      const confirmed = await confirmDialog({
        title: t('devices.remove'),
        message: t('devices.removeConfirm', { name: instance.displayName }),
        okText: t('devices.remove'),
        cancelText: t('common.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      await run(
        instance.id,
        async () => {
          await own.revoke(instance.id);
          toast.success(t('devices.removed'));
        },
        t('devices.removeFailed'),
      );
    },
    [own, run, t],
  );

  const enrolled = useMemo(
    () => [...own.instances].sort((a, b) => Number(b.isThis) - Number(a.isThis) || a.displayName.localeCompare(b.displayName)),
    [own.instances],
  );

  return (
    <Page
      title={t('devices.title')}
      actions={
        <Button
          variant="secondary"
          iconOnly
          leadingIcon={RiRefreshLine}
          accessibilityLabel={t('devices.refresh')}
          onPress={() => void refreshAll()}
        />
      }
    >
      {pending.pending.length > 0 ? (
        <SettingsListGroup title={t('devices.waiting')}>
          {pending.pending.map((enrollment) => {
            const busy = busyId === enrollment.instance.id;
            return (
              <View key={enrollment.instance.id} style={styles.pending}>
                <Text style={[styles.pendingTitle, { color: theme.colors.text }]}>{enrollment.instance.displayName}</Text>
                <Muted>
                  {`${platformLabel(enrollment.instance.platform)} · ${t('devices.requestedAt', { when: formatWhen(enrollment.instance.createdAt) })}`}
                </Muted>
                <Muted>{t('devices.compareCode')}</Muted>
                <Text
                  style={[styles.fingerprint, { color: theme.colors.text, backgroundColor: theme.colors.backgroundSecondary }]}
                  accessibilityLabel={t('enrollment.fingerprint')}
                  selectable
                >
                  {enrollment.fingerprint}
                </Text>
                <View style={styles.actions}>
                  <Button variant="secondary" style={styles.action} disabled={busyId !== null} onPress={() => void reject(enrollment)}>
                    {t('devices.reject')}
                  </Button>
                  <Button
                    variant="primary"
                    style={styles.action}
                    loading={busy}
                    disabled={busyId !== null && !busy}
                    onPress={() => void approve(enrollment)}
                  >
                    {t('devices.approve')}
                  </Button>
                </View>
              </View>
            );
          })}
        </SettingsListGroup>
      ) : null}

      <SettingsListGroup title={t('devices.enrolled')}>
        {!loaded && enrolled.length === 0 ? (
          <View style={styles.empty}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : enrolled.length === 0 ? (
          <View style={styles.empty}>
            <Muted>{t('devices.none')}</Muted>
          </View>
        ) : (
          enrolled.map((instance) => {
            const Icon = platformIcon(instance.platform);
            const removable = !instance.isThis && instance.status !== 'revoked';
            return (
              <SettingsListItem
                key={instance.id}
                icon={<Icon width={20} height={20} fill={theme.colors.textSecondary} />}
                title={instance.isThis ? t('devices.thisDevice', { name: instance.displayName }) : instance.displayName}
                description={describeInstance(instance, t)}
                showChevron={false}
                rightElement={
                  !removable ? undefined : busyId === instance.id ? (
                    <ActivityIndicator color={theme.colors.error} />
                  ) : (
                    <GlyphButton
                      icon={RiDeleteBinLine}
                      color={theme.colors.error}
                      disabled={busyId !== null}
                      accessibilityLabel={t('devices.remove')}
                      onPress={() => void revoke(instance)}
                    />
                  )
                }
              />
            );
          })
        )}
      </SettingsListGroup>
    </Page>
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

function platformIcon(platform: InstanceView['platform']): BloomIconComponent {
  switch (platform) {
    case 'ios':
    case 'android':
      return RiSmartphoneLine;
    case 'web':
      return RiGlobalLine;
    default:
      return RiComputerLine;
  }
}

function describeInstance(instance: InstanceView, t: Translate): string {
  const status =
    instance.status === 'active'
      ? t('devices.status.active')
      : instance.status === 'pending'
        ? t('devices.status.pending')
        : t('devices.status.revoked');
  const seen = instance.lastSeenAt ? t('devices.lastSeen', { when: formatWhen(instance.lastSeenAt) }) : t('devices.neverSeen');
  return `${platformLabel(instance.platform)} · ${status} · ${seen}`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const styles = StyleSheet.create({
  pending: { padding: 16, gap: 6 },
  pendingTitle: { fontSize: 16, fontWeight: '600' },
  fingerprint: {
    marginVertical: 6,
    paddingVertical: 12,
    borderRadius: 12,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    textAlign: 'center',
    overflow: 'hidden',
  },
  actions: { flexDirection: 'row', gap: 12 },
  action: { flex: 1 },
  empty: { paddingVertical: 24, alignItems: 'center' },
});
