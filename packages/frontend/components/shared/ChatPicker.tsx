/**
 * ChatPicker — bottom-sheet content listing existing conversations.
 * Used to pick a single conversation to send something into (e.g. a photo
 * taken from the chat list header). Search + tap to select.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';

import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { GroupAvatar } from '@/components/GroupAvatar';
import { useTheme } from '@/hooks/useTheme';
import { useConversationsStore } from '@/stores/conversationsStore';
import {
  getConversationAvatar,
  getConversationDisplayName,
  getOtherParticipants,
  isGroupConversation,
} from '@/utils/conversationUtils';
import type { Conversation } from '@/app/(chat)/index';

interface ChatPickerProps {
  title?: string;
  emptyText?: string;
  onSelect: (conversation: Conversation) => void;
  onClose: () => void;
}

export const ChatPicker: React.FC<ChatPickerProps> = ({
  title,
  emptyText,
  onSelect,
  onClose,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const { user, oxyServices } = useOxy();
  const currentUserId = user?.id;
  const conversations = useConversationsStore((s) => s.conversations);

  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const list = conversations.filter((c) => !c.isArchived);
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.lastMessage || '').toLowerCase().includes(q)
    );
  }, [conversations, query]);

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
      onClose();
    },
    [onSelect, onClose]
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { padding: 16, paddingTop: 0, flex: 1 },
        title: {
          fontSize: 18,
          fontWeight: '700',
          marginBottom: 12,
          color: theme.colors.text,
        },
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
        rowMain: { flex: 1, justifyContent: 'center' },
        name: {
          fontSize: 15,
          color: theme.colors.text,
          fontWeight: '500',
        },
        preview: {
          fontSize: 13,
          color: theme.colors.textSecondary || '#999',
          marginTop: 2,
        },
        empty: {
          alignItems: 'center',
          paddingVertical: 32,
        },
        emptyText: {
          fontSize: 14,
          color: theme.colors.textSecondary || '#999',
          textAlign: 'center',
        },
      }),
    [theme]
  );

  return (
    <View style={styles.container}>
      <ThemedText style={styles.title}>{title || t('chat.selectChat')}</ThemedText>
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder={t('Search...') || ''}
        placeholderTextColor={theme.colors.textSecondary || '#999'}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <View style={styles.empty}>
            <ThemedText style={styles.emptyText}>
              {emptyText || t('chat.noConversations')}
            </ThemedText>
          </View>
        }
        renderItem={({ item }) => {
          const displayName = getConversationDisplayName(item, currentUserId);
          const avatar = getConversationAvatar(item, currentUserId, oxyServices);
          const otherParticipants = getOtherParticipants(item, currentUserId);
          const isGroup = isGroupConversation(item);
          return (
            <TouchableOpacity
              style={styles.row}
              onPress={() => handleSelect(item)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={displayName}
            >
              {isGroup && otherParticipants.length > 0 ? (
                <GroupAvatar participants={otherParticipants} size={40} maxAvatars={6} />
              ) : (
                <Avatar
                  source={avatar ? { uri: avatar } : undefined}
                  size={40}
                  label={displayName.charAt(0).toUpperCase()}
                />
              )}
              <View style={styles.rowMain}>
                <ThemedText style={styles.name} numberOfLines={1}>
                  {displayName}
                </ThemedText>
                {item.lastMessage ? (
                  <ThemedText style={styles.preview} numberOfLines={1}>
                    {item.lastMessage}
                  </ThemedText>
                ) : null}
              </View>
              <Ionicons
                name="chevron-forward"
                size={20}
                color={theme.colors.textSecondary || '#999'}
              />
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
};
