import React from 'react';
import { StyleSheet, View } from 'react-native';
import { RiVideoOffLine } from '@oxy.so/bloom/icons';
import { useTheme } from '@oxy.so/bloom/theme';
import { Muted } from '@oxy.so/bloom/typography';

/**
 * WHAT GOES IN `remoteVideo` AND `localVideo` WHILE THERE IS NO VIDEO.
 *
 * Bloom's `CallScreen` takes a frame as a `ReactNode` and knows nothing about
 * where it came from — which is exactly why there is something to put there
 * before any media exists. This is that node: a surface saying there is no
 * camera behind it, rather than a still photograph or a loading shimmer, both
 * of which read as "the video is about to arrive".
 *
 * It paints itself from the app's own theme surface rather than the call
 * stage's palette. Bloom computes that palette (`resolveCallPaint`) but does
 * not export it from `@oxy.so/bloom/call-ui`, so a caller filling the stage
 * cannot ask what colour is legible on it; an ordinary raised surface is
 * legible in both modes and reads as a panel sitting in the frame.
 */
export function StagePlaceholder({ label, compact = false }: { label: string; compact?: boolean }) {
  const theme = useTheme();
  const glyph = compact ? 20 : 34;
  return (
    <View
      style={[
        styles.root,
        { backgroundColor: theme.colors.backgroundSecondary, gap: compact ? 4 : 10 },
      ]}
    >
      <RiVideoOffLine width={glyph} height={glyph} fill={theme.colors.textTertiary} />
      {compact ? null : <Muted style={styles.label}>{label}</Muted>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12 },
  label: { textAlign: 'center' },
});
