import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { useStatuses } from '@allo/react';
import { Avatar } from '@oxy.so/bloom/avatar';
import { StoryRing } from '@oxy.so/bloom/chat-indicators';
import { Item } from '@oxy.so/bloom/item';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';

import { StoriesStrip } from '@/components/phase2/StoriesStrip';
import { StoryViewerOverlay } from '@/components/phase2/StoryViewerOverlay';
import { Page } from '@/components/shell/Page';
import { useChatContext } from '@/hooks/useChatContext';
import { readAttachmentBytes } from '@/lib/allo/attachmentBytes';
import { pickMediaAttachments } from '@/lib/chat/attachments';
import { ringState, statusAgeLabel, statusAuthors, statusRemainingLabel } from '@/lib/statuses';
import { confirmDialog } from '@/utils/alerts';
import { logger } from '@/utils/logger';

/**
 * `/updates` — STATUS UPDATES.
 *
 * The route is `/updates`, not `/status`: Metro's dev server answers `/status`
 * itself with `packager-status:running`, so the screen could never be opened or
 * refreshed by URL while developing. The words on screen are still "Status".
 *
 * Bloom's `StoriesRow` at the top, then every person with updates as a row
 * with their own `StoryRing`, and `StoryViewer` over the whole screen once one
 * is opened. Adding your own goes through the app's existing picker
 * (`lib/chat/attachments.ts`) — the same one the composer uses.
 *
 * **What this posts is end-to-end encrypted** (ADR 0002): one ciphertext, a
 * key sealed to each recipient's devices, twenty-four hours. The audience is
 * resolved on THIS device — everybody it shares a conversation with — so the
 * server is never asked for a contact list and never sees the words or the
 * picture. What it does see is which devices a status was sealed to, because
 * that is how it delivers.
 *
 * The viewer still has no reply field: a reply has nowhere to go in this
 * platform, and a field that accepts one and drops it is the lie this screen
 * is written to avoid.
 */
export default function UpdatesScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useOxy();
  const statuses = useStatuses();
  // `/updates?story=<accountId>` opens straight into that person's update: the
  // conversation list's ring links here rather than owning a viewer of its own.
  const { story } = useLocalSearchParams<{ story?: string }>();
  const [viewing, setViewing] = useState<string | null>(story ?? null);
  const [openedFor, setOpenedFor] = useState(story);
  if (story !== openedFor) {
    setOpenedFor(story);
    setViewing(story ?? null);
  }

  const authors = useMemo(() => statusAuthors(statuses.all), [statuses.all]);
  const accountIds = useMemo(() => authors.map((author) => author.accountId), [authors]);
  const { person, now } = useChatContext(accountIds);

  // Opening is all the viewer needs; telling the author it was seen happens
  // there, as each update is actually advanced past.
  const open = useCallback((accountId: string) => setViewing(accountId), []);

  const me = user?.id;
  const add = useCallback(async () => {
    if (!me) return;
    try {
      const picked = await pickMediaAttachments();
      const first = picked[0];
      if (!first) return;
      await statuses.post({
        kind: first.mimetype.startsWith('video/') ? 'video' : 'image',
        media: {
          bytes: await readAttachmentBytes(first.uri),
          mime: first.mimetype,
          width: first.width,
          height: first.height,
        },
        // Everybody this device shares a conversation with. Narrowing that is
        // its own screen and its own change; posting to nobody in particular
        // is not a thing this offers.
        audience: { mode: 'all', accountIds: [] },
      });
      toast.success(t('stories.added'));
    } catch (error: unknown) {
      logger.error('[updates] could not post', error);
      toast.error(t('stories.addFailed'));
    }
  }, [me, statuses, t]);

  /** Taking one of yours down early. A long press, and a confirmation. */
  const remove = useCallback(
    async (statusId: string) => {
      const ok = await confirmDialog({
        title: t('stories.remove.title'),
        message: t('stories.remove.confirm'),
        okText: t('stories.remove.action'),
        cancelText: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await statuses.remove(statusId);
      } catch (error: unknown) {
        logger.error('[updates] could not take one down', error);
        toast.error(t('stories.removeFailed'));
      }
    },
    [statuses, t],
  );

  return (
    <>
      <Page title={t('stories.title')}>
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
              const name = author.mine ? t('stories.own') : (who?.displayName ?? t('stories.someone'));
              return (
                <Item
                  key={author.accountId}
                  title={name}
                  // i18next picks `stories.updateCount_one` or `_other` from `count`.
                  subtitle={t('stories.updateCount', {
                    count: author.statuses.length,
                    age: statusAgeLabel(author.statuses[0].createdAt, now, t),
                  })}
                  leading={
                    <StoryRing state={ringState(author)} size={40}>
                      <Avatar source={who?.avatar} name={name} size={40} />
                    </StoryRing>
                  }
                  onPress={() => open(author.accountId)}
                  onLongPress={author.mine ? () => void remove(author.statuses[0].id) : undefined}
                  accessibilityLabel={t('stories.openOf', { name })}
                />
              );
            })
          )}
        </View>

        <Muted style={styles.expiry}>
          {authors[0]?.mine
            ? t('stories.yoursExpire', {
                remaining: statusRemainingLabel(authors[0].statuses[0].expiresAt, now, t),
              })
            : t('stories.expiry')}
        </Muted>
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
