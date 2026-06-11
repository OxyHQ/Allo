/**
 * StatusViewer
 *
 * Fullscreen viewer that plays a single user's statuses in sequence,
 * Instagram/WhatsApp-style:
 *
 *   - Top segmented progress bars (one per status, current one animates).
 *   - Tap right half: next status. Tap left half: previous.
 *   - Long-press anywhere: pause auto-advance until released.
 *   - Swipe down: close.
 *   - Marks each status as viewed when it becomes active.
 *
 * If the viewer is the owner of the status (`isOwner`), we expose a "viewers"
 * pill that opens a bottom-sheet list of viewers.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  type TextStyle,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  cancelAnimation,
  useAnimatedReaction,
  type SharedValue,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import Avatar from '@/components/Avatar';
import { useTheme } from '@/hooks/useTheme';
import { formatRelativeLastSeen } from '@/utils/dateUtils';
import { useStatusStore, Status, StatusAuthor, StatusViewer as StatusViewerType } from '@/stores/statusStore';
import { toast } from '@/lib/sonner';

const IconComponent = Ionicons as any;

const IMAGE_DURATION_MS = 5000;
const DEFAULT_VIDEO_DURATION_MS = 10000;
const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface Props {
  visible: boolean;
  statuses: Status[];
  initialIndex?: number;
  author?: StatusAuthor;
  isOwner?: boolean;
  onClose: () => void;
}

function getDisplayName(author?: StatusAuthor): string {
  if (!author) return '';
  const name = author.name;
  if (!name) return author.username || '';
  if (typeof name === 'string') return name;
  const full = `${name.first || ''} ${name.last || ''}`.trim();
  return full || author.username || '';
}

const ProgressBar: React.FC<{
  isActive: boolean;
  isComplete: boolean;
  progress: SharedValue<number>;
}> = ({ isActive, isComplete, progress }) => {
  const fillStyle = useAnimatedStyle(() => {
    let pct = 0;
    if (isComplete) pct = 1;
    else if (isActive) pct = progress.value;
    return { width: `${Math.min(100, Math.max(0, pct * 100))}%` };
  });

  return (
    <View style={progressBarStyles.track}>
      <Animated.View style={[progressBarStyles.fill, fillStyle]} />
    </View>
  );
};

const progressBarStyles = StyleSheet.create({
  track: {
    flex: 1,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'hidden',
  },
  fill: {
    height: 3,
    backgroundColor: '#FFFFFF',
  },
});

const StatusMedia: React.FC<{
  status: Status;
  paused: boolean;
  onVideoDuration?: (durationMs: number) => void;
}> = ({ status, paused, onVideoDuration }) => {
  // We always call the same hooks regardless of type to obey the rules of
  // hooks; for non-video statuses we feed the player an empty source.
  const isVideo = status.type === 'video';
  const player = useVideoPlayer(isVideo ? status.mediaUrl || '' : '', (p) => {
    p.loop = false;
    p.muted = false;
  });

  useEffect(() => {
    if (!isVideo || !player) return;
    if (paused) {
      try { player.pause(); } catch { /* ignore */ }
    } else {
      try { player.play(); } catch { /* ignore */ }
    }
  }, [paused, player, isVideo]);

  useEffect(() => {
    if (!isVideo || !player || !onVideoDuration) return;
    // expo-video exposes `duration` (seconds) once ready; poll briefly.
    let cancelled = false;
    const start = Date.now();
    const tick = () => {
      if (cancelled) return;
      const d = (player as any)?.duration;
      if (typeof d === 'number' && d > 0) {
        onVideoDuration(Math.round(d * 1000));
        return;
      }
      if (Date.now() - start < 4000) {
        setTimeout(tick, 250);
      }
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [player, isVideo, onVideoDuration]);

  if (status.type === 'text') {
    const bg = status.backgroundColor || '#075E54';
    const fontStyle: TextStyle | null =
      status.fontFamily === 'serif'
        ? { fontFamily: Platform.OS === 'ios' ? 'Times New Roman' : 'serif' }
        : status.fontFamily === 'mono'
        ? { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }
        : null;
    return (
      <View style={[mediaStyles.fill, { backgroundColor: bg, padding: 24 }]}>
        <Text style={[mediaStyles.textCard, fontStyle]}>{status.text}</Text>
      </View>
    );
  }

  if (status.type === 'image') {
    return (
      <Image
        source={{ uri: status.mediaUrl }}
        style={mediaStyles.fill}
        contentFit="contain"
        cachePolicy="memory-disk"
      />
    );
  }

  return (
    <VideoView
      player={player}
      style={mediaStyles.fill}
      contentFit="contain"
      fullscreenOptions={{ enable: false }}
      nativeControls={false}
    />
  );
};

const mediaStyles = StyleSheet.create({
  fill: { flex: 1, width: '100%', height: '100%' },
  textCard: {
    color: '#FFFFFF',
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    flex: 1,
    textAlignVertical: 'center',
  },
});

const ViewersSheet: React.FC<{
  visible: boolean;
  onClose: () => void;
  statusId: string | null;
}> = ({ visible, onClose, statusId }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const getViewers = useStatusStore((s) => s.getViewers);

  const [loading, setLoading] = useState(false);
  const [viewers, setViewers] = useState<(StatusViewerType & { user?: StatusAuthor })[]>([]);

  useEffect(() => {
    if (!visible || !statusId) return;
    setLoading(true);
    getViewers(statusId)
      .then((v) => setViewers(v))
      .catch(() => toast.error(t('status.error.viewersFailed')))
      .finally(() => setLoading(false));
  }, [visible, statusId, getViewers, t]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose} />
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: theme.colors.background,
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 24,
          maxHeight: '70%',
        }}
      >
        <View style={{ alignItems: 'center', marginBottom: 8 }}>
          <View
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: theme.colors.borderLight,
            }}
          />
        </View>
        <Text
          style={{
            color: theme.colors.text,
            fontSize: 16,
            fontWeight: '700',
            marginBottom: 12,
          }}
        >
          {t('status.viewers.title', { count: viewers.length })}
        </Text>

        {loading ? (
          <ActivityIndicator color={theme.colors.primary} />
        ) : (
          <FlatList
            data={viewers}
            keyExtractor={(item) => item.userId}
            renderItem={({ item }) => {
              const name = getDisplayName(item.user) || item.userId;
              return (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 10,
                    gap: 12,
                  }}
                >
                  <Avatar
                    size={36}
                    source={item.user?.avatar ? { uri: item.user.avatar } : undefined}
                    label={name.charAt(0).toUpperCase()}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme.colors.text, fontWeight: '600' }}>{name}</Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                      {new Date(item.viewedAt).toLocaleString()}
                    </Text>
                  </View>
                </View>
              );
            }}
            ListEmptyComponent={
              <Text style={{ color: theme.colors.textSecondary, paddingVertical: 16 }}>
                {t('status.viewers.empty')}
              </Text>
            }
          />
        )}
      </View>
    </Modal>
  );
};

export const StatusViewer: React.FC<Props> = ({
  visible,
  statuses,
  initialIndex = 0,
  author,
  isOwner = false,
  onClose,
}) => {
  const { t } = useTranslation();
  const markViewed = useStatusStore((s) => s.markViewed);
  const deleteStatus = useStatusStore((s) => s.deleteStatus);

  const [index, setIndex] = useState(initialIndex);
  const [paused, setPaused] = useState(false);
  const [viewersOpen, setViewersOpen] = useState(false);

  const progress = useSharedValue(0);
  const durationRef = useRef<number>(IMAGE_DURATION_MS);
  const startedAtRef = useRef<number>(0);
  const remainingMsRef = useRef<number>(IMAGE_DURATION_MS);

  const current = statuses[index];
  const total = statuses.length;

  // Notify viewed for current.
  useEffect(() => {
    if (!visible || !current) return;
    if (!isOwner && !current.viewedByMe) {
      markViewed(current.id);
    }
  }, [visible, current, isOwner, markViewed]);

  // Reset index when visibility/init changes.
  useEffect(() => {
    if (visible) {
      setIndex(initialIndex);
      setPaused(false);
    }
  }, [visible, initialIndex]);

  const goNext = useCallback(() => {
    setIndex((i) => {
      if (i + 1 >= total) {
        onClose();
        return i;
      }
      return i + 1;
    });
  }, [total, onClose]);

  const goPrev = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  const startAnimation = useCallback((durationMs: number) => {
    durationRef.current = durationMs;
    remainingMsRef.current = durationMs;
    startedAtRef.current = Date.now();
    cancelAnimation(progress);
    progress.value = 0;
    progress.value = withTiming(1, { duration: durationMs });
  }, [progress]);

  const pauseAnimation = useCallback(() => {
    const elapsed = Date.now() - startedAtRef.current;
    remainingMsRef.current = Math.max(0, durationRef.current - elapsed);
    cancelAnimation(progress);
  }, [progress]);

  const resumeAnimation = useCallback(() => {
    startedAtRef.current = Date.now() - (durationRef.current - remainingMsRef.current);
    progress.value = withTiming(1, { duration: remainingMsRef.current });
  }, [progress]);

  // Drive progress for each status.
  useEffect(() => {
    if (!visible || !current) return;
    const baseDuration =
      current.type === 'video' ? DEFAULT_VIDEO_DURATION_MS : IMAGE_DURATION_MS;
    startAnimation(baseDuration);
  }, [visible, current, startAnimation]);

  // React to pause toggle.
  useEffect(() => {
    if (!visible) return;
    if (paused) pauseAnimation();
    else if (startedAtRef.current > 0) resumeAnimation();
  }, [paused, visible, pauseAnimation, resumeAnimation]);

  // When the progress completes, advance.
  useAnimatedReaction(
    () => progress.value,
    (value, previous) => {
      if (previous !== null && previous < 1 && value >= 1) {
        runOnJS(goNext)();
      }
    },
    [goNext]
  );

  // Tap handler — left half goes back, right half forward.
  const handleTap = useCallback(
    (x: number) => {
      if (x < SCREEN_WIDTH / 3) {
        goPrev();
      } else {
        goNext();
      }
    },
    [goNext, goPrev]
  );

  // Gestures.
  const tapGesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(250)
        .onEnd((e) => {
          runOnJS(handleTap)(e.x);
        }),
    [handleTap]
  );

  const longPressGesture = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(200)
        .onStart(() => {
          runOnJS(setPaused)(true);
        })
        .onEnd(() => {
          runOnJS(setPaused)(false);
        })
        .onTouchesCancelled(() => {
          runOnJS(setPaused)(false);
        }),
    []
  );

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(20)
        .onEnd((e) => {
          if (e.translationY > 80 || e.velocityY > 800) {
            runOnJS(onClose)();
          }
        }),
    [onClose]
  );

  const composedGesture = useMemo(
    () => Gesture.Simultaneous(panGesture, Gesture.Exclusive(longPressGesture, tapGesture)),
    [panGesture, longPressGesture, tapGesture]
  );

  const handleDelete = useCallback(async () => {
    if (!current) return;
    try {
      await deleteStatus(current.id);
      toast.success(t('status.toast.deleted'));
      if (total <= 1) {
        onClose();
      } else if (index >= total - 1) {
        setIndex(Math.max(0, index - 1));
      }
    } catch (error) {
      console.error('[StatusViewer] delete failed:', error);
      toast.error(t('status.error.deleteFailed'));
    }
  }, [current, deleteStatus, t, onClose, total, index]);

  const onVideoDuration = useCallback(
    (durationMs: number) => {
      if (current?.type !== 'video') return;
      startAnimation(durationMs);
    },
    [current?.type, startAnimation]
  );

  if (!visible || !current) {
    return null;
  }

  const displayName = getDisplayName(author);

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
        <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom']}>
          <GestureDetector gesture={composedGesture}>
            <View style={{ flex: 1 }}>
              <View style={styles.media}>
                <StatusMedia
                  status={current}
                  paused={paused}
                  onVideoDuration={onVideoDuration}
                />
                {current.caption ? (
                  <View style={styles.captionOverlay}>
                    <Text style={styles.captionText} numberOfLines={4}>
                      {current.caption}
                    </Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.topOverlay} pointerEvents="box-none">
                <View style={styles.progressRow}>
                  {statuses.map((s, i) => (
                    <ProgressBar
                      key={s.id}
                      isActive={i === index}
                      isComplete={i < index}
                      progress={progress}
                    />
                  ))}
                </View>
                <View style={styles.header}>
                  <Avatar
                    size={36}
                    source={author?.avatar ? { uri: author.avatar } : undefined}
                    label={displayName ? displayName.charAt(0).toUpperCase() : 'U'}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.headerName} numberOfLines={1}>
                      {isOwner ? t('status.viewer.you') : displayName || t('status.unknownUser')}
                    </Text>
                    <Text style={styles.headerMeta}>
                      {formatRelativeLastSeen(current.createdAt, t)}
                    </Text>
                  </View>
                  {isOwner ? (
                    <TouchableOpacity
                      style={styles.iconBtn}
                      onPress={handleDelete}
                      hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                    >
                      <IconComponent name="trash" size={20} color="#FFFFFF" />
                    </TouchableOpacity>
                  ) : null}
                  <TouchableOpacity
                    style={styles.iconBtn}
                    onPress={onClose}
                    hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                  >
                    <IconComponent name="close" size={22} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>
              </View>

              {isOwner ? (
                <View style={styles.bottomOverlay} pointerEvents="box-none">
                  <TouchableOpacity
                    style={styles.viewersPill}
                    onPress={() => {
                      setPaused(true);
                      setViewersOpen(true);
                    }}
                  >
                    <IconComponent name="eye" size={16} color="#FFFFFF" />
                    <Text style={styles.viewersPillText}>
                      {t('status.viewers.count', { count: current.viewers.length })}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          </GestureDetector>
        </SafeAreaView>

        <ViewersSheet
          visible={viewersOpen}
          statusId={current.id}
          onClose={() => {
            setViewersOpen(false);
            setPaused(false);
          }}
        />
      </GestureHandlerRootView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  media: {
    flex: 1,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  captionOverlay: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 80,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  captionText: {
    color: '#FFFFFF',
    fontSize: 14,
    textAlign: 'center',
  },
  topOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  progressRow: {
    flexDirection: 'row',
    gap: 4,
    paddingVertical: 6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  headerName: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 15,
  },
  headerMeta: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginTop: 2,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  bottomOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 16,
    alignItems: 'center',
  },
  viewersPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  viewersPillText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});

export default StatusViewer;
