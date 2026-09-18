import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { Avatar } from '@oxy.so/bloom/avatar';
import { StoryRing } from '@oxy.so/bloom/chat-indicators';
import { Item } from '@oxy.so/bloom/item';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';

import { NotConnectedNotice } from '@/components/phase2/NotConnectedNotice';
import { StoriesStrip } from '@/components/phase2/StoriesStrip';
import { StoryViewerOverlay } from '@/components/phase2/StoryViewerOverlay';
import { Page } from '@/components/shell/Page';
import { useChatContext } from '@/hooks/useChatContext';
import { pickMediaAttachments } from '@/lib/chat/attachments';
import {
  activeAuthors,
  firstUnseenIndex,
  ringState,
  slidesFromAttachments,
  storyAgeLabel,
  latestAt,
  useStoriesStore,
  useStoryAuthors,
  useStoryOrder,
} from '@/lib/phase2/stories';
import { logger } from '@/utils/logger';

/**
 * `/updates` — STATUS UPDATES.
 *
 * The route is `/updates`, not `/status`: Metro's dev server answers `/status`
 * itself with `packager-status:running`, so the screen could never be opened or
 * refreshed by URL while developing. The words on screen are still "Status".
 *
 * Bloom's `StoriesRow` at the top, then every update as a row with its own
 * `StoryRing`, and `StoryViewer` over the whole screen once one is opened.
 * Adding your own goes through the app's existing picker
 * (`lib/chat/attachments.ts`) — the same one the composer uses — and the picked
 * file stays exactly where the picker put it.
 *
 * **Nothing here is posted to anybody.** The updates are sample data held in
 * this tab, adding one keeps a local URI in memory, and "seen" is a fact this
 * device knows and nobody else does. The notice at the top says so, and the
 * viewer deliberately has no reply field: a status update that accepted a reply
 * and dropped it would be the worst version of this screen.
 */
export default function UpdatesScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useOxy();
  const byAccountId = useStoryAuthors();
  const order = useStoryOrder();
  const addSlides = useStoriesStore((state) => state.addSlides);
  const markSeen = useStoriesStore((state) => state.markSeen);
  // `/updates?story=<accountId>` opens straight into that person's update: the
  // conversation list's ring links here rather than owning a viewer of its own.
  const { story } = useLocalSearchParams<{ story?: string }>();
  const [viewing, setViewing] = useState<string | null>(story ?? null);
  const [openedFor, setOpenedFor] = useState(story);
  if (story !== openedFor) {
    setOpenedFor(story);
    setViewing(story ?? null);
  }

  const authors = useMemo(() => activeAuthors(byAccountId, order), [byAccountId, order]);
  const accountIds = useMemo(() => authors.map((author) => author.accountId), [authors]);
  const { person, now } = useChatContext(accountIds);

  const open = useCallback(
    (accountId: string) => {
      const author = byAccountId[accountId];
      const slide = author?.slides[firstUnseenIndex(author)];
      if (slide) markSeen(accountId, slide.id);
      setViewing(accountId);
    },
    [byAccountId, markSeen],
  );

  const me = user?.id;
  const add = useCallback(async () => {
    if (!me) return;
    try {
      const picked = await pickMediaAttachments();
      const slides = slidesFromAttachments(picked);
      if (slides.length === 0) return;
      addSlides(me, slides);
      toast.success(t('stories.added'));
    } catch (error: unknown) {
      logger.error('[updates] could not read what was picked', error);
      toast.error(t('stories.addFailed'));
    }
  }, [addSlides, me, t]);

  return (
    <>
      <Page title={t('stories.title')}>
        <NotConnectedNotice>{t('stories.notice')}</NotConnectedNotice>

        <View style={styles.strip}>
          <StoriesStrip ownAccountId={me} onStoryPress={open} onOwnPress={add} />
        </View>

        <View style={styles.list}>
          <Text variant="caption-1-semibold" style={{ color: theme.colors.textSecondary }}>
            {t('stories.recent')}
          </Text>
          {authors.length === 0 ? (
            <Muted style={styles.empty}>{t('stories.empty')}</Muted>
          ) : (
            authors.map((author) => {
              const who = person(author.accountId);
              const name =
                author.accountId === me ? t('stories.own') : (who?.displayName ?? t('stories.someone'));
              return (
                <Item
                  key={author.accountId}
                  title={name}
                  // i18next picks `stories.updateCount_one` or `_other` from `count`.
                  subtitle={t('stories.updateCount', {
                    count: author.slides.length,
                    age: storyAgeLabel(latestAt(author), now.getTime(), t),
                  })}
                  leading={
                    <StoryRing state={ringState(author)} size={40}>
                      <Avatar source={who?.avatar} name={name} size={40} />
                    </StoryRing>
                  }
                  onPress={() => open(author.accountId)}
                  accessibilityLabel={t('stories.openOf', { name })}
                />
              );
            })
          )}
        </View>

        <Muted style={styles.expiry}>{t('stories.expiry')}</Muted>
      </Page>
      {viewing === null ? null : (
        <StoryViewerOverlay
          authors={authors}
          startAccountId={viewing}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  strip: { marginHorizontal: -16 },
  list: { gap: 4 },
  empty: { paddingVertical: 16 },
  expiry: { paddingTop: 8 },
});
