import { useCallback, useMemo } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useCallActions, usePresence } from '@allo/react';
import type { CallDirection } from '@oxy.so/bloom/call-ui';
import { AppShellMenuButton } from '@oxy.so/bloom/app-shell';
import { CallRingNotice } from '@/components/calls/CallRingNotice';
import { presenceDot } from '@/lib/presence';

import { useChatContext } from '@/hooks/useChatContext';
import { callHistorySections, useCallLog } from '@/lib/calls/history';
import { reportCallError, useCallSession } from '@/lib/calls/session';
import { Embed, Header, ScrollView, Text } from '@oxy.so/bloom-language';
import { IncomingCallBanner } from '@oxy.so/bloom-language/call-ui';
import { SectionedList } from '@oxy.so/bloom-language/list';
import { screen } from '@oxy.so/bloom-language/router';

/**
 * `/calls` — THE CALL LOG.
 *
 * Bloom's `List` in day sections, with the incoming banner above it
 * when a call is arriving. Every string the rows draw is decided in
 * `lib/calls/history.ts`; the list formats nothing. The minimised-call pill is
 * not drawn here — `app/(chat)/_layout.tsx` mounts one for the whole app.
 *
 * **Nothing here places a call, and calling back only NAVIGATES.**
 * `/c/:id/call` is the one dialler in the app; a screen that pushed the route
 * and also dialled placed two calls per press, which is the bug #172 was meant
 * to end and this row was the half of it that got missed.
 */
export default screen(function CallsScreen() {
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
      const names = ids
        .map((id) => person(id)?.displayName)
        .filter((name): name is string => Boolean(name));
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

  return ScrollView(
    Embed(<CallRingNotice />),
    arriving
      ? IncomingCallBanner(caller?.displayName ?? someone, {
          avatar: caller?.avatar,
          status: callerId ? presenceDot(callerPresence.of(callerId)) : undefined,
          onAccept: () => {
            void calls.answer().catch(reportCallError);
            router.push({
              pathname: '/c/[id]/call',
              params: { id: session.conversationId, incomingCallId: session.id },
            });
          },
          onDecline: () => void calls.decline().catch(reportCallError),
          labels: {
            accept: t('calls.control.accept'),
            decline: t('calls.control.decline'),
            voice: t('calls.incoming.voice'),
            video: t('calls.incoming.video'),
          },
        })
          .style(session.mode)
          .onPress(() =>
            router.push({
              pathname: '/c/[id]/call',
              params: { id: session.conversationId, incomingCallId: session.id },
            }),
          )
      : null,
    SectionedList(
      sections.map((section) => ({
        id: section.id,
        title: section.title,
        items: section.items.map((entry) => ({
          id: entry.id,
          call: {
            ...entry,
            onCallBack: () => callBack(entry.id),
            labels: {
              ...directionLabels,
              callBack: (name: string) => t('calls.callBack', { name }),
            },
          },
          onPress: () => openConversation(entry.id),
        })),
      })),
    )
      .testID('call-history')
      .emptyState(
        Text(t('calls.empty')).textStyle('muted').padding('vertical', '2xl').textAlign('center'),
      ),
  )
    .keyboardTaps('handled')
    .contentView((v) => v.padding('horizontal', 'lg').padding('bottom', '3xl').spacing('lg'))
    .screenScroll('content')
    .header(
      Header(t('calls.title'))
        .toolbarLeading(Embed(<AppShellMenuButton accessibilityLabel={t('navigation.open')} />))
        .inPage(),
    );
});
