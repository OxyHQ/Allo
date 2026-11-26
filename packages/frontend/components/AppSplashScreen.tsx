import React from 'react';
import { useTheme } from '@oxy.so/bloom/theme';

import { LogoIcon } from '@/assets/logo';

import { Embed, VStack, toElement } from '@oxy.so/bloom-language';

/**
 * Web's boot splash: the mark on the theme background while fonts and i18n
 * load. It unmounts the moment they are ready; no animation stands between
 * readiness and the first screen.
 */
function AppSplashScreen() {
  const theme = useTheme();
  return toElement(
    VStack(Embed(<LogoIcon size={96} color={theme.colors.primary} />))
      .background('background')
      .align('center')
      .justify('center')
      .grow(),
  );
}

export default React.memo(AppSplashScreen);
