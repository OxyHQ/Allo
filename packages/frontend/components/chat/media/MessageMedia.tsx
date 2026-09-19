import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import type { ContactCardView, MediaView, PlaceView, PollView, TimelineContent } from '@allo/core';
import {
  ContactMessage,
  FileMessage,
  GifMessage,
  ImageMessage,
  LocationMessage,
  PollMessage,
  VideoMessage,
  VoiceMessage,
  type MessageTone,
} from '@oxy.so/bloom/message-media';
import { toast } from '@oxy.so/bloom/toast';

import { useMediaUri } from '@/lib/allo/useMediaUri';
import { openPlace, placeLabel } from '@/lib/chat/place';
import { shareAttachment } from '@/lib/chat/shareAttachment';
import { logger } from '@/utils/logger';

/**
 * The content kinds that fill a bubble's media slot. Everything else is text
 * the bubble draws itself, and a screen asks this before building a node so a
 * plain message does not get an empty slot.
 */
const MEDIA_KINDS: ReadonlySet<TimelineContent['kind']> = new Set<TimelineContent['kind']>([
  'media',
  'poll',
  'location',
  'contact',
]);

/** Whether {@link MessageMedia} would draw anything for this message. */
export function hasMessageMedia(content: TimelineContent | undefined): boolean {
  return content !== undefined && MEDIA_KINDS.has(content.kind);
}

interface MessageMediaProps {
  /** The whole message body: an attachment, a poll, a place or a card. */
  content: TimelineContent;
  tone: MessageTone;
  /** Opens the full-screen viewer on this message. Pictures and videos only. */
  onOpen: () => void;
  /** Answers this poll. The screen binds the message id and calls the timeline's `vote`. */
  onVote?: (optionIds: string[]) => void;
  /**
   * Opens a conversation with the account a contact card names. Absent — or a
   * card that names no account — and the card offers no "Message": a button
   * that cannot lead anywhere is worse than no button.
   */
  onMessageAccount?: (accountId: string) => void;
}

interface MediaProps {
  media: MediaView;
  tone: MessageTone;
  onOpen: () => void;
}

/** What goes inside a bubble: an attachment decrypted on demand, or a poll, a place, a card. */
export const MessageMedia = memo(function MessageMedia({
  content,
  tone,
  onOpen,
  onVote,
  onMessageAccount,
}: MessageMediaProps) {
  switch (content.kind) {
    case 'media':
      return <Attachment media={content.media} tone={tone} onOpen={onOpen} />;
    case 'poll':
      return <Poll poll={content.poll} tone={tone} onVote={onVote} />;
    case 'location':
      return <Place place={content.place} tone={tone} />;
    case 'contact':
      return <Card contact={content.contact} tone={tone} onMessageAccount={onMessageAccount} />;
    default:
      return null;
  }
});

function Attachment({ media, tone, onOpen }: MediaProps) {
  switch (media.kind) {
    case 'image':
    case 'video':
      return <VisualMedia media={media} tone={tone} onOpen={onOpen} />;
    case 'voice':
    case 'audio':
      return <AudioMedia media={media} tone={tone} />;
    case 'file':
      return <FileMedia media={media} tone={tone} />;
  }
}

/**
 * A poll, with the votes the SDK already folded.
 *
 * Nothing is counted here: `PollView` arrives with a per-option total, whether
 * the viewer is in it, and whether they have answered at all. `voted` is what
 * flips Bloom from marks to bars, and it is the SDK's reading of the viewer's
 * own vote rather than anything this screen remembers — so a vote cast on
 * another device shows as voted here the moment it syncs.
 *
 * An ANONYMOUS poll still counts: the SDK folds the votes and withholds only
 * the names, so the bars are as true as any other poll's.
 */
function Poll({ poll, tone, onVote }: { poll: PollView; tone: MessageTone; onVote?: (ids: string[]) => void }) {
  const { t } = useTranslation();
  return (
    <PollMessage
      tone={tone}
      question={poll.question}
      options={poll.options.map((option) => ({
        id: option.id,
        label: option.label,
        votes: option.votes,
        selected: option.mine,
      }))}
      totalVotes={poll.totalVotes}
      multiple={poll.multiple}
      anonymous={poll.anonymous}
      voted={poll.voted}
      onVote={poll.voted ? undefined : onVote}
      voteLabel={t('poll.vote')}
      anonymousLabel={t('poll.anonymous')}
      hintLabel={poll.multiple ? t('poll.selectMany') : t('poll.selectOne')}
      formatVotes={(total) => t('poll.votes', { count: total })}
    />
  );
}

/**
 * A place.
 *
 * `renderMap` is deliberately NOT passed. Bloom's own frame — an abstract grid
 * with a pin on it — is the honest picture of a place this app cannot draw, and
 * it is painted from the bubble's own palette, so it is legible on both tones
 * in both modes. Anything Allo rendered in that slot would either be a fake
 * coastline or a tile request to a provider Allo has no key for.
 *
 * The address line falls back to the coordinates. "A place, somewhere" with no
 * numbers is not a location message.
 */
function Place({ place, tone }: { place: PlaceView; tone: MessageTone }) {
  const { t } = useTranslation();
  const open = useCallback(() => {
    openPlace(place)
      .then((opened) => {
        if (!opened) toast.error(t('place.openFailed'));
      })
      .catch((error: unknown) => logger.warn('[chat] a place could not be opened', error));
  }, [place, t]);

  return (
    <LocationMessage
      tone={tone}
      title={placeLabel(place)}
      address={place.address}
      accessibilityLabel={t('place.open', { place: placeLabel(place) })}
      onPress={open}
    />
  );
}

/**
 * A contact card.
 *
 * "Message" appears only when the card names an Oxy account: a card made from
 * the phone's address book carries a name and a number and nothing Allo could
 * open a conversation with. There is no "Add" — saving to the address book is a
 * write permission and a native form this app does not ask for, and an action
 * that does nothing is a lie in a button.
 */
function Card({
  contact,
  tone,
  onMessageAccount,
}: {
  contact: ContactCardView;
  tone: MessageTone;
  onMessageAccount?: (accountId: string) => void;
}) {
  const { t } = useTranslation();
  const accountId = contact.accountId;
  const message = accountId && onMessageAccount ? () => onMessageAccount(accountId) : undefined;
  return (
    <ContactMessage
      tone={tone}
      name={contact.name}
      detail={contact.handle ? `@${contact.handle}` : contact.phone}
      onMessage={message}
      messageLabel={t('contact.message')}
    />
  );
}

function aspectRatioOf(media: MediaView): number | undefined {
  const width = media.thumbnail?.width ?? media.width;
  const height = media.thumbnail?.height ?? media.height;
  return width && height ? width / height : undefined;
}

/**
 * A picture or a video's poster. The sender's thumbnail when there is one — a
 * few kilobytes instead of the original — which is what a bubble is for; the
 * original is downloaded only when the viewer opens.
 */
function VisualMedia({ media, tone, onOpen }: MediaProps) {
  const preview = media.thumbnail?.ref ?? (media.kind === 'image' ? media.ref : undefined);
  const previewMime = media.thumbnail ? 'image/jpeg' : media.mime;
  const { uri } = useMediaUri(preview, previewMime);
  const aspectRatio = aspectRatioOf(media);

  if (media.kind === 'video') {
    return (
      <VideoMessage
        tone={tone}
        source={uri}
        aspectRatio={aspectRatio}
        duration={media.durationMs ? media.durationMs / 1000 : undefined}
        sizeBytes={media.size}
        onPress={onOpen}
      />
    );
  }
  if (media.mime === 'image/gif') {
    return <GifMessage tone={tone} source={uri} aspectRatio={aspectRatio} onPress={onOpen} />;
  }
  return <ImageMessage tone={tone} source={uri} aspectRatio={aspectRatio} onPress={() => onOpen()} />;
}

/** A flat bar: the waveform is not part of the message, and inventing one would be decoration posing as data. */
const FLAT_WAVEFORM: readonly number[] = Array.from({ length: 32 }, () => 0.35);

/**
 * A voice note or an audio file. Nothing is downloaded until the first press;
 * that press then plays as soon as the bytes are decrypted.
 */
function AudioMedia({ media, tone }: Omit<MediaProps, 'onOpen'>) {
  const [wanted, setWanted] = useState(false);
  const playWhenReady = useRef(false);
  const { uri } = useMediaUri(media.ref, media.mime, wanted);
  const player = useAudioPlayer(uri === '' ? null : uri);
  const status = useAudioPlayerStatus(player);

  useEffect(() => {
    if (!playWhenReady.current || !status.isLoaded) return;
    playWhenReady.current = false;
    player.play();
  }, [status.isLoaded, player]);

  const toggle = useCallback(() => {
    if (status.playing) {
      player.pause();
      return;
    }
    if (uri === '') {
      setWanted(true);
      playWhenReady.current = true;
      return;
    }
    if (status.didJustFinish) void player.seekTo(0);
    player.play();
  }, [player, status.playing, status.didJustFinish, uri]);

  const duration = status.isLoaded && status.duration > 0 ? status.duration : (media.durationMs ?? 0) / 1000;

  return (
    <VoiceMessage
      tone={tone}
      samples={FLAT_WAVEFORM}
      duration={duration}
      position={status.currentTime}
      playing={status.playing}
      onPlayPress={toggle}
      onSeek={(seconds) => void player.seekTo(seconds)}
    />
  );
}

/** A document: a row with its name and size; pressing it decrypts it and hands it to the share sheet. */
function FileMedia({ media, tone }: Omit<MediaProps, 'onOpen'>) {
  const { t } = useTranslation();
  const [wanted, setWanted] = useState(false);
  const shareWhenReady = useRef(false);
  const { uri, loading, error } = useMediaUri(media.ref, media.mime, wanted);

  const share = useCallback(
    (fileUri: string) => {
      shareAttachment({ uri: fileUri, filename: media.filename, mimetype: media.mime })
        .then((outcome) => {
          if (outcome === 'unavailable') toast.error(t('media.shareUnavailable'));
        })
        .catch((shareError: unknown) => logger.warn('[media] a file could not be shared', shareError));
    },
    [media.filename, media.mime, t],
  );

  useEffect(() => {
    if (!shareWhenReady.current || uri === '') return;
    shareWhenReady.current = false;
    share(uri);
  }, [uri, share]);

  const open = useCallback(() => {
    if (uri !== '') {
      share(uri);
      return;
    }
    shareWhenReady.current = true;
    setWanted(true);
  }, [share, uri]);

  useEffect(() => {
    if (error) toast.error(t('media.downloadFailed'));
  }, [error, t]);

  return (
    <FileMessage
      tone={tone}
      name={media.filename}
      mimeType={media.mime}
      sizeBytes={media.size}
      transfer={loading ? 'downloading' : 'idle'}
      onPress={open}
      onDownload={open}
    />
  );
}
