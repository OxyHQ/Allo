import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';

import { LogoIcon } from '@/assets/logo';

/**
 * Web's boot splash: the mark on the theme background while fonts and i18n
 * load. It unmounts the moment they are ready; no animation stands between
 * readiness and the first screen.
 */
function AppSplashScreen() {
  const theme = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <LogoIcon size={96} color={theme.colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

export default React.memo(AppSplashScreen);
