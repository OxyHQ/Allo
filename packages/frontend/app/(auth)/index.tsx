import { Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { OxySignInButton } from '@oxy.so/services/ui/client';
import { Screen } from '@oxy.so/bloom/screen';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';

import { SEO } from '@/components/SEO';

/** Signed out: what Allo is, and the one way in — an Oxy account. */
export default function WelcomeScreen() {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <Screen scroll="none">
      {/* The safe area is padding on this View (NativeWind's safe-area classes). */}
      <View className="p-6 pt-safe-offset-6 pb-safe-offset-6" style={styles.root}>
        <SEO title={t('seo.home.title')} description={t('seo.home.description')} />
        <View style={styles.column}>
          <Image
            source={require('@/assets/images/welcome.png')}
            style={styles.artwork}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
          <View style={styles.copy}>
            <Text variant="title-1-semibold" accessibilityRole="header" style={styles.centered}>
              {t('auth.welcome.title')}
            </Text>
            <Text
              variant="body-regular"
              style={[styles.centered, { color: theme.colors.textSecondary }]}
            >
              {t('auth.welcome.subtitle')}
            </Text>
          </View>
          <OxySignInButton />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  column: { width: '100%', maxWidth: 400, alignItems: 'center', gap: 32 },
  artwork: { width: 240, height: 240 },
  copy: { gap: 8 },
  centered: { textAlign: 'center' },
});
