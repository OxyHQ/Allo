import React, { memo, useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ScrollToBottomButton } from '@oxy.so/bloom/chat-screen';
import { MessageList, TypingBubble, type MessageBubbleLabels, type MessageListItem } from '@oxy.so/bloom/message-bubble';

/** How far from the newest message the "scroll to latest" button appears. */
const SCROLLED_UP_PX = 320;

/** How close to the top counts as asking for the page before this one. */
const LOAD_OLDER_PX = 240;

interface TranscriptProps {
  items: readonly MessageListItem[];
  isGroup: boolean;
  typing: boolean;
  unreadCount: number;
  reachedStart: boolean;
  onLoadOlder: () => void;
  labels: Partial<MessageBubbleLabels>;
}

/**
 * The conversation's messages: Bloom's `MessageList` in a scroller, with
 * Bloom's own jump button over it. The list owns the runs, the separators, the
 * avatars and the bubbles; all this adds is the scrolling, which belongs to the
 * app because the history it pages through does.
 */
export const Transcript = memo(function Transcript({
  items,
  isGroup,
  typing,
  unreadCount,
  reachedStart,
  onLoadOlder,
  labels,
}: TranscriptProps) {
  const { t } = useTranslation();
  const scroller = useRef<ScrollView>(null);
  const [scrolledUp, setScrolledUp] = useState(false);
  const atBottom = useRef(true);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const fromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
      atBottom.current = fromBottom < 24;
      setScrolledUp(fromBottom > SCROLLED_UP_PX);
      if (!reachedStart && contentOffset.y < LOAD_OLDER_PX) onLoadOlder();
    },
    [onLoadOlder, reachedStart],
  );

  return (
    <View style={styles.root}>
      <ScrollView
        ref={scroller}
        style={styles.root}
        // A short history sits at the BOTTOM, where a conversation starts from.
        contentContainerStyle={styles.content}
        onScroll={onScroll}
        scrollEventThrottle={64}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        // A new message scrolls into view for a reader who was already at the
        // end; one reading older messages stays where they are.
        onContentSizeChange={() => {
          if (atBottom.current) scroller.current?.scrollToEnd({ animated: false });
        }}
      >
        <MessageList
          items={items}
          showAvatars={isGroup}
          showSenderNames={isGroup}
          unreadLabel={t('chat.unreadMessages')}
          labels={labels}
        />
        {typing ? <TypingBubble label={t('chat.typing.someone')} /> : null}
      </ScrollView>
      <View style={styles.floating} pointerEvents="box-none">
        <ScrollToBottomButton
          visible={scrolledUp}
          unreadCount={unreadCount}
          accessibilityLabel={t('chat.scrollToLatest')}
          onPress={() => scroller.current?.scrollToEnd({ animated: true })}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  content: { flexGrow: 1, justifyContent: 'flex-end' },
  floating: { position: 'absolute', right: 16, bottom: 16 },
});
