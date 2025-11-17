import React, { memo, useMemo, useState, useCallback } from 'react';
import { View, Image, StyleSheet, TouchableOpacity, Dimensions, ScrollView } from 'react-native';
import type { MediaItem } from '@/stores';
import { useTheme } from '@/hooks/useTheme';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';

export interface MediaCarouselProps {
  media: MediaItem[];
  isAiMessage?: boolean;
  getMediaUrl: (mediaId: string) => string;
  onMediaPress?: (mediaId: string, index: number) => void;
  onMediaLongPress?: (mediaId: string, index: number, event: any) => void;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

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
  const [activeIndex, setActiveIndex] = useState(0);

  const handleMediaPress = useCallback((mediaId: string, index: number) => {
    if (onMediaPress) {
      onMediaPress(mediaId, index);
    }
  }, [onMediaPress]);

  const handleMediaLongPress = useCallback((mediaId: string, index: number, event: any) => {
    if (onMediaLongPress) {
      onMediaLongPress(mediaId, index, event);
    }
  }, [onMediaLongPress]);

  const styles = useMemo(() => StyleSheet.create({
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
      marginRight: media.length > 1 ? 4 : 0,
      borderRadius: isAiMessage 
        ? MESSAGING_CONSTANTS.MEDIA_BORDER_RADIUS_AI 
        : MESSAGING_CONSTANTS.MESSAGE_BUBBLE_BORDER_RADIUS,
      overflow: 'hidden',
    },
    image: {
      width: isAiMessage ? SCREEN_WIDTH - 32 : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
      maxWidth: isAiMessage ? '100%' : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
      height: MESSAGING_CONSTANTS.MEDIA_HEIGHT,
      resizeMode: 'cover',
    },
    videoPlaceholder: {
      width: isAiMessage ? SCREEN_WIDTH - 32 : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
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
  }), [isAiMessage, media.length, theme]);

  if (!media || media.length === 0) {
    return null;
  }

  const renderMediaItem = (item: MediaItem, index: number) => {
    const mediaUrl = getMediaUrl(item.id);
    const isImage = item.type === 'image' || item.type === 'gif';
    const isVideo = item.type === 'video';

    if (isImage) {
      return (
        <View key={item.id} style={styles.mediaItem}>
          <TouchableOpacity
            onPress={() => handleMediaPress(item.id, index)}
            onLongPress={(event) => {
              // Use measure to get accurate position
              if (event.currentTarget && 'measure' in event.currentTarget) {
                // @ts-ignore
                event.currentTarget.measure((x, y, width, height, pageX, pageY) => {
                  handleMediaLongPress(item.id, index, {
                    ...event,
                    nativeEvent: {
                      ...event.nativeEvent,
                      pageX: pageX || event.nativeEvent.pageX,
                      pageY: pageY || event.nativeEvent.pageY,
                    },
                    currentTarget: event.currentTarget,
                  });
                });
              } else {
                handleMediaLongPress(item.id, index, event);
              }
            }}
            delayLongPress={400}
            activeOpacity={0.9}
          >
            <Image
              source={{ uri: mediaUrl }}
              style={styles.image}
              accessibilityLabel={`Media attachment: ${item.type}`}
            />
          </TouchableOpacity>
        </View>
      );
    }

    if (isVideo) {
      return (
        <View key={item.id} style={styles.mediaItem}>
          <TouchableOpacity
            style={styles.videoPlaceholder}
            onPress={() => handleMediaPress(item.id, index)}
            onLongPress={(event) => {
              // Use measure to get accurate position
              if (event.currentTarget && 'measure' in event.currentTarget) {
                // @ts-ignore
                event.currentTarget.measure((x, y, width, height, pageX, pageY) => {
                  handleMediaLongPress(item.id, index, {
                    ...event,
                    nativeEvent: {
                      ...event.nativeEvent,
                      pageX: pageX || event.nativeEvent.pageX,
                      pageY: pageY || event.nativeEvent.pageY,
                    },
                    currentTarget: event.currentTarget,
                  });
                });
              } else {
                handleMediaLongPress(item.id, index, event);
              }
            }}
            delayLongPress={400}
            activeOpacity={0.9}
          >
            <View style={styles.videoPlaceholder}>
              <Image
                source={{ uri: mediaUrl }}
                style={styles.image}
                accessibilityLabel="Video thumbnail"
              />
              {/* TODO: Add video play overlay icon */}
            </View>
          </TouchableOpacity>
        </View>
      );
    }

    return null;
  };

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
          const index = Math.round(event.nativeEvent.contentOffset.x / (isAiMessage ? SCREEN_WIDTH - 32 : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH + 4));
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

