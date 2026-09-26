import { toast } from '@oxy.so/bloom/toast';
import { useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { BackupPanel } from '@/components/backup/BackupPanel';
import { useAlloSettings } from '../context';

/**
 * SETTINGS → BACKUP AND RECOVERY.
 *
 * The panel does the work; this route adds the one thing a panel cannot do for
 * itself: while the recovery phrase is on screen and not yet confirmed as
 * written down, leaving is refused — back button, hardware back and swipe alike
 * — because the phrase is shown once and an accidental dismissal would be the
 * last anyone saw of it.
 */
export default function BackupScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  // A ref, not state: nothing re-renders on it; only the listener reads it.
  const pendingRef = useRef(false);
  const { setPhrasePending } = useAlloSettings();
  const onPhrasePending = useCallback(
    (pending: boolean) => {
      pendingRef.current = pending;
      setPhrasePending(pending);
    },
    [setPhrasePending],
  );

  useEffect(() => {
    return navigation.addListener('beforeRemove', (event) => {
      if (!pendingRef.current) return;
      event.preventDefault();
      toast.error(t('backup.phrase.mustConfirm'));
    });
  }, [navigation, t]);

  return (
    <>
      <BackupPanel onPhrasePending={onPhrasePending} />
    </>
  );
}
