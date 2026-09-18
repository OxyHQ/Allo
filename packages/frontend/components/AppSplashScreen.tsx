import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Platform, StyleSheet } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';

import { LogoIcon } from '@/assets/logo';

interface AppSplashScreenProps {
  /** Starts the fade-out; `onFadeComplete` fires once it has finished. */
  startFade?: boolean;
  onFadeComplete?: () => void;
}

const FADE_DURATION = 200;

/** Web's boot splash: the mark on the theme background while fonts and init finish. */
function AppSplashScreen({ startFade = false, onFadeComplete }: AppSplashScreenProps) {
  const theme = useTheme();
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (!startFade) return;
    const animation = Animated.timing(opacity, {
      toValue: 0,
      duration: FADE_DURATION,
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start(({ finished }) => {
      if (finished) onFadeComplete?.();
    });
    return () => animation.stop();
  }, [startFade, opacity, onFadeComplete]);

  return (
    <Animated.View style={[styles.root, { opacity, backgroundColor: theme.colors.background }]}>
      <LogoIcon size={96} color={theme.colors.primary} />
      <ActivityIndicator color={theme.colors.textSecondary} style={styles.spinner} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  spinner: { marginTop: 32 },
});

export default React.memo(AppSplashScreen);
