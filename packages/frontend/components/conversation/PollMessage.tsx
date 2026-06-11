/**
 * PollMessage — renders an inline poll with option bars + voting.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { useMessagesStore } from '@/stores';
import type { PollData } from '@/stores/messagesStore';
import { toast } from '@/lib/sonner';

interface PollMessageProps {
  conversationId: string;
  messageId: string;
  poll: PollData;
  isSent: boolean;
  currentUserId?: string;
}

export const PollMessage: React.FC<PollMessageProps> = ({
  conversationId,
  messageId,
  poll,
  isSent,
  currentUserId,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const voteInPoll = useMessagesStore((s) => s.voteInPoll);
  const [busyIdx, setBusyIdx] = useState<number | null>(null);

  const totalVotes = useMemo(
    () => poll.options.reduce((sum, o) => sum + (o.votes?.length || 0), 0),
    [poll.options]
  );

  const myVotes = useMemo(() => {
    if (!currentUserId) return new Set<number>();
    return new Set(
      poll.options
        .map((o, i) => (o.votes?.includes(currentUserId) ? i : -1))
        .filter((i) => i >= 0)
    );
  }, [poll.options, currentUserId]);

  const handleVote = useCallback(
    async (idx: number) => {
      if (busyIdx !== null) return;
      setBusyIdx(idx);
      try {
        let next: number[];
        if (poll.multi) {
          next = Array.from(myVotes);
          if (myVotes.has(idx)) {
            next = next.filter((i) => i !== idx);
          } else {
            next.push(idx);
          }
        } else {
          // Single-choice: tapping the same option clears, otherwise replace
          next = myVotes.has(idx) ? [] : [idx];
        }
        const ok = await voteInPoll(conversationId, messageId, next);
        if (!ok) toast.error(t('chat.pollVoteFailed'));
      } finally {
        setBusyIdx(null);
      }
    },
    [busyIdx, poll.multi, myVotes, voteInPoll, conversationId, messageId, t]
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          paddingHorizontal: 14,
          paddingVertical: 12,
          borderRadius: 14,
          backgroundColor: isSent
            ? theme.colors.messageBubbleSent
            : theme.colors.messageBubbleReceived,
          minWidth: 260,
          maxWidth: 320,
        },
        header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
        question: {
          fontSize: 15,
          fontWeight: '700',
          color: isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived,
          flex: 1,
        },
        meta: {
          fontSize: 12,
          opacity: 0.6,
          color: isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived,
        },
        option: {
          marginBottom: 8,
        },
        optionRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          marginBottom: 4,
        },
        optionText: {
          flex: 1,
          fontSize: 14,
          fontWeight: '500',
          color: isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived,
        },
        percent: {
          fontSize: 12,
          fontWeight: '600',
          color: isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived,
          opacity: 0.8,
        },
        barBg: {
          height: 6,
          borderRadius: 3,
          backgroundColor: 'rgba(0,0,0,0.08)',
          overflow: 'hidden',
        },
        barFill: {
          height: '100%',
          backgroundColor: theme.colors.primary || '#007AFF',
        },
        totalText: {
          marginTop: 6,
          fontSize: 12,
          opacity: 0.6,
          color: isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived,
        },
      }),
    [theme, isSent]
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="bar-chart" size={18} color={theme.colors.primary || '#007AFF'} />
        <ThemedText style={styles.question}>{poll.question}</ThemedText>
      </View>
      <ThemedText style={styles.meta}>
        {poll.multi ? t('chat.pollMulti') : t('chat.pollSingle')}
      </ThemedText>

      {poll.options.map((opt, idx) => {
        const count = opt.votes?.length || 0;
        const percent = totalVotes > 0 ? (count / totalVotes) * 100 : 0;
        const isMine = myVotes.has(idx);
        return (
          <TouchableOpacity
            key={`${idx}-${opt.text}`}
            style={styles.option}
            onPress={() => handleVote(idx)}
            activeOpacity={0.7}
            disabled={poll.closed || busyIdx !== null}
          >
            <View style={styles.optionRow}>
              <Ionicons
                name={isMine ? (poll.multi ? 'checkbox' : 'radio-button-on') : poll.multi ? 'square-outline' : 'radio-button-off'}
                size={18}
                color={isMine ? theme.colors.primary || '#007AFF' : (isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived)}
              />
              <ThemedText style={styles.optionText} numberOfLines={2}>
                {opt.text}
              </ThemedText>
              <ThemedText style={styles.percent}>{Math.round(percent)}%</ThemedText>
            </View>
            <View style={styles.barBg}>
              <View style={[styles.barFill, { width: `${percent}%` }]} />
            </View>
          </TouchableOpacity>
        );
      })}

      <ThemedText style={styles.totalText}>
        {totalVotes === 1 ? t('chat.pollOneVote') : t('chat.pollVotes', { count: totalVotes })}
      </ThemedText>
    </View>
  );
};
