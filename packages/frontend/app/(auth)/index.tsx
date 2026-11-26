import { Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { OxySignInButton } from '@oxy.so/services/ui/client';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';

import { SEO } from '@/components/SEO';

import { Embed, Group, VStack, toElement } from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

/** Signed out: what Allo is, and the one way in — an Oxy account. */
export default screen(function WelcomeScreen() {
  const { t } = useTranslation();
  const theme = useTheme();

  return Group(
    /* The safe area is padding on this View (NativeWind's safe-area classes). */ Embed(
      <View className="p-6 pt-safe-offset-6 pb-safe-offset-6" style={styles.root}>
        <SEO title={t('seo.home.title')} description={t('seo.home.description')} />
        {toElement(
          VStack(
            Embed(
              <Image
                source={require('@/assets/images/welcome.png')}
                style={styles.artwork}
                resizeMode="contain"
                accessibilityIgnoresInvertColors
              />,
            ),
            VStack(
              Embed(
                <Text variant="title-1-semibold" accessibilityRole="header" style={styles.centered}>
                  {t('auth.welcome.title')}
                </Text>,
              ),
              Embed(
                <Text
                  variant="body-regular"
                  style={[styles.centered, { color: theme.colors.textSecondary }]}
                >
                  {t('auth.welcome.subtitle')}
                </Text>,
              ),
            ).spacing('sm'),
            Embed(<OxySignInButton />),
          )
            .frame({ width: 'full', maxWidth: '400' })
            .align('center')
            .spacing('3xl'),
        )}
      </View>,
    ),
  )
    .header(false)
    .screenScroll('none');
});

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  artwork: { width: 240, height: 240 },
  centered: { textAlign: 'center' },
});
