import React, { useCallback, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useCallActions, usePresence } from '@allo/react';
import { CallHistoryList, IncomingCallBanner, type CallDirection } from '@oxy.so/bloom/call-ui';
import { Muted } from '@oxy.so/bloom/typography';

import { NotConnectedNotice } from '@/components/phase2/NotConnectedNotice';
import { Page } from '@/components/shell/Page';
import { presenceDot } from '@/lib/presence';
import { useChatContext } from '@/hooks/useChatContext';
import { callHistorySections, useCallLog } from '@/lib/calls/history';
import { reportCallError, useCallSession } from '@/lib/calls/session';

/**
 * `/calls` — THE CALL LOG.
 *
 * Bloom's `CallHistoryList` in day sections, with the incoming banner above it
 * when a call is arriving. Every string the rows draw is decided in
 * `lib/calls/history.ts`; the list formats nothing. The minimised-call pill is
 * not drawn here — `app/(chat)/_layout.tsx` mounts one for the whole app.
 *
 * **Nothing here places a call, and calling back only NAVIGATES.**
 * `/c/:id/call` is the one dialler in the app; a screen that pushed the route
 * and also dialled placed two calls per press, which is the bug #172 was meant
 * to end and this row was the half of it that got missed.
 */
export default function CallsScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const log = useCallLog();
  const session = useCallSession();
  const calls = useCallActions();

  const accountIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of log) for (const id of entry.peerAccountIds) ids.add(id);
    for (const peer of session?.peers ?? []) ids.add(peer.accountId);
    return [...ids];
  }, [log, session]);
  const { person, now } = useChatContext(accountIds);

  const someone = t('calls.someone');
  const nameFor = useCallback(
    (ids: readonly string[]) => {
      const names = ids.map((id) => person(id)?.displayName).filter((name): name is string => Boolean(name));
      if (names.length === 0) return someone;
      if (names.length === 1) return names[0];
      return t('calls.withOthers', { name: names[0], count: names.length - 1 });
    },
    [person, someone, t],
  );
  const avatarFor = useCallback(
    (ids: readonly string[]) => (ids.length === 1 ? person(ids[0])?.avatar : undefined),
    [person],
  );

  const sections = useMemo(
    () => callHistorySections(log, { now, locale: i18n.language, t, nameFor, avatarFor }),
    [avatarFor, i18n.language, log, nameFor, now, t],
  );

  const directionLabels = useMemo<Record<CallDirection, string>>(
    () => ({
      incoming: t('calls.direction.incoming'),
      outgoing: t('calls.direction.outgoing'),
      missed: t('calls.direction.missed'),
      declined: t('calls.direction.declined'),
    }),
    [t],
  );

  const entryById = useMemo(() => new Map(log.map((entry) => [entry.id, entry])), [log]);

  // The mode rides in the URL, so re-opening the screen dials the kind of call
  // the row was rather than falling back to voice.
  const callBack = useCallback(
    (id: string) => {
      const entry = entryById.get(id);
      if (entry) router.push(`/c/${entry.conversationId}/call?mode=${entry.mode}`);
    },
    [entryById, router],
  );

  const openConversation = useCallback(
    (id: string) => {
      const entry = entryById.get(id);
      if (entry) router.push(`/c/${entry.conversationId}`);
    },
    [entryById, router],
  );

  const arriving = session !== null && session.incoming && session.status === 'ringing';
  const callerId = session?.peers[0]?.accountId;
  const caller = person(callerId ?? '');
  const callerPresence = usePresence(callerId ? [callerId] : []);

  return (
    <Page title={t('calls.title')}>
      <NotConnectedNotice>{t('calls.notice')}</NotConnectedNotice>

      {arriving ? (
        <IncomingCallBanner
          name={caller?.displayName ?? someone}
          avatar={caller?.avatar}
          mode={session.mode}
          status={callerId ? presenceDot(callerPresence.of(callerId)) : undefined}
          onAccept={() => {
            void calls.answer().catch(reportCallError);
            router.push(`/c/${session.conversationId}/call`);
          }}
          onDecline={() => void calls.decline().catch(reportCallError)}
          onPress={() => router.push(`/c/${session.conversationId}/call`)}
          labels={{
            accept: t('calls.control.accept'),
            decline: t('calls.control.decline'),
            voice: t('calls.incoming.voice'),
            video: t('calls.incoming.video'),
          }}
        />
      ) : null}

      <CallHistoryList
        sections={sections}
        onItemPress={openConversation}
        onCallBack={callBack}
        labels={{
          ...directionLabels,
          callBack: (name: string) => t('calls.callBack', { name }),
        }}
        emptyState={<Muted style={styles.empty}>{t('calls.empty')}</Muted>}
      />

    </Page>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 24, textAlign: 'center' },
});
