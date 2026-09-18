import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { OxySignInButton } from '@oxy.so/services';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';

import { SEO } from '@/components/SEO';

/** Signed out: what Allo is, and the one way in — an Oxy account. */
export default function WelcomeScreen() {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <SEO title={t('seo.home.title')} description={t('seo.home.description')} />
      <View style={styles.column}>
        <Image source={require('@/assets/images/welcome.png')} style={styles.artwork} resizeMode="contain" accessibilityIgnoresInvertColors />
        <View style={styles.copy}>
          <Text variant="title-1-semibold" accessibilityRole="header" style={styles.centered}>
            {t('auth.welcome.title')}
          </Text>
          <Text variant="body-regular" style={[styles.centered, { color: theme.colors.textSecondary }]}>
            {t('auth.welcome.subtitle')}
          </Text>
        </View>
        <OxySignInButton />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  column: { width: '100%', maxWidth: 400, alignItems: 'center', gap: 32 },
  artwork: { width: 240, height: 240 },
  copy: { gap: 8 },
  centered: { textAlign: 'center' },
});
