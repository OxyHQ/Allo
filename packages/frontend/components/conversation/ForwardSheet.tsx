/**
 * ForwardSheet — bottom sheet listing conversations to forward a message into.
 * Multi-select + search by name.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, TextInput, StyleSheet, TouchableOpacity, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { useConversationsStore } from '@/stores/conversationsStore';
import { useMessagesStore } from '@/stores';
import { useOxy } from '@oxyhq/services';
import Avatar from '@/components/Avatar';
import type { Conversation } from '@/app/(chat)';
import type { Message, AttachmentType } from '@/stores/messagesStore';
import { getOtherParticipants } from '@/utils/conversationUtils';
import { toForwardSources } from '@/lib/outgoingMedia';
import { toast } from '@/lib/sonner';

interface ForwardSheetProps {
  message: Message;
  onClose: () => void;
}

export const ForwardSheet: React.FC<ForwardSheetProps> = ({ message, onClose }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const { user } = useOxy();
  const currentUserId = user?.id;
  const conversations = useConversationsStore((s) => s.conversations);
  const sendMessage = useMessagesStore((s) => s.sendMessage);
  const sendAttachmentMessage = useMessagesStore((s) => s.sendAttachmentMessage);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => (c.name || '').toLowerCase().includes(q));
  }, [query, conversations]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const getRecipient = useCallback(
    (conv: Conversation): string | undefined => {
      const others = getOtherParticipants(conv as any, currentUserId);
      return others[0]?.id;
    },
    [currentUserId]
  );

  const handleForward = useCallback(async () => {
    if (selected.size === 0 || !currentUserId) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      const targetIds = Array.from(selected);
      const tasks = targetIds.map(async (conversationId) => {
        const conv = conversations.find((c) => c.id === conversationId);
        if (!conv) return false;
        const recipient = getRecipient(conv);
        if (!recipient) return false;

        const attachmentType: AttachmentType | undefined = message.attachmentType;
        const hasAttachment =
          !!attachmentType ||
          !!message.location ||
          !!message.contact ||
          !!message.poll ||
          (message.media && message.media.length > 0);

        if (hasAttachment) {
          const inferredType: AttachmentType =
            attachmentType ||
            (message.location
              ? 'location'
              : message.contact
                ? 'contact'
                : message.poll
                  ? 'poll'
                  : message.media && message.media[0]
                    ? (message.media[0].type as AttachmentType)
                    : 'file');
          // Re-derive send-ready media sources: encrypted attachments are
          // decrypted locally then re-encrypted with a fresh key for the target.
          const forwardMedia =
            message.media && message.media.length > 0
              ? await toForwardSources(message.media)
              : undefined;
          const result = await sendAttachmentMessage(
            conversationId,
            {
              attachmentType: inferredType,
              text: message.text || undefined,
              media: forwardMedia,
              location: message.location,
              contact: message.contact,
              poll: message.poll
                ? {
                    question: message.poll.question,
                    multi: message.poll.multi,
                    options: message.poll.options.map((o) => ({ text: o.text, votes: [] })),
                  }
                : undefined,
              forwardedFrom: message.id,
            },
            currentUserId,
            recipient
          );
          return !!result;
        }

        // Plain text forward
        const text = message.text || '';
        if (!text.trim()) return false;
        const result = await sendMessage(
          conversationId,
          text,
          currentUserId,
          recipient,
          message.fontSize
        );
        return !!result;
      });

      const results = await Promise.all(tasks);
      const okCount = results.filter(Boolean).length;
      if (okCount > 0) {
        toast.success(t('chat.forwardedToCount', { count: okCount }));
      } else {
        toast.error(t('chat.forwardFailed'));
      }
    } catch (error) {
      console.error('[ForwardSheet] error:', error);
      toast.error(t('chat.forwardFailed'));
    } finally {
      setBusy(false);
      onClose();
    }
  }, [
    selected,
    currentUserId,
    conversations,
    sendMessage,
    sendAttachmentMessage,
    message,
    getRecipient,
    onClose,
    t,
  ]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { padding: 16, paddingTop: 0, flex: 1 },
        title: { fontSize: 18, fontWeight: '700', marginBottom: 12, color: theme.colors.text },
        search: {
          backgroundColor: theme.colors.card || '#F0F0F0',
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 10,
          marginBottom: 12,
          color: theme.colors.text,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border || 'rgba(0,0,0,0.08)',
        },
        name: { flex: 1, fontSize: 15, color: theme.colors.text, fontWeight: '500' },
        sendBtn: {
          backgroundColor: theme.colors.primary || '#007AFF',
          paddingVertical: 14,
          borderRadius: 14,
          alignItems: 'center',
          marginTop: 12,
          opacity: selected.size > 0 && !busy ? 1 : 0.5,
        },
        sendText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
      }),
    [theme, selected.size, busy]
  );

  return (
    <View style={styles.container}>
      <ThemedText style={styles.title}>{t('chat.forwardTo')}</ThemedText>
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder={t('Search...') || ''}
        placeholderTextColor={theme.colors.textSecondary || '#999'}
      />
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const isSelected = selected.has(item.id);
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() => toggle(item.id)}
              activeOpacity={0.7}
            >
              <Avatar
                source={item.avatar ? { uri: item.avatar } : undefined}
                size={40}
                label={item.name}
              />
              <ThemedText style={styles.name} numberOfLines={1}>
                {item.name}
              </ThemedText>
              <Ionicons
                name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                size={22}
                color={isSelected ? theme.colors.primary || '#007AFF' : theme.colors.textSecondary || '#999'}
              />
            </TouchableOpacity>
          );
        }}
      />
      <TouchableOpacity
        style={styles.sendBtn}
        onPress={handleForward}
        activeOpacity={0.85}
        disabled={selected.size === 0 || busy}
      >
        <ThemedText style={styles.sendText}>
          {busy
            ? t('chat.forwarding')
            : selected.size > 0
              ? t('chat.forwardCount', { count: selected.size })
              : t('chat.selectChats')}
        </ThemedText>
      </TouchableOpacity>
    </View>
  );
};
