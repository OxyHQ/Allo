import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { ChatEmptyState } from '@oxy.so/bloom/chat-screen';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { RiCompass3Line } from '@oxy.so/bloom/icons';
import { useTheme } from '@oxy.so/bloom/theme';

/** A path that names nothing: say so, and offer the way back and the way home. */
export default function NotFoundScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <ChatEmptyState
        illustration={<IconCircle icon={RiCompass3Line} />}
        title={t('notFound.title')}
        description={t('notFound.description')}
        action={
          <View style={styles.actions}>
            {router.canGoBack() ? (
              <Button variant="secondary" onPress={() => router.back()}>
                {t('notFound.goBack')}
              </Button>
            ) : null}
            <Button onPress={() => router.replace('/')}>{t('notFound.goHome')}</Button>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
});
