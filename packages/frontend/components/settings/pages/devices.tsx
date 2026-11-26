import {
  useOwnInstances,
  usePendingEnrollments,
  type InstanceView,
  type PendingEnrollmentView,
} from '@allo/react';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text as BloomText } from '@oxy.so/bloom/typography';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Platform, StyleSheet } from 'react-native';

import { getErrorMessage } from '@/utils/errors';
import { formatWhen } from '@/utils/formatWhen';
import { logger } from '@/utils/logger';
import { confirm } from '@oxy.so/bloom/surfaces';

import {
  Button,
  Embed,
  Group,
  HStack,
  Icon,
  Text,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom-language/containers';
import { SettingsSection } from '@oxy.so/bloom-language/settings';

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: Once on mount: the lists then follow the SDK's `instances` topic.
  useEffect(() => {
    void refreshAll();
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
      const confirmed = await confirm({
        title: t('devices.reject'),
        description: t('devices.rejectConfirm'),
        confirmLabel: t('devices.reject'),
        cancelLabel: t('common.cancel'),
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
      const confirmed = await confirm({
        title: t('devices.remove'),
        description: t('devices.removeConfirm', { name: instance.displayName }),
        confirmLabel: t('devices.remove'),
        cancelLabel: t('common.cancel'),
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
    () =>
      [...own.instances].sort(
        (a, b) => Number(b.isThis) - Number(a.isThis) || a.displayName.localeCompare(b.displayName),
      ),
    [own.instances],
  );

  return toElement(
    Group(
      pending.pending.length > 0
        ? SettingsSection(
            t('devices.waiting'),
            GroupedSection(
              ...pending.pending.map((enrollment) => {
                const busy = busyId === enrollment.instance.id;
                return VStack(
                  Text(enrollment.instance.displayName)
                    .weight('semibold')
                    .font('16')
                    .foreground('foreground'),
                  Text(
                    `${platformLabel(enrollment.instance.platform)} · ${t('devices.requestedAt', { when: formatWhen(enrollment.instance.createdAt) })}`,
                  ).textStyle('muted'),
                  Text(t('devices.compareCode')).textStyle('muted'),
                  Embed(
                    <BloomText
                      style={[
                        styles.fingerprint,
                        {
                          color: theme.colors.text,
                          backgroundColor: theme.colors.backgroundSecondary,
                        },
                      ]}
                      accessibilityLabel={t('enrollment.fingerprint')}
                      selectable
                    >
                      {enrollment.fingerprint}
                    </BloomText>,
                  ),
                  HStack(
                    Button(Text(t('devices.reject')))
                      .disabled(busyId !== null)
                      .onPress(() => void reject(enrollment))
                      .tint('neutral')
                      .style('outline')
                      .grow(),
                    Button(Text(t('devices.approve')))
                      .loading(busy)
                      .disabled(busyId !== null && !busy)
                      .onPress(() => void approve(enrollment))
                      .tint('accent')
                      .style('solid')
                      .grow(),
                  ).spacing('md'),
                )
                  .padding('all', 'lg')
                  .spacing('6')
                  .id(enrollment.instance.id);
              }),
            ),
          )
        : null,
      SettingsSection(
        t('devices.enrolled'),
        GroupedSection(
          !loaded && enrolled.length === 0
            ? VStack(Embed(<ActivityIndicator color={theme.colors.primary} />))
                .padding('vertical', '2xl')
                .align('center')
            : enrolled.length === 0
              ? VStack(Text(t('devices.none')).textStyle('muted'))
                  .padding('vertical', '2xl')
                  .align('center')
              : // A row keeps its device as its key (a GroupedSectionItem takes no `.id()`).
                Embed(
                  enrolled.map((instance) => {
                    const removable = !instance.isThis && instance.status !== 'revoked';
                    const row = GroupedSectionItem(
                      instance.isThis
                        ? t('devices.thisDevice', { name: instance.displayName })
                        : instance.displayName,
                    )
                      .lines(0)
                      .descriptionLines(0)
                      .wrapControl()
                      .description(describeInstance(instance, t));
                    return toElement(
                      removable
                        ? row.trailing(
                            busyId === instance.id
                              ? Embed(<ActivityIndicator color={theme.colors.error} />)
                              : Button(Icon(RiDeleteBinLine))
                                  .label(t('devices.remove'))
                                  .shape('circle')
                                  .style('plain')
                                  .tint('danger')
                                  .disabled(busyId !== null)
                                  .onPress(() => void revoke(instance)),
                          )
                        : row,
                      instance.id,
                    );
                  }),
                ),
        ),
      ).trailing(
        Button(Icon(RiRefreshLine))
          .label(t('devices.refresh'))
          .shape('circle')
          .style('plain')
          .onPress(() => void refreshAll()),
      ),
    ),
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

function describeInstance(instance: InstanceView, t: Translate): string {
  const status =
    instance.status === 'active'
      ? t('devices.status.active')
      : instance.status === 'pending'
        ? t('devices.status.pending')
        : t('devices.status.revoked');
  // This device is the one being looked at: it is here now, not "last seen".
  const seen = instance.isThis
    ? t('devices.hereNow')
    : instance.lastSeenAt
      ? t('devices.lastSeen', { when: formatWhen(instance.lastSeenAt) })
      : t('devices.neverSeen');
  return `${platformLabel(instance.platform)} · ${status} · ${seen}`;
}

const styles = StyleSheet.create({
  fingerprint: {
    marginVertical: 6,
    paddingVertical: 12,
    borderRadius: 12,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
    textAlign: 'center',
    overflow: 'hidden',
  },
});
