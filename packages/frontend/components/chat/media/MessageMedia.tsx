import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import type { MediaView } from '@allo/core';
import {
  FileMessage,
  GifMessage,
  ImageMessage,
  VideoMessage,
  VoiceMessage,
  type MessageTone,
} from '@oxy.so/bloom/message-media';
import { toast } from '@oxy.so/bloom/toast';

import { useMediaUri } from '@/lib/allo/useMediaUri';
import { shareAttachment } from '@/lib/chat/shareAttachment';
import { logger } from '@/utils/logger';

interface MessageMediaProps {
  media: MediaView;
  tone: MessageTone;
  /** Opens the full-screen viewer on this message. Pictures and videos only. */
  onOpen: () => void;
}

/** What goes inside a bubble for an attachment, decrypted on demand. */
export const MessageMedia = memo(function MessageMedia({ media, tone, onOpen }: MessageMediaProps) {
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
});

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
function VisualMedia({ media, tone, onOpen }: MessageMediaProps) {
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
function AudioMedia({ media, tone }: Omit<MessageMediaProps, 'onOpen'>) {
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
function FileMedia({ media, tone }: Omit<MessageMediaProps, 'onOpen'>) {
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
