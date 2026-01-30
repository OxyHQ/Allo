import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import LottieView from 'lottie-react-native';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';
import { MessageMetadata } from './MessageMetadata';
import type { StickerItem } from '@/stores';

export interface StickerBubbleProps {
  sticker: StickerItem;
  isSent: boolean;
  timestamp: Date;
  readStatus?: 'pending' | 'sent' | 'delivered' | 'read';
}

/**
 * StickerBubble Component
 *
 * Renders an animated Lottie sticker without a message bubble background.
 * Falls back to emoji text if the Lottie source fails to load.
 * Styled like Telegram stickers — standalone, no bubble, aligned left/right.
 */
export const StickerBubble = memo<StickerBubbleProps>(({
  sticker,
  isSent,
  timestamp,
  readStatus,
}) => {
  const styles = useMemo(() => StyleSheet.create({
    container: {
      alignSelf: isSent ? 'flex-end' : 'flex-start',
      alignItems: isSent ? 'flex-end' : 'flex-start',
      marginVertical: 2,
    },
    lottie: {
      width: MESSAGING_CONSTANTS.STICKER_SIZE,
      height: MESSAGING_CONSTANTS.STICKER_SIZE,
    },
    emojiFallback: {
      fontSize: 64,
      textAlign: 'center',
    },
    metadata: {
      marginTop: 2,
      alignSelf: isSent ? 'flex-end' : 'flex-start',
    },
  }), [isSent]);

  const isRemoteSource = typeof sticker.source === 'string' && sticker.source.startsWith('http');

  return (
    <View style={styles.container}>
      {typeof sticker.source === 'string' ? (
        <LottieView
          source={isRemoteSource ? { uri: sticker.source } : sticker.source}
          autoPlay
          loop
          style={styles.lottie}
          resizeMode="contain"
        />
      ) : sticker.emoji ? (
        <Text style={styles.emojiFallback}>{sticker.emoji}</Text>
      ) : null}
      <View style={styles.metadata}>
        <MessageMetadata
          timestamp={timestamp}
          isSent={isSent}
          readStatus={readStatus}
          showTimestamp
          variant="default"
        />
      </View>
    </View>
  );
});

StickerBubble.displayName = 'StickerBubble';
