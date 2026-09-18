import React, { useCallback, useEffect, useRef } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';

import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { BackupPanel } from '@/components/backup/BackupPanel';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';

/**
 * SETTINGS → BACKUP AND RECOVERY.
 *
 * The panel does the work (`components/backup/BackupPanel.tsx`); this route
 * gives it a header and one thing a panel cannot do for itself: while the
 * recovery phrase is on screen and the person has not yet said they wrote it
 * down, leaving is refused — the back arrow, the hardware back button and the
 * swipe alike — because the phrase is shown once and a screen dismissed by
 * accident would be the last anyone saw of it.
 */
export default function BackupScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  // A ref, not state: nothing here re-renders on it; only the listener reads it.
  const pendingRef = useRef(false);
  const onPhrasePending = useCallback((pending: boolean) => {
    pendingRef.current = pending;
  }, []);

  useEffect(() => {
    return navigation.addListener('beforeRemove', (event) => {
      if (!pendingRef.current) return;
      event.preventDefault();
      toast.error(t('backup.phrase.mustConfirm', 'Confirm that you wrote the words down before leaving.'));
    });
  }, [navigation, t]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('backup.title', 'Backup and recovery'),
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder
        disableSticky
      />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <BackupPanel onPhrasePending={onPhrasePending} />
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
  },
});
