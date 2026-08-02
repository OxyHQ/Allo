import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import Slider from '@react-native-community/slider';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useTranslation } from 'react-i18next';
import { Icons } from '@oxyhq/bloom';

import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';
import type { MessageAttachment, MessageReadStatus } from '@/stores/messagesStore';
import { logger } from '@/utils/logger';

import { MessageMetadata } from './MessageMetadata';
import { displayDurationMs, formatPlaybackTime, playbackFraction, seekPositionMs } from './attachmentFormat';

/**
 * A voice note, playable.
 *
 * **No waveform, and that is a decision rather than a gap.** Matrix carries one
 * — MSC3246, beside the voice marker Allo already sends — but nothing that
 * reaches this component has it: Allo's recorder samples no amplitudes, so
 * outgoing notes carry none, and the port's `AlloMediaContent` does not expose
 * the field for the incoming ones that do. Drawing bars from anything else means
 * drawing a picture of audio nobody measured, which is a lie told sixty times a
 * second. A plain progress bar is honest about what is known: how long it is and
 * how far through it we are. (Adding the real waveform means widening the port
 * and both of its halves; it is worth doing and it is not this.)
 *
 * **Nothing is fetched until play is pressed.** The bytes of a voice note are
 * the whole recording, not a thumbnail, and asking the resolver for a URL is
 * what starts the download (see `lib/chat/mediaCache.ts`). A screenful of voice
 * notes that downloaded themselves on render would spend a conversation's worth
 * of a stranger's data allowance to draw a row that is a play button either way.
 */

export interface VoiceNoteBubbleProps {
  readonly attachment: MessageAttachment;
  readonly isSent: boolean;
  readonly timestamp: Date;
  readonly showTimestamp: boolean;
  readonly readStatus: MessageReadStatus | undefined;
  /**
   * An attachment source to a local URI, or `''` while there is not one yet.
   *
   * Called only after the user has pressed play — see the note above.
   */
  readonly resolveUrl: (source: string) => string;
}

const SECONDS_TO_MILLISECONDS = 1000;

export const VoiceNoteBubble = memo<VoiceNoteBubbleProps>(
  ({ attachment, isSent, timestamp, showTimestamp, readStatus, resolveUrl }) => {
    const theme = useTheme();
    const { t } = useTranslation();

    // Two separate facts, and they cannot be one. `wanted` is "the user has
    // asked for this recording at least once", which is what makes it legal to
    // start a download; `pendingPlay` is "a press is still waiting for a player
    // that could not obey it", which is true only across the gap between the two.
    const [wanted, setWanted] = useState(false);
    const [pendingPlay, setPendingPlay] = useState(false);
    const [scrubFraction, setScrubFraction] = useState<number | undefined>(undefined);

    const uri = wanted ? resolveUrl(attachment.source) : '';
    const player = useAudioPlayer(uri === '' ? null : uri);
    const status = useAudioPlayerStatus(player);

    /**
     * The one Effect here, and the case Effects exist for: a request the user
     * made at a moment when the external system could not answer it.
     *
     * Pressing play on a note that has not been downloaded starts a download;
     * the player only becomes able to play some renders later, when the bytes
     * have arrived and been decrypted. That readiness is the player's event, not
     * React's, and the press cannot be replayed from a handler that has already
     * returned. It is a one-shot — honoured, then cleared — so it cannot loop
     * when playback later stops of its own accord at the end of the recording.
     */
    useEffect(() => {
      if (!pendingPlay || !status.isLoaded) {
        return;
      }
      setPendingPlay(false);
      player.play();
    }, [pendingPlay, status.isLoaded, player]);

    const durationMs = displayDurationMs(
      status.isLoaded ? status.duration * SECONDS_TO_MILLISECONDS : undefined,
      attachment.durationMs,
    );
    const positionMs = status.currentTime * SECONDS_TO_MILLISECONDS;
    // While a thumb is being dragged the bar follows the finger, not the
    // player: the player is still where it was, and a bar that snapped back to
    // it on every frame could not be dragged at all.
    const fraction = scrubFraction ?? playbackFraction(positionMs, durationMs);
    const elapsedLabel = formatPlaybackTime(
      scrubFraction === undefined ? positionMs : seekPositionMs(scrubFraction, durationMs),
    );

    const handlePlayPause = useCallback(() => {
      if (status.playing) {
        player.pause();
        return;
      }
      if (uri === '') {
        setWanted(true);
        setPendingPlay(true);
        return;
      }
      if (status.didJustFinish) {
        // A finished player left at the end plays nothing when told to play
        // again, which reads as a broken button.
        player.seekTo(0).catch((error: unknown) => {
          logger.warn('[media] a voice note could not be rewound', error);
        });
      }
      player.play();
    }, [player, status.playing, status.didJustFinish, uri]);

    const handleScrubEnd = useCallback(
      (value: number) => {
        setScrubFraction(undefined);
        if (durationMs <= 0) {
          return;
        }
        player
          .seekTo(seekPositionMs(value, durationMs) / SECONDS_TO_MILLISECONDS)
          .catch((error: unknown) => {
            logger.warn('[media] a voice note could not be sought', error);
          });
      },
      [durationMs, player],
    );

    const bubbleColor = isSent
      ? theme.colors.messageBubbleSent
      : theme.colors.messageBubbleReceived;
    const foreground = isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived;
    const trackBehind = isSent ? theme.colors.primaryLight : theme.colors.border;

    const styles = useMemo(
      () =>
        StyleSheet.create({
          bubble: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: MESSAGING_CONSTANTS.MESSAGE_PADDING_HORIZONTAL,
            paddingVertical: MESSAGING_CONSTANTS.MESSAGE_PADDING_VERTICAL,
            borderRadius: MESSAGING_CONSTANTS.MESSAGE_BUBBLE_BORDER_RADIUS,
            backgroundColor: bubbleColor,
            alignSelf: isSent ? 'flex-end' : 'flex-start',
            // No `maxWidth`: the block's content column is already capped at
            // `MAX_MESSAGE_WIDTH`, and capping again inside it would make an
            // attachment two thirds the width of the text beside it.
            minWidth: 200,
          },
          control: {
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
          },
          middle: {
            flex: 1,
          },
          slider: {
            width: '100%',
            height: 28,
          },
          footer: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          },
          time: {
            fontSize: MESSAGING_CONSTANTS.TIMESTAMP_SIZE,
            color: foreground,
            opacity: 0.8,
          },
        }),
      [bubbleColor, foreground, isSent],
    );

    const PlayPauseIcon = status.playing
      ? Icons.Pause_Filled_Corner0_Rounded
      : Icons.Play_Filled_Corner0_Rounded;

    return (
      <View style={styles.bubble}>
        <TouchableOpacity
          onPress={handlePlayPause}
          style={[styles.control, { backgroundColor: trackBehind }]}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={status.playing ? t('Pause') : t('Play')}
        >
          <PlayPauseIcon width={18} height={18} fill={foreground} />
        </TouchableOpacity>

        <View style={styles.middle}>
          <Slider
            style={styles.slider}
            value={fraction}
            minimumValue={0}
            maximumValue={1}
            minimumTrackTintColor={foreground}
            maximumTrackTintColor={trackBehind}
            thumbTintColor={foreground}
            // Disabled until there is a length to scrub through: a bar that
            // moves the thumb but not the playhead is worse than one that does
            // not move.
            disabled={durationMs <= 0}
            onValueChange={setScrubFraction}
            onSlidingComplete={handleScrubEnd}
            accessibilityLabel={t('Playback position')}
          />
          <View style={styles.footer}>
            <ThemedText style={styles.time}>
              {`${elapsedLabel} / ${formatPlaybackTime(durationMs)}`}
            </ThemedText>
            {showTimestamp && (
              <MessageMetadata
                timestamp={timestamp}
                isSent={isSent}
                readStatus={readStatus}
                showTimestamp={showTimestamp}
                variant="bubble"
              />
            )}
          </View>
        </View>
      </View>
    );
  },
);

VoiceNoteBubble.displayName = 'VoiceNoteBubble';
