import { useMessagingSupervision } from '@/lib/allo/MessagingSupervision';
import { ConversationAccessState } from '@/lib/allo/ConversationAccessState';
import { toast } from '@oxy.so/bloom/toast';
import { usePreventRemove } from 'expo-router';
import { useCallback, useState } from 'react';
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
  return useMessagingSupervision() ? (
    <ConversationAccessState state="unsupported" />
  ) : (
    <OrdinaryBackupScreen />
  );
}

function OrdinaryBackupScreen() {
  const { t } = useTranslation();
  // State, not a ref: the router's removal prevention is switched by a value
  // it is rendered with (expo-router 58 has no `beforeRemove` event).
  const [phrasePending, setPhrasePendingHere] = useState(false);
  const { setPhrasePending } = useAlloSettings();
  const onPhrasePending = useCallback(
    (pending: boolean) => {
      setPhrasePendingHere(pending);
      setPhrasePending(pending);
    },
    [setPhrasePending],
  );

  usePreventRemove(phrasePending, () => {
    toast.error(t('backup.phrase.mustConfirm'));
  });

  return (
    <>
      <BackupPanel onPhrasePending={onPhrasePending} />
    </>
  );
}
