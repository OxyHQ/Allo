/**
 * AudioMessage — inline voice note player with play/pause + progress bar + duration.
 * Uses expo-audio's useAudioPlayer hook.
 */
import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { useDecryptedMediaUrl } from '@/hooks/useDecryptedMediaUrl';
import type { MediaItem } from '@/stores/messagesStore';

interface AudioMessageProps {
  media: MediaItem;
  isSent: boolean;
  /** Plaintext-only fallback resolver; encrypted items resolve via the cache. */
  getMediaUrl: (id: string) => string;
}

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const AudioMessage: React.FC<AudioMessageProps> = ({ media, isSent, getMediaUrl }) => {
  const theme = useTheme();
  const resolved = useDecryptedMediaUrl(media);
  // Encrypted items resolve through the decrypted-media cache; plaintext items
  // fall back to the synchronous resolver passed by the parent.
  const url = media.encrypted ? resolved.url : getMediaUrl(media.id);
  const player = useAudioPlayer(url ? { uri: url } : undefined);
  const status = useAudioPlayerStatus(player);

  const togglePlay = useCallback(() => {
    if (!player) return;
    if (status?.playing) {
      player.pause();
    } else {
      // When the player finished, seek back to start before playing again
      if (status && status.duration && status.currentTime >= status.duration - 0.05) {
        player.seekTo(0);
      }
      player.play();
    }
  }, [player, status]);

  const duration = status?.duration ?? media.duration ?? 0;
  const current = status?.currentTime ?? 0;
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderRadius: 14,
          backgroundColor: isSent
            ? theme.colors.messageBubbleSent
            : theme.colors.messageBubbleReceived,
          minWidth: 220,
        },
        button: {
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.primary || '#007AFF',
        },
        body: { flex: 1 },
        barBg: {
          height: 4,
          borderRadius: 2,
          backgroundColor: 'rgba(0,0,0,0.12)',
          overflow: 'hidden',
        },
        barFill: {
          height: '100%',
          backgroundColor: theme.colors.primary || '#007AFF',
        },
        meta: {
          marginTop: 6,
          fontSize: 12,
          color: isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived,
          opacity: 0.7,
        },
      }),
    [theme, isSent]
  );

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.button} onPress={togglePlay} activeOpacity={0.85}>
        <Ionicons name={status?.playing ? 'pause' : 'play'} size={18} color="#FFFFFF" />
      </TouchableOpacity>
      <View style={styles.body}>
        <View style={styles.barBg}>
          <View style={[styles.barFill, { width: `${progress * 100}%` }]} />
        </View>
        <ThemedText style={styles.meta}>
          {formatTime(current)} / {formatTime(duration)}
        </ThemedText>
      </View>
    </View>
  );
};
