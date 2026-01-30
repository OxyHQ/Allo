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
      overflow: 'hidden' as const,
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

  // Determine source type:
  // - object: parsed Lottie JSON (from require('./file.json') or inline)
  // - number: bundled image asset (from require('./file.png'))
  // - string starting with http: remote URL
  // - string: local file path
  const sourceType = typeof sticker.source;
  const isLottieObject = sourceType === 'object' && sticker.source !== null;
  const isAssetNumber = sourceType === 'number';
  const isRemoteUrl = sourceType === 'string' && (sticker.source as string).startsWith('http');

  const lottieSource = isLottieObject
    ? (sticker.source as object)
    : isAssetNumber
      ? (sticker.source as number)
      : isRemoteUrl
        ? { uri: sticker.source as string }
        : sourceType === 'string'
          ? (sticker.source as string)
          : null;

  return (
    <View style={styles.container}>
      {lottieSource ? (
        <View style={styles.lottie}>
          <LottieView
            source={lottieSource as any}
            autoPlay
            loop
            style={styles.lottie}
            resizeMode="contain"
          />
        </View>
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
