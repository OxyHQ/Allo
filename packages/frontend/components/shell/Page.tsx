import React, { type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useTheme } from '@oxy.so/bloom/theme';

import { useSplitLayout } from '@/hooks/useSplitLayout';

interface PageProps {
  title: string;
  subtitle?: string;
  /** Header controls on the trailing side. */
  actions?: ReactNode;
  /**
   * Draws a back button. `'narrow'` (the default) only where the page is the
   * whole screen: beside the list there is nothing to go back to on screen.
   */
  back?: 'narrow' | 'always' | 'never';
  /** `false` when the content scrolls itself (a virtualized list). */
  scroll?: boolean;
  children: ReactNode;
}

/** A titled screen: Bloom's page header over the page's own content. */
export function Page({ title, subtitle, actions, back = 'narrow', scroll = true, children }: PageProps) {
  const router = useRouter();
  const split = useSplitLayout();
  const { t } = useTranslation();
  const theme = useTheme();
  const showBack = back === 'always' || (back === 'narrow' && !split);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={actions}
        onBack={showBack ? () => (router.canGoBack() ? router.back() : router.replace('/')) : undefined}
        backLabel={t('common.back')}
        safeArea={!split}
      />
      {scroll ? (
        <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={styles.root}>{children}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 16 },
});
