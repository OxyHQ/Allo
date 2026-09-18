import React, { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { CallHistoryList, IncomingCallBanner, type CallDirection } from '@oxy.so/bloom/call-ui';
import { RiPhoneLine } from '@oxy.so/bloom/icons';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted } from '@oxy.so/bloom/typography';

import { NotConnectedNotice } from '@/components/phase2/NotConnectedNotice';
import { Page } from '@/components/shell/Page';
import { useChatContext } from '@/hooks/useChatContext';
import { callHistorySections, useCallLog, useCallSession, useCallsStore } from '@/lib/phase2/calls';
import { usePresence } from '@/lib/phase2/presence';

/**
 * `/calls` — THE CALL LOG.
 *
 * Bloom's `CallHistoryList` in day sections, with the incoming banner above it
 * when a call is arriving. Every string the rows draw is decided in
 * `lib/phase2/calls.ts`; the list formats nothing. The minimised-call pill is
 * not drawn here — `app/(chat)/_layout.tsx` mounts one for the whole app.
 *
 * **Nothing here places a call.** The log is sample data held in this tab and
 * the call-back button opens the local call screen, which has no media behind
 * it — the notice at the top says so, because a log that looks like a log and a
 * button that looks like a button otherwise promise a telephone.
 */
export default function CallsScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const theme = useTheme();
  const log = useCallLog();
  const session = useCallSession();
  const place = useCallsStore((state) => state.place);
  const receive = useCallsStore((state) => state.receive);
  const decline = useCallsStore((state) => state.decline);
  const answer = useCallsStore((state) => state.answer);

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

  const callBack = useCallback(
    (id: string) => {
      const entry = entryById.get(id);
      if (!entry) return;
      place({
        conversationId: entry.conversationId,
        peerAccountIds: entry.peerAccountIds,
        mode: entry.mode,
      });
      router.push(`/c/${entry.conversationId}/call`);
    },
    [entryById, place, router],
  );

  const openConversation = useCallback(
    (id: string) => {
      const entry = entryById.get(id);
      if (entry) router.push(`/c/${entry.conversationId}`);
    },
    [entryById, router],
  );

  /**
   * The only way to see the incoming screens without a server that rings.
   * Named for what it is: it puts THIS device into the "somebody is calling"
   * state, and nobody is called.
   */
  const previewIncoming = useCallback(() => {
    const caller = log[0]?.peerAccountIds[0];
    if (!caller) return;
    receive({ conversationId: caller, peerAccountIds: [caller], mode: 'voice' });
  }, [log, receive]);

  const arriving = session !== null && session.incoming && session.status === 'ringing';
  const callerId = session?.peers[0]?.accountId;
  const caller = person(callerId ?? '');
  const callerPresence = usePresence(callerId);

  return (
    <Page title={t('calls.title')}>
      <NotConnectedNotice>{t('calls.notice')}</NotConnectedNotice>

      {arriving ? (
        <IncomingCallBanner
          name={caller?.displayName ?? someone}
          avatar={caller?.avatar}
          mode={session.mode}
          status={callerPresence.status}
          onAccept={() => {
            answer();
            router.push(`/c/${session.conversationId}/call`);
          }}
          onDecline={decline}
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

      <View style={[styles.preview, { borderTopColor: theme.colors.border }]}>
        <Muted>{t('calls.preview.help')}</Muted>
        <Button variant="secondary" icon={RiPhoneLine} onPress={previewIncoming} disabled={session !== null}>
          {t('calls.preview.incoming')}
        </Button>
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 24, textAlign: 'center' },
  preview: { gap: 12, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth },
});
