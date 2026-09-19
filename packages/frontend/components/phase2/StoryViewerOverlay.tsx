import React, { useCallback, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useStatuses, type StatusView } from '@allo/react';
import { StoryViewer, type StoryItem } from '@oxy.so/bloom/chat-people';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted, Text } from '@oxy.so/bloom/typography';

import { useChatContext } from '@/hooks/useChatContext';
import { useStatusMedia } from '@/lib/allo/useStatusMedia';
import { firstUnseenIndex, statusAgeLabel, type StatusAuthor } from '@/lib/statuses';
import { logger } from '@/utils/logger';

interface StoryViewerOverlayProps {
  /** The authors the viewer walks through, in the order the row shows them. */
  authors: readonly StatusAuthor[];
  /** Which one opened it. */
  startAccountId: string;
  onClose: () => void;
}

/**
 * THE STATUS VIEWER, over the screen that opened it.
 *
 * Bloom's `StoryViewer` owns the chrome, the tap zones and the progress strip;
 * everything below is the app's half of the contract it documents. `index` is
 * controlled and the viewer never advances itself, so running off the end of
 * one person's updates moves to the next person here, and running off the last
 * one closes. Hold-to-pause is the host's gesture — Bloom refuses to claim a
 * long press it would have to fight the surrounding surface for — so the
 * `Pressable` below binds it and passes `paused` down.
 *
 * **There is no reply composer and there are no reactions.** `StoryViewer` has
 * both, and they are left off: a reply to a status has nowhere to go in this
 * platform yet, and a field that accepts one and drops it is the lie these
 * screens are written to avoid.
 *
 * Seeing one is TOLD to its author, from the handlers rather than an effect,
 * so what the reader actually advanced past is what is reported. Whether the
 * viewer's name travels with that is the viewer's own setting, decided on the
 * server.
 */
export function StoryViewerOverlay({ authors, startAccountId, onClose }: StoryViewerOverlayProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const statuses = useStatuses();

  const startIndex = Math.max(
    0,
    authors.findIndex((author) => author.accountId === startAccountId),
  );
  const [authorIndex, setAuthorIndex] = useState(startIndex);
  const [slideIndex, setSlideIndex] = useState(() =>
    firstUnseenIndex(authors.find((author) => author.accountId === startAccountId)),
  );
  const [held, setHeld] = useState(false);

  const author = authors[authorIndex];
  const accountIds = useMemo(() => authors.map((one) => one.accountId), [authors]);
  const { person, now } = useChatContext(accountIds);
  const slides = useMemo(() => author?.statuses ?? [], [author]);
  const slide: StatusView | undefined = slides[slideIndex];

  const items = useMemo<StoryItem[]>(
    () =>
      slides.map((one, index) => ({
        id: one.id,
        // Only the one on screen is fetched; a person with six updates
        // downloads one picture, not six.
        media: <SlideMedia status={one} active={index === slideIndex} label={t('stories.noPicture')} />,
      })),
    [slideIndex, slides, t],
  );

  const show = useCallback(
    (nextAuthor: number, nextSlide: number) => {
      const target = authors[nextAuthor];
      if (!target) {
        onClose();
        return;
      }
      const targetSlide = target.statuses[nextSlide];
      if (targetSlide && !targetSlide.seen) {
        void statuses.view(targetSlide.id).catch((error: unknown) => {
          // A receipt that does not go out is not worth a toast.
          logger.debug('[status] view receipt failed', error);
        });
      }
      setAuthorIndex(nextAuthor);
      setSlideIndex(nextSlide);
    },
    [authors, onClose, statuses],
  );

  const next = useCallback(() => {
    if (!author) return onClose();
    if (slideIndex + 1 < author.statuses.length) return show(authorIndex, slideIndex + 1);
    if (authorIndex + 1 < authors.length) return show(authorIndex + 1, 0);
    return onClose();
  }, [author, authorIndex, authors.length, onClose, show, slideIndex]);

  const previous = useCallback(() => {
    if (slideIndex > 0) return show(authorIndex, slideIndex - 1);
    if (authorIndex > 0) {
      const earlier = authors[authorIndex - 1];
      return show(authorIndex - 1, Math.max(0, earlier.statuses.length - 1));
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
          time={statusAgeLabel(slide.createdAt, now, t)}
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
 * One update: its picture once it has been fetched and decrypted, or its words
 * when that is all it is.
 */
function SlideMedia({ status, active, label }: { status: StatusView; active: boolean; label: string }) {
  const theme = useTheme();
  const { uri } = useStatusMedia(status.hasMedia ? status.id : undefined, active);

  if (!status.hasMedia) {
    return (
      <View style={[styles.blank, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <Text variant="title-2-semibold" style={styles.words}>
          {status.caption}
        </Text>
      </View>
    );
  }
  if (!uri) {
    return (
      <View style={[styles.blank, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <Muted style={styles.blankText}>{label}</Muted>
      </View>
    );
  }
  return (
    <View style={styles.media}>
      <Image source={{ uri }} style={styles.media} resizeMode="contain" accessible={false} />
      {status.caption ? (
        <View style={[styles.caption, { backgroundColor: theme.colors.overlay ?? 'rgba(0,0,0,0.45)' }]}>
          <Text variant="body-regular" style={styles.captionText}>
            {status.caption}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 20 },
  hold: { flex: 1 },
  media: { width: '100%', height: '100%' },
  blank: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  blankText: { textAlign: 'center' },
  words: { textAlign: 'center' },
  caption: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16 },
  captionText: { textAlign: 'center' },
});
