import React, { memo, useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type AnimatedStyle,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxyhq/bloom/toast';

import { ThemedText } from '@/components/ThemedText';
import { CloseIcon } from '@/assets/icons/close-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { clampViewerIndex, type ViewerItem, type ViewerSelection } from '@/lib/chat/attachmentViewer';
import type { MediaItem } from '@/stores';
import { logger } from '@/utils/logger';
import { mimetypeFromFilename } from '@/utils/mimetypes';

import { isWithinViewerWindow, nextPageIndex, pageOffset } from './pager';
import { shareAttachment } from './shareAttachment';
import { AttachmentViewerVideo } from './AttachmentViewerVideo';
import {
  backdropOpacity,
  clampPan,
  clampZoom,
  doubleTapZoom,
  focalTranslation,
  isZoomedIn,
  panBound,
  shouldDismiss,
  MIN_ZOOM,
} from './zoom';

/**
 * An attachment, full size.
 *
 * **Not a Matrix feature.** Everything it draws comes from `Message.media`,
 * which both backends fill, and every URL it shows comes from the one resolver
 * `ConversationView` already reconciles — so a conversation on the Express API
 * opens the same viewer with the same gestures. Nothing here knows which
 * backend it is looking at, and nothing here may learn: an `import` of
 * `CHAT_BACKEND` in this file would be the beginning of a second viewer.
 *
 * The pager is a row of pages this component translates itself rather than a
 * native scroll view. A scroll view inside a modal, wrapping a view that also
 * wants pinch and pan, is a three-way gesture negotiation that resolves
 * differently on each platform; owning the translation makes the whole thing one
 * `react-native-gesture-handler` composition, and makes where a swipe lands
 * arithmetic — which lives in `pager.ts` and is tested there, as the zoom and
 * dismissal arithmetic lives in `zoom.ts`.
 *
 * **State resets by remounting.** The component takes its opening page as a
 * prop and never watches it: the caller gives the element a `key` derived from
 * what was tapped, so tapping a second picture builds a second viewer rather
 * than pushing a new index into this one from an Effect.
 */

export interface AttachmentViewerProps {
  /** The gallery and the page it opens on. See `lib/chat/attachmentViewer.ts`. */
  readonly selection: ViewerSelection;
  /**
   * A media id to a local URI, or `''` while there is not one yet.
   *
   * The same resolver the bubbles use, and **asking is what starts the
   * download** — which is why only the pages inside the window built by
   * {@link isWithinViewerWindow} ever ask.
   */
  readonly resolveUrl: (mediaId: string, kind: MediaItem['type']) => string;
  readonly onClose: () => void;
}

/** How long a page turn or a spring back takes. */
const SNAP_DURATION = 220;

export const AttachmentViewer = memo<AttachmentViewerProps>(
  ({ selection, resolveUrl, onClose }) => {
    const { t } = useTranslation();
    // Named `viewport`, not `window`: on web `window` is a global, and a local
    // that shadows it makes every later line ambiguous to read.
    const viewport = useWindowDimensions();

    const items = selection.items;
    const [index, setIndex] = useState(() =>
      clampViewerIndex(selection.index, items.length),
    );
    // Whether the picture on screen is zoomed in. Lives in React state as well
    // as in `scale` because it decides which gestures are enabled, and that is
    // a prop of a gesture object built during render.
    const [zoomed, setZoomed] = useState(false);
    // The window's width until the pager has been laid out. Both agree in every
    // ordinary case; the layout is what makes a split-screen or a resized
    // browser window right.
    const [pageWidth, setPageWidth] = useState(viewport.width);

    const pageX = useSharedValue(pageOffset(index, viewport.width));
    const dragY = useSharedValue(0);
    const scale = useSharedValue(MIN_ZOOM);
    const panX = useSharedValue(0);
    const panY = useSharedValue(0);
    const gestureStartScale = useSharedValue(MIN_ZOOM);
    const gestureStartPanX = useSharedValue(0);
    const gestureStartPanY = useSharedValue(0);

    const active: ViewerItem | undefined = items[index];

    /**
     * Settles on a page: puts the row where that page is, and un-zooms.
     *
     * Both halves have to happen together. A page turn that left the previous
     * picture magnified would open the next one at 3× and off-centre, and the
     * pan gesture that would fix it is the one turning zoom off.
     */
    const settleOn = useCallback(
      (next: number) => {
        setIndex(next);
        setZoomed(false);
        scale.value = withTiming(MIN_ZOOM, { duration: SNAP_DURATION });
        panX.value = withTiming(0, { duration: SNAP_DURATION });
        panY.value = withTiming(0, { duration: SNAP_DURATION });
      },
      [scale, panX, panY],
    );

    const handleLayout = useCallback(
      (event: LayoutChangeEvent) => {
        const width = event.nativeEvent.layout.width;
        if (width <= 0 || width === pageWidth) {
          return;
        }
        setPageWidth(width);
        // A rotation or a resized window moves every page. Without this the row
        // would stay where the old width put it until the next swipe, showing
        // two half pages.
        pageX.value = pageOffset(index, width);
      },
      [index, pageWidth, pageX],
    );

    const handleShare = useCallback(() => {
      if (active === undefined) {
        return;
      }
      const uri = resolveUrl(active.mediaId, active.kind);
      if (uri === '') {
        toast.error(t('This attachment is still downloading.'));
        return;
      }
      const filename = active.filename ?? t('attachment');
      shareAttachment({ uri, filename, mimetype: mimetypeFromFilename(filename) })
        .then((outcome) => {
          if (outcome === 'unavailable') {
            toast.error(t('Sharing is not available on this device.'));
          }
        })
        .catch((error: unknown) => {
          logger.error('[media] an attachment could not be shared', error);
          toast.error(t('The attachment could not be shared.'));
        });
    }, [active, resolveUrl, t]);

    /* -------------------------------------------------------------------
     * Gestures
     *
     * Raced rather than nested: at most one of "turn the page", "drag the
     * viewer away" and "move the magnified picture" can be what a drag means,
     * and which one it is falls out of the axis it starts on and whether the
     * picture is zoomed. Pinch runs alongside the pan that moves a zoomed
     * picture, because a two-finger gesture is usually both.
     *
     * The pan bounds are computed from the **page**, not from the picture drawn
     * inside it. `contentFit="contain"` letterboxes a portrait photograph in a
     * landscape page, so the real content is narrower than the page and the true
     * bound is smaller than the one used here. Knowing it would mean carrying
     * each attachment's intrinsic dimensions through the view model, and the
     * error is in the forgiving direction: a magnified picture can be dragged a
     * little further than it strictly needs to be, rather than stopping before
     * its own edge is reachable.
     * ----------------------------------------------------------------- */

    const pinch = useMemo(
      () =>
        Gesture.Pinch()
          .onStart(() => {
            gestureStartScale.value = scale.value;
          })
          .onUpdate((event) => {
            const next = clampZoom(gestureStartScale.value * event.scale);
            // The focal point arrives measured from the view's top-left; the
            // arithmetic works from its centre.
            const focalX = event.focalX - pageWidth / 2;
            const focalY = event.focalY - viewport.height / 2;
            panX.value = focalTranslation(panX.value, focalX, scale.value, next);
            panY.value = focalTranslation(panY.value, focalY, scale.value, next);
            scale.value = next;
          })
          .onEnd(() => {
            if (!isZoomedIn(scale.value)) {
              scale.value = withTiming(MIN_ZOOM, { duration: SNAP_DURATION });
              panX.value = withTiming(0, { duration: SNAP_DURATION });
              panY.value = withTiming(0, { duration: SNAP_DURATION });
              runOnJS(setZoomed)(false);
              return;
            }
            panX.value = clampPan(
              panX.value,
              panBound(pageWidth, scale.value, pageWidth),
            );
            panY.value = clampPan(
              panY.value,
              panBound(viewport.height, scale.value, viewport.height),
            );
            runOnJS(setZoomed)(true);
          }),
      [gestureStartScale, panX, panY, scale, pageWidth, viewport.height],
    );

    const doubleTap = useMemo(
      () =>
        Gesture.Tap()
          .numberOfTaps(2)
          .maxDuration(300)
          .onEnd(() => {
            const next = doubleTapZoom(scale.value);
            scale.value = withTiming(next, { duration: SNAP_DURATION });
            panX.value = withTiming(0, { duration: SNAP_DURATION });
            panY.value = withTiming(0, { duration: SNAP_DURATION });
            runOnJS(setZoomed)(isZoomedIn(next));
          }),
      [panX, panY, scale],
    );

    const movePicture = useMemo(
      () =>
        Gesture.Pan()
          .maxPointers(1)
          .enabled(zoomed)
          .onStart(() => {
            gestureStartPanX.value = panX.value;
            gestureStartPanY.value = panY.value;
          })
          .onUpdate((event) => {
            panX.value = clampPan(
              gestureStartPanX.value + event.translationX,
              panBound(pageWidth, scale.value, pageWidth),
            );
            panY.value = clampPan(
              gestureStartPanY.value + event.translationY,
              panBound(viewport.height, scale.value, viewport.height),
            );
          }),
      [gestureStartPanX, gestureStartPanY, panX, panY, scale, zoomed, pageWidth, viewport.height],
    );

    const turnPage = useMemo(
      () =>
        Gesture.Pan()
          .maxPointers(1)
          .enabled(!zoomed)
          .activeOffsetX([-12, 12])
          .failOffsetY([-16, 16])
          .onUpdate((event) => {
            pageX.value = pageOffset(index, pageWidth) + event.translationX;
          })
          .onEnd((event) => {
            const next = nextPageIndex(
              index,
              event.translationX,
              event.velocityX,
              pageWidth,
              items.length,
            );
            pageX.value = withTiming(pageOffset(next, pageWidth), {
              duration: SNAP_DURATION,
            });
            if (next !== index) {
              runOnJS(settleOn)(next);
            }
          }),
      [index, items.length, pageWidth, pageX, settleOn, zoomed],
    );

    const dragAway = useMemo(
      () =>
        Gesture.Pan()
          .maxPointers(1)
          .enabled(!zoomed)
          .activeOffsetY([-12, 12])
          .failOffsetX([-16, 16])
          .onUpdate((event) => {
            dragY.value = event.translationY;
          })
          .onEnd((event) => {
            if (shouldDismiss(event.translationY, event.velocityY)) {
              runOnJS(onClose)();
              return;
            }
            dragY.value = withTiming(0, { duration: SNAP_DURATION });
          }),
      [dragY, onClose, zoomed],
    );

    const gesture = useMemo(
      () =>
        Gesture.Race(
          doubleTap,
          Gesture.Simultaneous(pinch, movePicture),
          turnPage,
          dragAway,
        ),
      [doubleTap, pinch, movePicture, turnPage, dragAway],
    );

    const rowStyle = useAnimatedStyle(() => ({
      transform: [{ translateX: pageX.value }, { translateY: dragY.value }],
    }));

    const backdropStyle = useAnimatedStyle(() => ({
      opacity: backdropOpacity(dragY.value),
    }));

    const zoomStyle = useAnimatedStyle<ViewStyle>(() => ({
      transform: [
        { translateX: panX.value },
        { translateY: panY.value },
        { scale: scale.value },
      ],
    }));

    return (
      <Modal
        visible
        transparent
        animationType="fade"
        // Android's back button. Without it the only way out of the viewer on
        // Android is the close button, and a back press leaves the screen
        // underneath instead.
        onRequestClose={onClose}
        statusBarTranslucent
      >
        <GestureHandlerRootView style={styles.root}>
          <Animated.View style={[styles.backdrop, backdropStyle]} />
          <GestureDetector gesture={gesture}>
            <View style={styles.root} onLayout={handleLayout}>
              <Animated.View style={[styles.row, { width: pageWidth * items.length }, rowStyle]}>
                {items.map((item, itemIndex) => (
                  <View key={item.key} style={[styles.page, { width: pageWidth }]}>
                    {isWithinViewerWindow(itemIndex, index) ? (
                      <ViewerPage
                        item={item}
                        resolveUrl={resolveUrl}
                        isActive={itemIndex === index}
                        zoomStyle={itemIndex === index ? zoomStyle : undefined}
                      />
                    ) : null}
                  </View>
                ))}
              </Animated.View>
            </View>
          </GestureDetector>

          <SafeAreaView style={styles.chrome} edges={['top']} pointerEvents="box-none">
            <View style={styles.chromeBar} pointerEvents="box-none">
              <TouchableOpacity
                onPress={onClose}
                style={styles.chromeButton}
                hitSlop={CHROME_HIT_SLOP}
                accessibilityRole="button"
                accessibilityLabel={t('Close')}
              >
                <CloseIcon size={22} color={CHROME_FOREGROUND} />
              </TouchableOpacity>

              <View style={styles.chromeTitle} pointerEvents="none">
                <ThemedText numberOfLines={1} style={styles.chromeTitleText}>
                  {active?.filename ?? ''}
                </ThemedText>
                {items.length > 1 && (
                  <ThemedText style={styles.chromeCounter}>
                    {t('{{position}} of {{total}}', {
                      position: index + 1,
                      total: items.length,
                    })}
                  </ThemedText>
                )}
              </View>

              <TouchableOpacity
                onPress={handleShare}
                style={styles.chromeButton}
                hitSlop={CHROME_HIT_SLOP}
                accessibilityRole="button"
                accessibilityLabel={t('Share')}
              >
                <ShareIcon size={22} color={CHROME_FOREGROUND} />
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </GestureHandlerRootView>
      </Modal>
    );
  },
);

AttachmentViewer.displayName = 'AttachmentViewer';

interface ViewerPageProps {
  readonly item: ViewerItem;
  readonly resolveUrl: (mediaId: string, kind: MediaItem['type']) => string;
  readonly isActive: boolean;
  /** Only the page on screen is magnified; the neighbours are drawn at rest. */
  readonly zoomStyle: AnimatedStyle<ViewStyle> | undefined;
}

/**
 * One page.
 *
 * The preview underneath is the copy the bubble already drew — already
 * downloaded, already decrypted, already in the cache. Without it the viewer
 * opens on black for as long as a full-size photograph takes to arrive over a
 * connection the user may not have.
 */
const ViewerPage = memo<ViewerPageProps>(({ item, resolveUrl, isActive, zoomStyle }) => {
  const { t } = useTranslation();
  const fullUri = resolveUrl(item.mediaId, item.kind);
  const previewUri = item.previewId === undefined ? '' : resolveUrl(item.previewId, item.kind);

  if (item.kind === 'video') {
    return (
      <AttachmentViewerVideo uri={fullUri} previewUri={previewUri} isActive={isActive} />
    );
  }

  return (
    <Animated.View style={[styles.pageContent, zoomStyle]}>
      {previewUri !== '' && fullUri === '' && (
        <Image
          source={{ uri: previewUri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          accessibilityLabel={t('Preview while the full picture downloads')}
        />
      )}
      {fullUri === '' ? (
        <ActivityIndicator color={CHROME_FOREGROUND} />
      ) : (
        <Image
          source={{ uri: fullUri }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          // No `cachePolicy`: on the Matrix path these bytes are a decrypted
          // copy of a picture from an encrypted conversation, and expo-image's
          // disk cache would write it somewhere the media cache cannot release.
          cachePolicy="memory"
          accessibilityLabel={item.filename ?? t('Attachment')}
        />
      )}
    </Animated.View>
  );
});

ViewerPage.displayName = 'ViewerPage';

/**
 * The one colour in this file that is not from the theme, and why.
 *
 * A viewer is a black room: the backdrop is opaque black in both themes because
 * the point is that nothing but the picture is lit, so the only legible
 * foreground is white. A themed text colour here would be dark-on-black half the
 * time. Everything outside this component still uses `theme.colors`.
 */
const CHROME_FOREGROUND = '#FFFFFF';
const CHROME_HIT_SLOP = { top: 10, bottom: 10, left: 10, right: 10 };

/**
 * Written out rather than `StyleSheet.absoluteFillObject`.
 *
 * NativeWind's `StyleSheet` replaces React Native's and does not carry that
 * field, so spreading it here is a compile error in this project and an easy one
 * to reintroduce by copying from anywhere else.
 */
const FILL = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: 'hidden',
  },
  backdrop: {
    ...FILL,
    backgroundColor: '#000000',
  },
  row: {
    // `height`, not `flex: 1`: the row carries an explicit width of every page
    // laid end to end, and `flex` would put a shrink factor on it.
    height: '100%',
    flexDirection: 'row',
  },
  page: {
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageContent: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  chromeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 8,
  },
  chromeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chromeTitle: {
    flex: 1,
    alignItems: 'center',
  },
  chromeTitleText: {
    color: CHROME_FOREGROUND,
    fontSize: 15,
    fontWeight: '600',
  },
  chromeCounter: {
    color: CHROME_FOREGROUND,
    fontSize: 12,
    opacity: 0.75,
  },
});
