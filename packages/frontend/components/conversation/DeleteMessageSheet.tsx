/**
 * DeleteMessageSheet — bottom-sheet content offering "delete for me"
 * and (optionally) "delete for everyone" actions.
 */
import React, { useMemo } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { TrashIcon } from '@/assets/icons/trash-icon';

interface DeleteMessageSheetProps {
  canDeleteForEveryone: boolean;
  onDeleteForMe: () => void;
  onDeleteForEveryone: () => void;
  onCancel: () => void;
}

export const DeleteMessageSheet: React.FC<DeleteMessageSheetProps> = ({
  canDeleteForEveryone,
  onDeleteForMe,
  onDeleteForEveryone,
  onCancel,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { padding: 16, paddingTop: 4, gap: 8 },
        title: { fontSize: 17, fontWeight: '700', color: theme.colors.text, marginBottom: 8 },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 14,
          paddingHorizontal: 12,
          borderRadius: 12,
          backgroundColor: theme.colors.card || 'rgba(0,0,0,0.04)',
        },
        rowDestructive: {
          backgroundColor: 'rgba(255, 59, 48, 0.08)',
        },
        rowText: { fontSize: 15, color: theme.colors.text, fontWeight: '500' },
        rowTextDestructive: { color: '#FF3B30', fontWeight: '600' },
        cancel: {
          marginTop: 8,
          paddingVertical: 14,
          borderRadius: 12,
          backgroundColor: theme.colors.card || 'rgba(0,0,0,0.04)',
          alignItems: 'center',
        },
      }),
    [theme]
  );

  return (
    <View style={styles.container}>
      <ThemedText style={styles.title}>{t('chat.deleteMessageTitle')}</ThemedText>

      <TouchableOpacity
        style={[styles.row, styles.rowDestructive]}
        onPress={onDeleteForMe}
        activeOpacity={0.7}
      >
        <TrashIcon size={20} color="#FF3B30" />
        <ThemedText style={[styles.rowText, styles.rowTextDestructive]}>
          {t('chat.deleteForMe')}
        </ThemedText>
      </TouchableOpacity>

      {canDeleteForEveryone && (
        <TouchableOpacity
          style={[styles.row, styles.rowDestructive]}
          onPress={onDeleteForEveryone}
          activeOpacity={0.7}
        >
          <TrashIcon size={20} color="#FF3B30" />
          <ThemedText style={[styles.rowText, styles.rowTextDestructive]}>
            {t('chat.deleteForEveryone')}
          </ThemedText>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.cancel} onPress={onCancel} activeOpacity={0.7}>
        <ThemedText style={styles.rowText}>{t('chat.deleteCancel')}</ThemedText>
      </TouchableOpacity>
    </View>
  );
};
