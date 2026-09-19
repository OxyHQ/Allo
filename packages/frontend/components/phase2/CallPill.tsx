import React from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { CallMinimisedPill } from '@oxy.so/bloom/call-ui';

import { usePerson } from '@/hooks/usePerson';
import { useCallActions } from '@allo/react';
import { useCallDuration, useCallSession, useCallUi } from '@/lib/calls/session';

/**
 * THE MINIMISED CALL, FLOATING OVER WHATEVER SCREEN YOU WENT TO.
 *
 * Bloom's `CallMinimisedPill` deliberately does not place itself: it knows
 * nothing about the safe areas, the keyboard or the tab bar, so the offsets are
 * this app's to decide and arrive through `style`.
 *
 * It renders nothing unless there is a live call that has been minimised, which
 * is what makes it safe to mount once in `app/(chat)/_layout.tsx` — a minimised
 * call then survives walking around the app.
 */
export function CallPill() {
  const router = useRouter();
  const { t } = useTranslation();
  const session = useCallSession();
  const setMinimised = useCallUi((state) => state.setMinimised);
  const calls = useCallActions();
  const duration = useCallDuration(session);
  const peer = usePerson(session?.peers[0]?.accountId);

  if (!session || !session.minimised) return null;

  const others = session.peers.length - 1;
  const who = peer?.displayName ?? t('calls.someone');
  const name = others > 0 ? t('calls.withOthers', { name: who, count: others }) : who;

  return (
    <CallMinimisedPill
      name={name}
      mode={session.mode}
      duration={duration === '' ? undefined : duration}
      statusText={duration === '' ? t('calls.status.connecting') : undefined}
      muted={session.muted}
      onMutedChange={(muted) => void calls.setMuted(muted).catch(() => undefined)}
      onExpand={() => {
        setMinimised(false);
        router.push(`/c/${session.conversationId}/call`);
      }}
      onEndCall={() => void calls.end().catch(() => undefined)}
      labels={{
        mute: t('calls.control.mute'),
        unmute: t('calls.control.unmute'),
        endCall: t('calls.control.end'),
        expand: t('calls.expand'),
      }}
      style={styles.floating}
    />
  );
}

const styles = StyleSheet.create({
  floating: { position: 'absolute', left: 16, right: 16, bottom: 24 },
});
