import { Image, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { OxySignInButton } from '@oxy.so/services/ui/client';

import { SEO } from '@/components/SEO';

import { Embed, Text, VStack } from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

/** Signed out: what Allo is, and the one way in — an Oxy account. */
export default screen(function WelcomeScreen() {
  const { t } = useTranslation();

  return VStack(
    Embed(<SEO title={t('seo.home.title')} description={t('seo.home.description')} />),
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
        Text(t('auth.welcome.title'))
          .font('title-1')
          .weight('semibold')
          .role('header')
          .textAlign('center'),
        Text(t('auth.welcome.subtitle')).font('body').foreground('muted').textAlign('center'),
      ).spacing('sm'),
      Embed(<OxySignInButton />),
    )
      .frame({ width: 'full', maxWidth: '400' })
      .align('center')
      .spacing('3xl'),
  )
    .safeAreaPadding('vertical')
    .padding('all', '2xl')
    .align('center')
    .justify('center')
    .grow()
    .header(false)
    .screenScroll('none');
});

const styles = StyleSheet.create({
  artwork: { width: 240, height: 240 },
});
