import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { FlashList, type FlashListRef, type ListRenderItem } from '@shopify/flash-list';
import type { TimelineItemView } from '@allo/core';
import {
  bubblePositions,
  DateSeparator,
  MessageGroup,
  SystemMessage,
  TypingBubble,
  UnreadSeparator,
  groupMessages,
  type MessageBubbleLabels,
  type MessageListEntry,
  type MessageListItem,
} from '@oxy.so/bloom/message-bubble';
import { ChatDateHeader, ScrollToBottomButton } from '@oxy.so/bloom/chat-screen';

import { MessageRow, type MessageActions } from './MessageRow';

/**
 * A run longer than this is drawn as several groups. A group is one list row,
 * and a row the height of a hundred messages is a row the list cannot recycle.
 */
const MAX_RUN = 20;

/** How far from the newest message the "scroll to latest" button appears. */
const SCROLLED_UP_PX = 320;

interface TranscriptProps {
  items: readonly MessageListItem[];
  /** The SDK's item behind each row, by id: media, content kind, text for copy. */
  sources: ReadonlyMap<string, TimelineItemView>;
  isGroup: boolean;
  typing: boolean;
  reachedStart: boolean;
  onLoadOlder: () => void;
  actions: MessageActions;
}

function splitLongRuns(entries: MessageListEntry[]): MessageListEntry[] {
  return entries.flatMap((entry) => {
    if (entry.kind !== 'group' || entry.messages.length <= MAX_RUN) return [entry];
    const chunks: MessageListEntry[] = [];
    for (let start = 0; start < entry.messages.length; start += MAX_RUN) {
      const slice = entry.messages.slice(start, start + MAX_RUN);
      // Each chunk is drawn as its own group, so its corners are its own: keeping
      // the whole run's positions would leave a `middle` bubble at either seam.
      const positions = bubblePositions(slice.length);
      const messages = slice.map(({ item }, index) => ({ item, position: positions[index] ?? 'single' }));
      chunks.push({ ...entry, key: `${entry.key}-${messages[0].item.id}`, messages });
    }
    return chunks;
  });
}

/** The conversation's messages, newest at the bottom, older pages loaded on reaching the top. */
export const Transcript = memo(function Transcript({
  items,
  sources,
  isGroup,
  typing,
  reachedStart,
  onLoadOlder,
  actions,
}: TranscriptProps) {
  const { t } = useTranslation();
  const list = useRef<FlashListRef<MessageListEntry>>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  // The day the reader is looking at, and whether they are moving: the floating
  // pill says where they are while a scroll is going on, and fades after it.
  const [day, setDay] = useState('');
  const [scrolling, setScrolling] = useState(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const entries = useMemo(() => splitLongRuns(groupMessages(items)), [items]);

  const labels = useMemo<Partial<MessageBubbleLabels>>(
    () => ({
      deleted: t('message.deleted'),
      replyTo: t('message.replyTo'),
      addReaction: t('message.addReaction'),
      pending: t('message.pending'),
      failed: t('message.failed'),
      selected: t('message.selected'),
      retry: t('message.retry'),
    }),
    [t],
  );

  const renderItem = useCallback<ListRenderItem<MessageListEntry>>(
    ({ item: entry }) => {
      switch (entry.kind) {
        case 'date':
          return <DateSeparator label={entry.label} />;
        case 'unread':
          return <UnreadSeparator label={t('chat.unreadMessages')} />;
        case 'system':
          return <SystemMessage text={entry.item.system} />;
        case 'call':
          return null;
        case 'group': {
          const first = entry.messages[0].item;
          return (
            <MessageGroup
              direction={entry.direction}
              senderName={first.senderName}
              senderColorSeed={first.senderId}
              avatarSource={first.avatarSource}
              showAvatar={isGroup}
              showSenderName={isGroup && entry.direction === 'incoming'}
            >
              {entry.messages.map(({ item, position }) => {
                const source = sources.get(item.id);
                return source ? (
                  <MessageRow
                    key={item.id}
                    item={item}
                    source={source}
                    position={position}
                    labels={labels}
                    actions={actions}
                  />
                ) : null;
              })}
            </MessageGroup>
          );
        }
      }
    },
    [actions, isGroup, labels, sources, t],
  );

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    setScrolledUp(contentSize.height - layoutMeasurement.height - contentOffset.y > SCROLLED_UP_PX);
    setScrolling(true);
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => setScrolling(false), 900);
  }, []);

  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );

  const onViewable = useRef(({ viewableItems }: { viewableItems: { item: MessageListEntry }[] }) => {
    const first = viewableItems[0]?.item;
    if (!first) return;
    const label =
      first.kind === 'date'
        ? first.label
        : first.kind === 'group'
          ? first.messages[0]?.item.dateLabel
          : first.kind === 'system' || first.kind === 'call'
            ? first.item.dateLabel
            : undefined;
    if (label) setDay(label);
  }).current;

  return (
    <View style={styles.root}>
      <FlashList
        ref={list}
        data={entries}
        renderItem={renderItem}
        keyExtractor={(entry) => entry.key}
        getItemType={(entry) => entry.kind}
        extraData={renderItem}
        contentContainerStyle={styles.content}
        maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }}
        onStartReached={reachedStart ? undefined : onLoadOlder}
        onStartReachedThreshold={0.5}
        onScroll={onScroll}
        scrollEventThrottle={64}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onViewableItemsChanged={onViewable}
        ListFooterComponent={typing ? <TypingBubble label={t('chat.typing.someone')} /> : null}
      />
      <ChatDateHeader label={day} visible={scrolling && day !== ''} />
      <View style={styles.floating} pointerEvents="box-none">
        <ScrollToBottomButton
          visible={scrolledUp}
          accessibilityLabel={t('chat.scrollToLatest')}
          onPress={() => list.current?.scrollToEnd({ animated: true })}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  content: { paddingHorizontal: 12, paddingVertical: 8 },
  floating: { position: 'absolute', right: 16, bottom: 16 },
});
