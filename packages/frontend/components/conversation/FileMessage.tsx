/**
 * FileMessage — renders a generic file attachment (PDF, doc, …) with a download
 * affordance (opens the resolved URL with Linking).
 */
import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity, Linking, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { useDecryptedMediaUrl } from '@/hooks/useDecryptedMediaUrl';
import type { MediaItem } from '@/stores/messagesStore';

interface FileMessageProps {
  media: MediaItem;
  isSent: boolean;
  /** Plaintext-only fallback resolver; encrypted items resolve via the cache. */
  getMediaUrl: (id: string) => string;
}

const formatBytes = (bytes?: number): string => {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
};

export const FileMessage: React.FC<FileMessageProps> = ({ media, isSent, getMediaUrl }) => {
  const theme = useTheme();
  const resolved = useDecryptedMediaUrl(media);

  const openFile = useCallback(async () => {
    const url = media.encrypted ? resolved.url : getMediaUrl(media.id);
    if (!url) return;
    // Encrypted files resolve to a local decrypted file:// (native) or blob:
    // (web) URL. Open the OS share sheet on native; on web open the object URL.
    if (media.encrypted && Platform.OS !== 'web') {
      try {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(url);
          return;
        }
      } catch (error) {
        console.warn('[FileMessage] share failed:', error);
      }
    }
    Linking.openURL(url).catch((error) => {
      console.warn('[FileMessage] open failed:', error);
    });
  }, [media.id, media.encrypted, resolved.url, getMediaUrl]);

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
        iconWrap: {
          width: 44,
          height: 44,
          borderRadius: 22,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(92, 107, 192, 0.18)',
        },
        info: { flex: 1 },
        name: {
          fontSize: 14,
          fontWeight: '600',
          color: isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived,
        },
        size: {
          fontSize: 12,
          color: isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived,
          opacity: 0.6,
          marginTop: 2,
        },
      }),
    [theme, isSent]
  );

  return (
    <TouchableOpacity style={styles.container} onPress={openFile} activeOpacity={0.8}>
      <View style={styles.iconWrap}>
        <Ionicons name="document" size={22} color="#5C6BC0" />
      </View>
      <View style={styles.info}>
        <ThemedText style={styles.name} numberOfLines={1}>
          {media.fileName || 'File'}
        </ThemedText>
        {media.fileSize ? (
          <ThemedText style={styles.size}>{formatBytes(media.fileSize)}</ThemedText>
        ) : null}
      </View>
      <Ionicons
        name="download-outline"
        size={20}
        color={isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived}
      />
    </TouchableOpacity>
  );
};
