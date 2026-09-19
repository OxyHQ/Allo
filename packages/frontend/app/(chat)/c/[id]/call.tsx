import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { useCallActions, useConversation } from '@allo/react';
import { Button } from '@oxy.so/bloom/button';
import {
  CallControlButton,
  CallScreen,
  GroupCallGrid,
  IncomingCallScreen,
  type GroupCallParticipant,
} from '@oxy.so/bloom/call-ui';
import { RiPauseLine } from '@oxy.so/bloom/icons';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted } from '@oxy.so/bloom/typography';

import { NotConnectedNotice } from '@/components/phase2/NotConnectedNotice';
import { StagePlaceholder } from '@/components/phase2/StagePlaceholder';
import { Page } from '@/components/shell/Page';
import { useChatContext } from '@/hooks/useChatContext';
import { logger } from '@/utils/logger';
import { useCallDuration, useCallSession, useCallUi } from '@/lib/calls/session';

/**
 * `/c/:id/call` — THE CALL ITSELF.
 *
 * One Bloom surface per state: `IncomingCallScreen` while somebody is calling
 * this device, `CallScreen` otherwise, and `CallScreen minimised` — which IS
 * `CallMinimisedPill` — once it has been collapsed. A call with more than one
 * other person fills the stage with `GroupCallGrid`; a one-to-one video call
 * gets a placeholder frame, because `remoteVideo` is a `ReactNode` slot and
 * there is no media to put in it.
 *
 * **There is no WebRTC here, and no microphone is opened.** The progression
 * from `calling` to `active` is timers in this file standing in for a
 * signalling server that does not exist; every control writes to
 * `lib/phase2/calls.ts` and stops there. The screen says so in its own subtitle
 * rather than in a banner that would cover the stage.
 */
/** A call action that failed. Logged, never swallowed, and never a crash on a screen somebody is on. */
function reportCallError(error: unknown): void {
  logger.error('[call] action failed', error);
}

export default function CallRoute() {
  const { id, mode } = useLocalSearchParams<{ id: string; mode?: 'voice' | 'video' }>();
  const { t } = useTranslation();
  const router = useRouter();
  const theme = useTheme();
  const { user } = useOxy();
  const conversation = useConversation(id ?? '');
  const session = useCallSession();

  /**
   * The call itself is the SDK's; this screen only asks. What is NOT here is
   * as deliberate as what is: the speaker, screen sharing, the camera's facing
   * and hold are not things the platform can do yet, so their buttons do
   * nothing rather than pretending — see the notice the screen draws.
   */
  const calls = useCallActions();
  const answer = useCallback(() => void calls.answer().catch(reportCallError), [calls]);
  const decline = useCallback(() => void calls.decline().catch(reportCallError), [calls]);
  const end = useCallback(() => void calls.end().catch(reportCallError), [calls]);
  const setMuted = useCallback((muted: boolean) => void calls.setMuted(muted).catch(reportCallError), [calls]);
  const setVideo = useCallback((on: boolean) => void calls.setCameraEnabled(on).catch(reportCallError), [calls]);
  const setMinimised = useCallUi((state) => state.setMinimised);
  const movePip = useCallUi((state) => state.setPipCorner);
  const noop = useCallback((..._ignored: unknown[]) => undefined, []);
  const setSpeaker = noop;
  const setScreenSharing = noop;
  const flipCamera = noop;
  const setHold = noop;

  /**
   * Who is on the call. The live call knows; before one exists the members of
   * the conversation do, and a route whose id is an ACCOUNT (the same spelling
   * `/c/:id` accepts) is a call with that one person.
   */
  const peerAccountIds = useMemo(() => {
    if (session && session.conversationId === id) return session.peers.map((peer) => peer.accountId);
    if (conversation) return conversation.memberAccountIds.filter((member) => member !== user?.id);
    if (id && id !== user?.id) return [id];
    return [];
  }, [conversation, id, session, user?.id]);

  const { person } = useChatContext(peerAccountIds);

  /**
   * Placing the call this route is about, once.
   *
   * The ref is what stops it starting again the moment it is hung up: ending a
   * call clears the session, and without the guard this effect would read that
   * as "no call yet" and dial again.
   */
  /**
   * Opening `/c/:id/call` with no call in progress PLACES one — the screen is
   * reached by pressing call, and a screen that showed nothing would be a
   * button that did nothing.
   *
   * The ref is what stops it dialling again the moment it is hung up: ending a
   * call clears the session, and without the guard this would read that as "no
   * call yet".
   */
  const placed = useRef(false);
  useEffect(() => {
    if (session !== null || peerAccountIds.length === 0 || !id || placed.current) return;
    placed.current = true;
    void calls.start(id, mode === 'video' ? 'video' : 'voice').catch(reportCallError);
  }, [calls, id, mode, peerAccountIds, session]);

  const duration = useCallDuration(session);
  const someone = t('calls.someone');
  const names = peerAccountIds.map((accountId) => person(accountId)?.displayName ?? someone);
  const title =
    conversation?.title ??
    (names.length === 0
      ? someone
      : names.length === 1
        ? names[0]
        : t('calls.withOthers', { name: names[0], count: names.length - 1 }));
  const avatar = peerAccountIds.length === 1 ? person(peerAccountIds[0])?.avatar : undefined;

  const participants = useMemo<GroupCallParticipant[]>(
    () => [
      ...(session?.peers ?? []).map((peer) => ({
        id: peer.accountId,
        name: person(peer.accountId)?.displayName ?? someone,
        avatar: person(peer.accountId)?.avatar,
        muted: peer.muted,
        speaking: peer.speaking,
        presenting: peer.presenting,
      })),
      {
        id: user?.id ?? 'me',
        name: t('calls.you'),
        label: t('calls.you'),
        muted: session?.muted,
      },
    ],
    [person, session?.muted, session?.peers, someone, t, user?.id],
  );

  // No call, and nobody to call: an id that is this account, or a conversation
  // that has not loaded. Say so rather than drawing a call with nobody on it.
  if (!session && peerAccountIds.length === 0) {
    return (
      <Page title={t('calls.title')}>
        <NotConnectedNotice>{t('calls.notice')}</NotConnectedNotice>
        <Muted>{t('calls.noParticipants')}</Muted>
        <Button variant="secondary" onPress={() => router.push('/calls')}>
          {t('calls.title')}
        </Button>
      </Page>
    );
  }

  if (!session) {
    return (
      <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
        <Muted style={styles.centred}>{t('calls.starting')}</Muted>
      </View>
    );
  }

  const notConnected = t('calls.stageNotice');

  const hangUp = () => {
    end();
    router.replace('/calls');
  };

  if (session.incoming && session.status === 'ringing') {
    return (
      <IncomingCallScreen
        name={title}
        avatar={avatar}
        mode={session.mode}
        answerMode="slide"
        subtitle={notConnected}
        onAccept={answer}
        onDecline={() => {
          decline();
          router.replace('/calls');
        }}
        labels={{
          accept: t('calls.control.accept'),
          decline: t('calls.control.decline'),
          slideToAnswer: t('calls.slideToAnswer'),
          voice: t('calls.incoming.voice'),
          video: t('calls.incoming.video'),
        }}
      />
    );
  }

  const group = session.peers.length > 1;
  const stage = group ? (
    <GroupCallGrid
      participants={participants}
      // The grid measures its WIDTH and derives its height from the tile
      // aspect. Bloom's default square tile makes a 2×2 taller than the stage
      // on a desktop pane, and the bottom row disappears under the control
      // scrim; 16:9 is both the video shape and the one that fits.
      aspectRatio={16 / 9}
      formatOverflow={(count) => t('calls.more', { count })}
      formatMuted={(name) => t('calls.mutedPerson', { name })}
    />
  ) : (
    <StagePlaceholder label={notConnected} />
  );

  /**
   * `CallScreen` only fills the stage with `remoteVideo` in VIDEO mode — a
   * voice stage is one big avatar and ignores the slot. A group call is a grid
   * of people whether or not anybody's camera is on (the tiles draw avatars
   * when they have no frame), so the stage mode follows the LAYOUT rather than
   * the kind of call. The pill keeps the call's own mode, which is what picks
   * its glyph.
   */
  const stageMode = group ? 'video' : session.mode;

  return (
    <CallScreen
      mode={stageMode}
      name={title}
      subtitle={notConnected}
      avatar={avatar}
      status={session.status}
      duration={duration === '' ? undefined : duration}
      minimised={session.minimised}
      remoteVideo={stageMode === 'video' ? stage : undefined}
      localVideo={session.videoOn ? <StagePlaceholder compact label={t('calls.yourCamera')} /> : undefined}
      localVideoCorner={session.pipCorner}
      onMoveLocal={movePip}
      participantCount={group ? session.peers.length + 1 : undefined}
      onOpenParticipants={group ? () => router.push(`/c/${session.conversationId}/members`) : undefined}
      onOpenChat={() => router.push(`/c/${session.conversationId}`)}
      onMinimise={() => {
        setMinimised(!session.minimised);
        if (!session.minimised) router.push('/calls');
      }}
      controls={{
        muted: session.muted,
        onMutedChange: setMuted,
        speaker: session.speaker,
        onSpeakerChange: setSpeaker,
        videoOn: session.videoOn,
        onVideoChange: setVideo,
        onFlipCamera: session.videoOn ? flipCamera : undefined,
        screenSharing: session.screenSharing,
        onScreenShareChange: setScreenSharing,
        onAddParticipant: () => router.push(`/new?addTo=${session.conversationId}`),
        onEndCall: hangUp,
        showLabels: true,
        labels: {
          mute: t('calls.control.mute'),
          unmute: t('calls.control.unmute'),
          speakerOn: t('calls.control.speakerOn'),
          speakerOff: t('calls.control.speakerOff'),
          videoOn: t('calls.control.videoOn'),
          videoOff: t('calls.control.videoOff'),
          flipCamera: t('calls.control.flip'),
          screenShareOn: t('calls.control.shareOn'),
          screenShareOff: t('calls.control.shareOff'),
          addParticipant: t('calls.control.add'),
          endCall: t('calls.control.end'),
        },
        // `children` is where Bloom puts an extra control, between the toggles
        // and the end button. Hold is a state this app models and Bloom has no
        // key for, which is exactly what the slot is for.
        children: (
          <CallControlButton
            icon={RiPauseLine}
            label={session.status === 'onHold' ? t('calls.control.resume') : t('calls.control.hold')}
            active={session.status === 'onHold'}
            size="large"
            showLabel
            onPress={() => setHold(session.status !== 'onHold')}
          />
        ),
      }}
      labels={{
        minimise: t('calls.minimise'),
        chat: t('chat.title'),
        participants: t('calls.participants'),
        calling: t('calls.status.calling'),
        ringing: t('calls.status.ringing'),
        connecting: t('calls.status.connecting'),
        active: t('calls.status.active'),
        reconnecting: t('calls.status.reconnecting'),
        onHold: t('calls.status.onHold'),
        ended: t('calls.status.ended'),
        movePip: () => t('calls.movePip'),
      }}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centred: { textAlign: 'center' },
});
