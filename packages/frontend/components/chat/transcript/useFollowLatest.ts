import { useCallback, useEffect, useRef } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

/** How close to the end still counts as reading the newest message. */
const AT_END_PX = 24;

interface FollowLatestOptions {
  /** The newest item's id, and whether this account sent it. */
  newest: { id: string; own: boolean } | undefined;
  /** Puts the scroller at its end. */
  scrollToEnd: (animated: boolean) => void;
}

/**
 * Whether the transcript FOLLOWS the newest message, and the scroller props
 * that keep it there.
 *
 * Only the reader's own scrolling (a drag, or the momentum after one) decides
 * that they stopped following. Every scroll event used to: Android reports one
 * when the viewport shrinks (the keyboard, the reply banner), the newest
 * message then sat below the fold, the transcript concluded the reader had
 * scrolled away, and a message just SENT stayed out of sight (Pixel 8a).
 *
 * While following, a change of content (a new message) or of viewport (the
 * keyboard) pins the end. A message this account sends follows it whatever the
 * position, as every messenger does: the sender is looking at what they sent.
 */
export function useFollowLatest({ newest, scrollToEnd }: FollowLatestOptions) {
  const following = useRef(true);
  const userScrolling = useRef(false);
  const newestId = useRef(newest?.id);

  useEffect(() => {
    if (!newest || newest.id === newestId.current) return;
    newestId.current = newest.id;
    if (newest.own) following.current = true;
    if (following.current) scrollToEnd(false);
  }, [newest, scrollToEnd]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!userScrolling.current) return;
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    following.current = contentSize.height - layoutMeasurement.height - contentOffset.y < AT_END_PX;
  }, []);

  const pinIfFollowing = useCallback(() => {
    if (following.current) scrollToEnd(false);
  }, [scrollToEnd]);

  const startUserScroll = useCallback(() => {
    userScrolling.current = true;
  }, []);
  const endUserScroll = useCallback(() => {
    userScrolling.current = false;
  }, []);

  /** The jump button: the reader asked for the end, so they follow it again. */
  const jumpToEnd = useCallback(() => {
    following.current = true;
    scrollToEnd(true);
  }, [scrollToEnd]);

  return {
    jumpToEnd,
    /** Spread onto the ScrollView; `onScroll` composes with the caller's own. */
    scrollProps: {
      onScrollBeginDrag: startUserScroll,
      onScrollEndDrag: endUserScroll,
      onMomentumScrollBegin: startUserScroll,
      onMomentumScrollEnd: endUserScroll,
      onContentSizeChange: pinIfFollowing,
      onLayout: pinIfFollowing,
    },
    onScroll,
    /** For tests and callers that need to read it. */
    isFollowing: () => following.current,
  };
}
