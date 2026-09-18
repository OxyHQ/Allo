import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useHistoryTransfer, useOwnInstances } from '@allo/react';

import { useTheme } from '@/hooks/useTheme';

/**
 * "Receiving history from <device>" — drawn above the conversation list while
 * this device is taking part in a history transfer, and nothing while it is not.
 *
 * The SDK's `history` topic says what is happening (`progress.phase`) and with
 * whom: `fromInstanceId` names the donor while receiving, `toInstanceId` the
 * recipient while sending. Either is resolved to a device name through the
 * account's instance list, which the SDK keeps; a device the list does not
 * know is named generically rather than by id. `done`/`total` are chunks while
 * uploading or downloading and events while importing, and are only shown once
 * `total` is known.
 */
export function HistoryTransferBanner() {
  const { progress } = useHistoryTransfer();
  const { instances } = useOwnInstances();
  const { t } = useTranslation();
  const styles = useStyles();

  const text = useMemo(() => {
    if (progress.phase === 'idle') return null;
    const receiving = progress.phase === 'downloading' || progress.phase === 'importing';
    const otherId = receiving ? progress.fromInstanceId : progress.toInstanceId;
    const name = otherId ? instances.find((instance) => instance.id === otherId)?.displayName : undefined;
    const label = receiving
      ? name
        ? t('transfer.receivingFrom', 'Receiving history from {{name}}', { name })
        : t('transfer.receiving', 'Receiving history from another device')
      : name
        ? t('transfer.sendingTo', 'Sending history to {{name}}', { name })
        : t('transfer.sending', 'Sending history to another device');
    if (progress.total > 0) {
      return `${label} · ${t('transfer.progress', '{{done}} of {{total}}', { done: progress.done, total: progress.total })}`;
    }
    return label;
  }, [instances, progress, t]);

  if (text === null) return null;
  return (
    <View style={styles.banner} accessibilityRole="progressbar" accessibilityLiveRegion="polite" testID="history-transfer-banner">
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

function useStyles() {
  const theme = useTheme();
  return useMemo(
    () =>
      StyleSheet.create({
        banner: {
          paddingHorizontal: 16,
          paddingVertical: 6,
          backgroundColor: theme.colors.backgroundSecondary,
        },
        text: {
          fontSize: 12,
          color: theme.colors.textSecondary,
          textAlign: 'center',
        },
      }),
    [theme],
  );
}
