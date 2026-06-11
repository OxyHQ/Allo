import React, { memo, useMemo, useState, useCallback } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
  ScrollView,
  ActivityIndicator,
  type GestureResponderEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type { MediaItem } from '@/stores';
import { ThemedText } from '@/components/ThemedText';
import { useTheme, type Theme } from '@/hooks/useTheme';
import { useDecryptedMediaUrl } from '@/hooks/useDecryptedMediaUrl';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';

/** Long-press handler signature shared with the parent message components. */
type MediaLongPressHandler = (mediaId: string, index: number, event: GestureResponderEvent) => void;

/** Build the carousel stylesheet for a given layout + theme. */
function createCarouselStyles(
  isAiMessage: boolean,
  mediaLength: number,
  theme: Theme,
  screenWidth: number
) {
  return StyleSheet.create({
    container: {
      marginBottom: MESSAGING_CONSTANTS.MEDIA_MARGIN_BOTTOM,
      borderRadius: isAiMessage
        ? MESSAGING_CONSTANTS.MEDIA_BORDER_RADIUS_AI
        : MESSAGING_CONSTANTS.MESSAGE_BUBBLE_BORDER_RADIUS,
      overflow: 'hidden',
      backgroundColor: 'transparent',
      alignSelf: isAiMessage ? 'stretch' : 'flex-start',
    },
    scrollView: {
      flexDirection: 'row',
    },
    mediaItem: {
      marginRight: mediaLength > 1 ? 4 : 0,
      borderRadius: isAiMessage
        ? MESSAGING_CONSTANTS.MEDIA_BORDER_RADIUS_AI
        : MESSAGING_CONSTANTS.MESSAGE_BUBBLE_BORDER_RADIUS,
      overflow: 'hidden',
    },
    image: {
      width: isAiMessage ? screenWidth - 32 : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
      maxWidth: isAiMessage ? '100%' : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
      height: MESSAGING_CONSTANTS.MEDIA_HEIGHT,
    },
    videoPlaceholder: {
      width: isAiMessage ? screenWidth - 32 : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
      maxWidth: isAiMessage ? '100%' : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
      height: MESSAGING_CONSTANTS.MEDIA_HEIGHT,
      backgroundColor: theme.colors.border || '#E5E5E5',
      justifyContent: 'center',
      alignItems: 'center',
    },
    videoIcon: {
      fontSize: 48,
      color: theme.colors.textSecondary || '#666666',
    },
    placeholderText: {
      fontSize: 13,
      color: theme.colors.textSecondary || '#666666',
    },
    pagination: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      marginTop: 8,
      gap: 4,
    },
    paginationDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.colors.border || '#CCCCCC',
    },
    paginationDotActive: {
      backgroundColor: theme.colors.primary || '#007AFF',
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    playOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: 'center',
      justifyContent: 'center',
    },
    playBadge: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
}

export interface MediaCarouselProps {
  media: MediaItem[];
  isAiMessage?: boolean;
  /** Plaintext-only fallback resolver; encrypted items resolve via the cache. */
  getMediaUrl: (mediaId: string) => string;
  onMediaPress?: (mediaId: string, index: number) => void;
  onMediaLongPress?: MediaLongPressHandler;
}

// Use hook inside component instead of module-level Dimensions.get (handles rotation)

/**
 * MediaCarousel Component
 * 
 * Displays a carousel of media items (images, videos, polls, cards, etc.)
 * Supports horizontal scrolling and tap to expand.
 * 
 * @example
 * ```tsx
 * <MediaCarousel
 *   media={mediaItems}
 *   isAiMessage={false}
 *   getMediaUrl={(id) => `https://example.com/${id}`}
 *   onMediaPress={(id, index) => console.log('Pressed', id)}
 * />
 * ```
 */
export const MediaCarousel = memo<MediaCarouselProps>(({
  media,
  isAiMessage = false,
  getMediaUrl,
  onMediaPress,
  onMediaLongPress,
}) => {
  const theme = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(0);

  const handleMediaPress = useCallback((mediaId: string, index: number) => {
    if (onMediaPress) {
      onMediaPress(mediaId, index);
    }
  }, [onMediaPress]);

  const handleMediaLongPress = useCallback<MediaLongPressHandler>((mediaId, index, event) => {
    if (onMediaLongPress) {
      onMediaLongPress(mediaId, index, event);
    }
  }, [onMediaLongPress]);

  const styles = useMemo(
    () => createCarouselStyles(isAiMessage, media.length, theme, screenWidth),
    [isAiMessage, media.length, theme, screenWidth]
  );

  const renderMediaItem = useCallback(
    (item: MediaItem, index: number) => (
      <MediaCarouselItem
        key={item.id}
        item={item}
        index={index}
        styles={styles}
        getMediaUrl={getMediaUrl}
        onPress={handleMediaPress}
        onLongPress={handleMediaLongPress}
      />
    ),
    [styles, getMediaUrl, handleMediaPress, handleMediaLongPress]
  );

  if (!media || media.length === 0) {
    return null;
  }

  // For single media item, no need for scroll view
  if (media.length === 1) {
    return (
      <View style={styles.container}>
        {renderMediaItem(media[0], 0)}
      </View>
    );
  }

  // For multiple media items, use scroll view with pagination
  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) => {
          const index = Math.round(event.nativeEvent.contentOffset.x / (isAiMessage ? screenWidth - 32 : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH + 4));
          setActiveIndex(index);
        }}
        style={styles.scrollView}
      >
        {media.map((item, index) => renderMediaItem(item, index))}
      </ScrollView>
      {media.length > 1 && (
        <View style={styles.pagination}>
          {media.map((_, index) => (
            <View
              key={index}
              style={[
                styles.paginationDot,
                index === activeIndex && styles.paginationDotActive,
              ]}
            />
          ))}
        </View>
      )}
    </View>
  );
});

MediaCarousel.displayName = 'MediaCarousel';

/** Concrete style shape produced by the carousel's `StyleSheet.create`. */
type CarouselStyles = ReturnType<typeof createCarouselStyles>;

/**
 * One carousel cell. Extracted into its own component so it can resolve an
 * end-to-end-encrypted item through the decrypted-media cache hook (hooks can't
 * run inside a `.map` in the parent). Plaintext items resolve synchronously.
 */
const MediaCarouselItem = memo<{
  item: MediaItem;
  index: number;
  styles: CarouselStyles;
  getMediaUrl: (mediaId: string) => string;
  onPress: (mediaId: string, index: number) => void;
  onLongPress: MediaLongPressHandler;
}>(({ item, index, styles, getMediaUrl, onPress, onLongPress }) => {
  const { t } = useTranslation();
  const resolved = useDecryptedMediaUrl(item);
  const mediaUrl = item.encrypted ? resolved.url : getMediaUrl(item.id);
  const isImage = item.type === 'image' || item.type === 'gif';
  const isVideo = item.type === 'video';

  const handleLongPress = useCallback(
    (event: GestureResponderEvent) => {
      const target = event.currentTarget;
      if (target && typeof target.measureInWindow === 'function') {
        target.measureInWindow((pageX, pageY) => {
          onLongPress(item.id, index, {
            ...event,
            nativeEvent: {
              ...event.nativeEvent,
              pageX: pageX || event.nativeEvent.pageX,
              pageY: pageY || event.nativeEvent.pageY,
            },
          } as GestureResponderEvent);
        });
      } else {
        onLongPress(item.id, index, event);
      }
    },
    [item.id, index, onLongPress]
  );

  // Encrypted media that failed to download/decrypt: show an unavailable label.
  if (item.encrypted && resolved.isError) {
    return (
      <View style={styles.mediaItem}>
        <View style={styles.videoPlaceholder}>
          <ThemedText style={styles.placeholderText}>{t('chat.mediaUnavailable')}</ThemedText>
        </View>
      </View>
    );
  }

  // Encrypted media still resolving: show a lightweight placeholder so the
  // bubble keeps its layout instead of rendering a broken image.
  if (item.encrypted && !mediaUrl) {
    return (
      <View style={styles.mediaItem}>
        <View style={styles.videoPlaceholder}>
          <ActivityIndicator />
        </View>
      </View>
    );
  }

  if (isImage) {
    return (
      <View style={styles.mediaItem}>
        <TouchableOpacity
          onPress={() => onPress(item.id, index)}
          onLongPress={handleLongPress}
          delayLongPress={400}
          activeOpacity={0.9}
        >
          <Image
            source={{ uri: mediaUrl }}
            style={styles.image}
            contentFit="cover"
            cachePolicy="disk"
            transition={200}
            recyclingKey={item.id}
            accessibilityLabel={`Media attachment: ${item.type}`}
          />
        </TouchableOpacity>
      </View>
    );
  }

  if (isVideo) {
    return (
      <View style={styles.mediaItem}>
        <TouchableOpacity
          style={styles.videoPlaceholder}
          onPress={() => onPress(item.id, index)}
          onLongPress={handleLongPress}
          delayLongPress={400}
          activeOpacity={0.9}
        >
          <View style={styles.videoPlaceholder}>
            <Image
              source={{ uri: mediaUrl }}
              style={styles.image}
              contentFit="cover"
              cachePolicy="disk"
              transition={200}
              recyclingKey={item.id}
              accessibilityLabel="Video thumbnail"
            />
            <View style={styles.playOverlay} pointerEvents="none">
              <View style={styles.playBadge}>
                <Ionicons name="play" size={28} color="#FFFFFF" />
              </View>
            </View>
          </View>
        </TouchableOpacity>
      </View>
    );
  }

  return null;
});

MediaCarouselItem.displayName = 'MediaCarouselItem';
