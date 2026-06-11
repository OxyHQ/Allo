/**
 * ContactMessage — renders a shared contact as a card with an initials avatar,
 * name, primary detail, and quick actions (call via `tel:`, email via `mailto:`).
 */
import React, { useCallback, useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ThemedText } from '@/components/ThemedText';
import { MessageAvatar } from '@/components/messages/MessageAvatar';
import { useTheme } from '@/hooks/useTheme';
import type { ContactData } from '@/stores/messagesStore';

interface ContactMessageProps {
  contact: ContactData;
  isSent: boolean;
}

export const ContactMessage: React.FC<ContactMessageProps> = ({ contact, isSent }) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const primaryPhone = contact.phones?.[0];
  const primaryEmail = contact.emails?.[0];
  const primaryDetail = primaryPhone || primaryEmail;

  const openUrl = useCallback((url: string) => {
    Linking.openURL(url).catch((error) =>
      console.warn('[ContactMessage] openURL failed:', error)
    );
  }, []);

  const textColor = isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          borderRadius: 16,
          paddingHorizontal: 12,
          paddingVertical: 12,
          gap: 12,
          backgroundColor: isSent
            ? theme.colors.messageBubbleSent
            : theme.colors.messageBubbleReceived,
          minWidth: 240,
        },
        header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
        info: { flex: 1 },
        name: { fontSize: 15, fontWeight: '700', color: textColor },
        sub: { fontSize: 13, color: textColor, opacity: 0.7, marginTop: 2 },
        actions: {
          flexDirection: 'row',
          gap: 8,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: 'rgba(127,127,127,0.25)',
          paddingTop: 10,
        },
        action: {
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          paddingVertical: 8,
          borderRadius: 10,
          backgroundColor: 'rgba(127,127,127,0.12)',
        },
        actionText: { fontSize: 13, fontWeight: '600', color: theme.colors.primary },
      }),
    [theme, isSent, textColor]
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <MessageAvatar name={contact.name} size={44} />
        <View style={styles.info}>
          <ThemedText style={styles.name} numberOfLines={1}>
            {contact.name}
          </ThemedText>
          <ThemedText style={styles.sub} numberOfLines={1}>
            {primaryDetail || t('chat.contactNoDetails')}
          </ThemedText>
        </View>
      </View>
      {(primaryPhone || primaryEmail) && (
        <View style={styles.actions}>
          {primaryPhone && (
            <TouchableOpacity
              style={styles.action}
              activeOpacity={0.7}
              onPress={() => openUrl(`tel:${primaryPhone}`)}
            >
              <Ionicons name="call-outline" size={16} color={theme.colors.primary} />
              <ThemedText style={styles.actionText}>{t('chat.contactCall')}</ThemedText>
            </TouchableOpacity>
          )}
          {primaryEmail && (
            <TouchableOpacity
              style={styles.action}
              activeOpacity={0.7}
              onPress={() => openUrl(`mailto:${primaryEmail}`)}
            >
              <Ionicons name="mail-outline" size={16} color={theme.colors.primary} />
              <ThemedText style={styles.actionText}>{t('chat.contactEmail')}</ThemedText>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
};
