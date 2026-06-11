/**
 * MediaViewer — fullscreen modal for inspecting images (with double-tap zoom)
 * and videos. Horizontal swipe pages between items.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Modal,
  View,
  StyleSheet,
  TouchableOpacity,
  Platform,
  useWindowDimensions,
  FlatList,
  ViewToken,
  ActivityIndicator,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import * as Sharing from 'expo-sharing';
import type { MediaItem } from '@/stores/messagesStore';
import { useDecryptedMediaUrl } from '@/hooks/useDecryptedMediaUrl';
import { peekDecryptedMediaUrl } from '@/lib/mediaCache';

interface MediaViewerProps {
  visible: boolean;
  media: MediaItem[];
  initialIndex: number;
  /** Plaintext-only fallback resolver; encrypted items resolve via the cache. */
  getMediaUrl: (id: string) => string;
  onClose: () => void;
}

interface ZoomableImageProps {
  uri: string;
  width: number;
  height: number;
}

const ZoomableImage: React.FC<ZoomableImageProps> = ({ uri, width, height }) => {
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedScale = useSharedValue(1);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const reset = useCallback(() => {
    scale.value = withTiming(1);
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedScale.value = 1;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  }, [scale, translateX, translateY, savedScale, savedTranslateX, savedTranslateY]);

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      'worklet';
      if (scale.value > 1) {
        scale.value = withTiming(1);
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedScale.value = 1;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
      } else {
        scale.value = withTiming(2.5);
        savedScale.value = 2.5;
      }
    });

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      'worklet';
      scale.value = Math.max(1, Math.min(5, savedScale.value * e.scale));
    })
    .onEnd(() => {
      'worklet';
      savedScale.value = scale.value;
      if (scale.value <= 1.01) {
        runOnJS(reset)();
      }
    });

  const pan = Gesture.Pan()
    .minPointers(1)
    .maxPointers(2)
    .onUpdate((e) => {
      'worklet';
      if (scale.value > 1) {
        translateX.value = savedTranslateX.value + e.translationX;
        translateY.value = savedTranslateY.value + e.translationY;
      }
    })
    .onEnd(() => {
      'worklet';
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const composed = Gesture.Simultaneous(doubleTap, pinch, pan);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View
        style={[
          { width, height, alignItems: 'center', justifyContent: 'center' },
          animatedStyle,
        ]}
      >
        <Image
          source={{ uri }}
          style={{ width, height }}
          contentFit="contain"
          transition={150}
        />
      </Animated.View>
    </GestureDetector>
  );
};

const VideoPage: React.FC<{ uri: string; width: number; height: number; isActive: boolean }> = ({
  uri,
  width,
  height,
  isActive,
}) => {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.muted = false;
  });

  React.useEffect(() => {
    if (!player) return;
    if (isActive) {
      try {
        player.play();
      } catch {
        /* ignore */
      }
    } else {
      try {
        player.pause();
      } catch {
        /* ignore */
      }
    }
  }, [isActive, player]);

  return (
    <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
      <VideoView
        player={player}
        style={{ width, height: height * 0.8 }}
        contentFit="contain"
        allowsFullscreen
        nativeControls
      />
    </View>
  );
};

/**
 * One pager cell. Resolves an end-to-end-encrypted item through the
 * decrypted-media cache (hooks can't run inside `renderItem`'s closure for each
 * item type) and renders the appropriate viewer. Plaintext items resolve
 * synchronously via the parent's `getMediaUrl`.
 */
const MediaViewerPage: React.FC<{
  item: MediaItem;
  width: number;
  height: number;
  isActive: boolean;
  getMediaUrl: (id: string) => string;
}> = ({ item, width, height, isActive, getMediaUrl }) => {
  const resolved = useDecryptedMediaUrl(item);
  const url = item.encrypted ? resolved.url : getMediaUrl(item.id);

  if (item.encrypted && !url) {
    return (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#FFFFFF" />
      </View>
    );
  }

  if (item.type === 'video') {
    return <VideoPage uri={url} width={width} height={height} isActive={isActive} />;
  }
  return <ZoomableImage uri={url} width={width} height={height} />;
};

export const MediaViewer: React.FC<MediaViewerProps> = ({
  visible,
  media,
  initialIndex,
  getMediaUrl,
  onClose,
}) => {
  const { width, height } = useWindowDimensions();
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const listRef = useRef<FlatList<MediaItem>>(null);

  React.useEffect(() => {
    if (visible) setActiveIndex(initialIndex);
  }, [visible, initialIndex]);

  const handleShare = useCallback(async () => {
    const item = media[activeIndex];
    if (!item) return;
    // Encrypted items share their already-decrypted local file (resolved by the
    // visible page); plaintext items share the resolved remote URL.
    const url = item.encrypted ? peekDecryptedMediaUrl(item.id) : getMediaUrl(item.id);
    if (!url) return;
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) return;
      await Sharing.shareAsync(url);
    } catch (error) {
      console.warn('[MediaViewer] share failed:', error);
    }
  }, [activeIndex, media, getMediaUrl]);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      if (first && typeof first.index === 'number') {
        setActiveIndex(first.index);
      }
    }
  ).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  const renderItem = useCallback(
    ({ item, index }: { item: MediaItem; index: number }) => (
      <MediaViewerPage
        item={item}
        width={width}
        height={height}
        isActive={index === activeIndex}
        getMediaUrl={getMediaUrl}
      />
    ),
    [getMediaUrl, width, height, activeIndex]
  );

  const keyExtractor = useCallback((item: MediaItem) => item.id, []);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)' },
        header: {
          position: 'absolute',
          top: Platform.OS === 'ios' ? 56 : 24,
          left: 0,
          right: 0,
          flexDirection: 'row',
          justifyContent: 'space-between',
          paddingHorizontal: 16,
          zIndex: 10,
        },
        iconBtn: {
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: 'rgba(255,255,255,0.15)',
          alignItems: 'center',
          justifyContent: 'center',
        },
        counter: {
          position: 'absolute',
          bottom: 32,
          left: 0,
          right: 0,
          alignItems: 'center',
        },
      }),
    []
  );

  if (!visible || media.length === 0) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <FlatList
          ref={listRef}
          data={media}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={initialIndex}
          getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          windowSize={3}
        />

        <View style={styles.header} pointerEvents="box-none">
          <TouchableOpacity style={styles.iconBtn} onPress={onClose} activeOpacity={0.8}>
            <Ionicons name="close" size={24} color="#FFFFFF" />
          </TouchableOpacity>
          {Platform.OS !== 'web' && (
            <TouchableOpacity style={styles.iconBtn} onPress={handleShare} activeOpacity={0.8}>
              <Ionicons name="share-outline" size={22} color="#FFFFFF" />
            </TouchableOpacity>
          )}
        </View>

        {media.length > 1 && (
          <View style={styles.counter} pointerEvents="none">
            <View
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 12,
                backgroundColor: 'rgba(0,0,0,0.5)',
              }}
            >
              <Animated.Text style={{ color: '#FFFFFF', fontWeight: '600' }}>
                {activeIndex + 1} / {media.length}
              </Animated.Text>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
};
