/**
 * "RESTORE YOUR HISTORY?" — asked once, at first run, of a device that has
 * nothing and whose account has a backup.
 *
 * The conditions, all of them from the SDK:
 *
 *  - the instance is `active` (a pending device has no store to restore into,
 *    and a revoked one has its own screen);
 *  - the server holds a backup for the account, which is only known after
 *    `refreshStatus()` has asked — asked once per client here, and the answer
 *    lands in `status.remote`;
 *  - the backup is not already enabled on THIS device (a device that keeps the
 *    backup has nothing to restore);
 *  - no conversation on this device has any decrypted history yet. A fresh
 *    device already lists the account's conversation rows — `joined: false`,
 *    empty timelines — so the test is on the timelines, never on the list;
 *  - this instance has not answered the prompt before (`restorePromptStore`).
 *
 * It renders as a card over the bottom of the app, not a modal: the app is
 * usable behind it, and it never holds boot. "Restore" goes to the backup
 * screen, whose restore section is the same one this is a shortcut to; "Not
 * now" is remembered for this instance. Either way it is not shown again.
 *
 * Boot-mounted, so nothing here may suspend: `useTranslation` runs with
 * suspense off and every string has an inline default.
 */
import { useAlloClient, useBackup, useConversations, useInstanceState } from '@allo/react';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useRestorePromptStore } from '@/stores/restorePromptStore';
import { logger } from '@/utils/logger';

import {
  Button as LButton,
  Card as LCard,
  HStack,
  IconCircle as LIconCircle,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

export function RestoreHistoryPrompt() {
  const client = useAlloClient();
  const { state } = useInstanceState();
  const { status, refreshStatus } = useBackup();
  const conversations = useConversations();
  const instanceId = state === 'active' ? client.instanceId : null;
  const answered = useRestorePromptStore((store) =>
    instanceId ? store.answeredInstanceIds[instanceId] === true : true,
  );
  const markAnswered = useRestorePromptStore((store) => store.markAnswered);
  // Which instance the server has been asked about, so it is asked once per client.
  const askedFor = useRef<string | null>(null);

  useEffect(() => {
    if (instanceId === null || answered || askedFor.current === instanceId) return;
    askedFor.current = instanceId;
    refreshStatus().catch((error: unknown) => {
      logger.warn('[allo] the server could not be asked whether a backup exists', error);
    });
  }, [answered, instanceId, refreshStatus]);

  const hasHistory = useMemo(
    () =>
      conversations.some((conversation) => client.messages.timeline(conversation.id).length > 0),
    [client, conversations],
  );

  const visible =
    instanceId !== null &&
    !answered &&
    status.remote?.exists === true &&
    !status.enabled &&
    !hasHistory;

  const answer = useCallback(
    (restore: boolean) => {
      if (instanceId !== null) markAnswered(instanceId);
      if (restore) router.push('/settings/backup');
    },
    [instanceId, markAnswered],
  );

  if (!visible) return null;
  return <RestoreHistoryCard onRestore={() => answer(true)} onNotNow={() => answer(false)} />;
}

interface RestoreHistoryCardProps {
  onRestore: () => void;
  onNotNow: () => void;
}

export function RestoreHistoryCard({ onRestore, onNotNow }: RestoreHistoryCardProps) {
  const { t } = useTranslation(undefined, { useSuspense: false });
  return toElement(
    VStack(
      VStack(
        LCard(
          HStack(
            LIconCircle(RiHistoryLine).size('lg'),
            VStack(
              LText(t('restorePrompt.title', 'Restore your history?'))
                .font('headline')
                .weight('semibold'),
              LText(
                t(
                  'restorePrompt.body',
                  'This account has an encrypted backup. Enter your recovery phrase to bring your conversations to this device.',
                ),
              )
                .foreground('muted')
                .font('body'),
            )
              .spacing('xs')
              .grow(),
          )
            .spacing('md')
            .align('start'),
          HStack(
            LButton(LText(t('restorePrompt.notNow', 'Not now')))
              .onPress(onNotNow)
              .testID('restore-prompt-not-now')
              .tint('neutral')
              .style('outline'),
            LButton(LText(t('restorePrompt.restore', 'Restore')))
              .onPress(onRestore)
              .testID('restore-prompt-restore'),
          )
            .justify('end')
            .spacing('sm'),
        )
          .elevation('m')
          .radius('xl')
          .style('solid')
          .padding('all', 'lg')
          .spacing('lg'),
      )
        .frame({ width: 'full', maxWidth: '480' })
        .role('alert')
        .testID('restore-prompt'),
    )
      .padding('top', 'lg')
      .padding('left', 'lg')
      .padding('right', 'lg')
      .padding('bottom', '96')
      .align('center')
      .position({ left: 'none', right: 'none', bottom: 'none' })
      .allowsHitTesting('children'),
  );
}
