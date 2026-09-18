import React, { useCallback, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StoryViewer, type StoryItem } from '@oxy.so/bloom/chat-people';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted } from '@oxy.so/bloom/typography';

import { useChatContext } from '@/hooks/useChatContext';
import {
  firstUnseenIndex,
  storyAgeLabel,
  useStoriesStore,
  useStoryAuthors,
  type StoryAuthor,
  type StorySlide,
} from '@/lib/phase2/stories';

interface StoryViewerOverlayProps {
  /** The authors the viewer walks through, in the order the row shows them. */
  authors: readonly StoryAuthor[];
  /** Which one opened it. */
  startAccountId: string;
  onClose: () => void;
}

/**
 * THE STORY VIEWER, over the screen that opened it.
 *
 * Bloom's `StoryViewer` owns the chrome, the tap zones and the progress strip;
 * everything below is the app's half of the contract it documents. `index` is
 * controlled and the viewer never advances itself, so running off the end of
 * one person's story moves to the next person here, and running off the last
 * one closes. Hold-to-pause is the host's gesture — Bloom refuses to claim a
 * long press it would have to fight the surrounding surface for — so the
 * `Pressable` below binds it and passes `paused` down.
 *
 * **There is no reply composer and there are no reactions.** `StoryViewer` has
 * both, and they are left off on purpose: nothing here can deliver a reply, and
 * a field that accepts one and drops it is the exact lie these screens are
 * written to avoid.
 *
 * Seen state is marked from the handlers rather than an effect, so what the
 * reader actually advanced past is what gets marked.
 */
export function StoryViewerOverlay({ authors, startAccountId, onClose }: StoryViewerOverlayProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const byAccountId = useStoryAuthors();
  const markSeen = useStoriesStore((state) => state.markSeen);

  const startIndex = Math.max(
    0,
    authors.findIndex((author) => author.accountId === startAccountId),
  );
  const [authorIndex, setAuthorIndex] = useState(startIndex);
  const [slideIndex, setSlideIndex] = useState(() =>
    firstUnseenIndex(byAccountId[startAccountId]),
  );
  const [held, setHeld] = useState(false);

  const author = authors[authorIndex];
  const accountIds = useMemo(() => authors.map((one) => one.accountId), [authors]);
  const { person, now } = useChatContext(accountIds);
  const slides = useMemo(() => author?.slides ?? [], [author]);
  const slide: StorySlide | undefined = slides[slideIndex];

  const items = useMemo<StoryItem[]>(
    () =>
      slides.map((one) => ({
        id: one.id,
        duration: one.durationMs,
        media: <SlideMedia slide={one} label={t('stories.noPicture')} />,
      })),
    [slides, t],
  );

  const show = useCallback(
    (nextAuthor: number, nextSlide: number) => {
      const target = authors[nextAuthor];
      if (!target) {
        onClose();
        return;
      }
      const targetSlide = target.slides[nextSlide];
      if (targetSlide) markSeen(target.accountId, targetSlide.id);
      setAuthorIndex(nextAuthor);
      setSlideIndex(nextSlide);
    },
    [authors, markSeen, onClose],
  );

  const next = useCallback(() => {
    if (!author) return onClose();
    if (slideIndex + 1 < author.slides.length) return show(authorIndex, slideIndex + 1);
    if (authorIndex + 1 < authors.length) return show(authorIndex + 1, 0);
    return onClose();
  }, [author, authorIndex, authors.length, onClose, show, slideIndex]);

  const previous = useCallback(() => {
    if (slideIndex > 0) return show(authorIndex, slideIndex - 1);
    if (authorIndex > 0) {
      const earlier = authors[authorIndex - 1];
      return show(authorIndex - 1, Math.max(0, earlier.slides.length - 1));
    }
    return show(authorIndex, 0);
  }, [authorIndex, authors, show, slideIndex]);

  if (!author || !slide) return null;

  const who = person(author.accountId);

  return (
    <View
      style={[styles.root, { backgroundColor: theme.colors.background }]}
      // The viewer is the whole screen while it is open: what is underneath is
      // not reachable, and announcing it would read as a second page.
      accessibilityViewIsModal
    >
      <Pressable
        style={styles.hold}
        onLongPress={() => setHeld(true)}
        onPressOut={() => setHeld(false)}
        // The long press is a modifier on the viewer's own tap zones, which
        // carry the names; this wrapper has nothing of its own to announce.
        accessible={false}
      >
        <StoryViewer
          stories={items}
          index={slideIndex}
          paused={held}
          onNext={next}
          onPrevious={previous}
          onClose={onClose}
          name={who?.displayName ?? t('stories.someone')}
          avatar={who?.avatar}
          time={storyAgeLabel(slide.createdAt, now.getTime(), t)}
          labels={{
            close: t('common.close'),
            previous: t('stories.previous'),
            next: t('stories.next'),
            progress: (index, count) => t('stories.progress', { index: index + 1, count }),
          }}
        />
      </Pressable>
    </View>
  );
}

/**
 * One slide's picture — or, for a sample slide that has none, a surface saying
 * so. Nothing is fetched: a slide added from the picker is a local URI and a
 * sample slide has no bytes at all.
 */
function SlideMedia({ slide, label }: { slide: StorySlide; label: string }) {
  const theme = useTheme();
  if (slide.uri === undefined) {
    return (
      <View style={[styles.blank, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <Muted style={styles.blankText}>{label}</Muted>
      </View>
    );
  }
  return (
    <Image source={{ uri: slide.uri }} style={styles.media} resizeMode="contain" accessible={false} />
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20 },
  hold: { flex: 1 },
  media: { width: '100%', height: '100%' },
  blank: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  blankText: { textAlign: 'center' },
});
