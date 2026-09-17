import React, { memo, useMemo, useState, useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity, useWindowDimensions, ScrollView, ActivityIndicator, type GestureResponderEvent } from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { MediaItem } from '@/stores';
import { useTheme } from '@/hooks/useTheme';
import { useMediaUri } from '@/lib/allo/useMediaUri';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';

export interface MediaCarouselProps {
  media: MediaItem[];
  isAiMessage?: boolean;
  onMediaPress?: (mediaId: string, index: number) => void;
  onMediaLongPress?: (mediaId: string, index: number, event: GestureResponderEvent) => void;
}

/** The MIME a sender's thumbnail is encoded as; see `renderThumbnail` in `lib/chat/attachments.ts`. */
const THUMBNAIL_MIME = 'image/jpeg';

/**
 * MediaCarousel Component
 *
 * Displays a carousel of media items (images and videos). Supports horizontal
 * scrolling and tap to expand. Every picture is fetched and decrypted through
 * the SDK by `useMediaUri`; a bubble draws the sender's thumbnail when there is
 * one and the original otherwise.
 */
export const MediaCarousel = memo<MediaCarouselProps>(({
  media,
  isAiMessage = false,
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

  const handleMediaLongPress = useCallback((mediaId: string, index: number, event: GestureResponderEvent) => {
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
      width: isAiMessage ? screenWidth - 32 : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
      maxWidth: isAiMessage ? '100%' : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
      height: MESSAGING_CONSTANTS.MEDIA_HEIGHT,
    },
    placeholder: {
      width: isAiMessage ? screenWidth - 32 : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
      maxWidth: isAiMessage ? '100%' : MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
      height: MESSAGING_CONSTANTS.MEDIA_HEIGHT,
      backgroundColor: theme.colors.border,
      justifyContent: 'center',
      alignItems: 'center',
    },
    playOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      justifyContent: 'center',
      alignItems: 'center',
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
      backgroundColor: theme.colors.border,
    },
    paginationDotActive: {
      backgroundColor: theme.colors.primary,
      width: 8,
      height: 8,
      borderRadius: 4,
    },
  }), [isAiMessage, media.length, theme, screenWidth]);

  if (!media || media.length === 0) {
    return null;
  }

  const longPress = (item: MediaItem, index: number) => (event: GestureResponderEvent) => {
    // Use measure to get accurate position
    if (event.currentTarget && 'measureInWindow' in event.currentTarget) {
      const measurable = event.currentTarget as {
        measureInWindow(cb: (pageX: number, pageY: number, width: number, height: number) => void): void;
      };
      measurable.measureInWindow((pageX, pageY) => {
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
  };

  const renderMediaItem = (item: MediaItem, index: number) => (
    <View key={item.id} style={styles.mediaItem}>
      <TouchableOpacity
        onPress={() => handleMediaPress(item.id, index)}
        onLongPress={longPress(item, index)}
        delayLongPress={400}
        activeOpacity={0.9}
      >
        <CarouselPicture
          item={item}
          imageStyle={styles.image}
          placeholderStyle={styles.placeholder}
          playOverlayStyle={styles.playOverlay}
          iconColor={theme.colors.textSecondary}
        />
      </TouchableOpacity>
    </View>
  );

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

interface CarouselPictureProps {
  item: MediaItem;
  imageStyle: object;
  placeholderStyle: object;
  playOverlayStyle: object;
  iconColor: string;
}

/**
 * One picture in the row.
 *
 * A bubble is 250pt wide, so it draws the smallest copy it can get: the
 * sender's thumbnail when there is one. A video with no thumbnail has nothing
 * a bubble can draw without decoding the whole file, and draws a play mark on
 * a flat card instead; the viewer plays it.
 */
const CarouselPicture = memo<CarouselPictureProps>(({ item, imageStyle, placeholderStyle, playOverlayStyle, iconColor }) => {
  const isVideo = item.type === 'video';
  const preview = item.thumbnailRef ?? (isVideo ? undefined : item.ref);
  const mime = item.thumbnailRef ? THUMBNAIL_MIME : item.mime;
  const { uri, loading } = useMediaUri(preview, mime);

  if (uri === '') {
    return (
      <View style={placeholderStyle}>
        {loading ? (
          <ActivityIndicator color={iconColor} />
        ) : (
          <Ionicons name={isVideo ? 'play-circle-outline' : 'image-outline'} size={48} color={iconColor} />
        )}
      </View>
    );
  }

  return (
    <View>
      <Image
        source={{ uri }}
        style={imageStyle}
        contentFit="cover"
        // Memory only: these bytes are the decrypted copy of a picture from an
        // encrypted conversation, and expo-image's disk cache would write it
        // somewhere nothing in the app can release.
        cachePolicy="memory"
        transition={200}
        recyclingKey={item.id}
        accessibilityLabel={isVideo ? 'Video thumbnail' : `Media attachment: ${item.type}`}
      />
      {isVideo && (
        <View style={playOverlayStyle} pointerEvents="none">
          <Ionicons name="play-circle" size={56} color="#FFFFFF" />
        </View>
      )}
    </View>
  );
});

CarouselPicture.displayName = 'CarouselPicture';
