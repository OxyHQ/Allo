import React from 'react';
import { View } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';

import { ThemedText } from '@/components/ThemedText';
import { networkBrandGlyph } from '@/lib/bridges/networkPresentation';

/**
 * A remote network's mark, in the interface's own ink.
 *
 * ## Monochrome, and that is a decision
 *
 * See `lib/bridges/networkPresentation.ts` for the full argument. In short: Allo
 * takes every colour from `theme.colors.*`, a table of brand hexes here would be
 * exactly what that rule forbids, and a brand's own green fails contrast against
 * a dark row anyway. Telegram's API terms separately forbid using their logos —
 * a glyph at text size, in the interface's ink, beside a conversation's name is
 * identification rather than borrowed branding.
 *
 * ## An unknown network still draws
 *
 * A network id this build has never seen falls back to the initial of whatever
 * the server called it. The app carries no list of networks (`bridges.md` §9.2),
 * so "unknown" is the ordinary case the first time a deployment turns one on —
 * not an error, and certainly not a reason to draw nothing.
 */

export interface NetworkGlyphProps {
  readonly networkId: string;
  /** Only used when there is no brand glyph for this id. */
  readonly displayName: string;
  readonly size: number;
  readonly color: string;
  readonly accessibilityLabel?: string;
}

export function NetworkGlyph({
  networkId,
  displayName,
  size,
  color,
  accessibilityLabel,
}: NetworkGlyphProps) {
  const glyph = networkBrandGlyph(networkId);

  if (glyph !== undefined) {
    return (
      <FontAwesome6
        name={glyph}
        iconStyle="brands"
        size={size}
        color={color}
        accessibilityLabel={accessibilityLabel}
      />
    );
  }

  /**
   * The initial, in a box the same size the glyph would have been, so that a
   * fallback does not reflow the row it sits in.
   */
  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessibilityLabel={accessibilityLabel}
    >
      <ThemedText style={{ fontSize: size * 0.8, lineHeight: size, color }}>
        {displayName.trim().charAt(0).toUpperCase()}
      </ThemedText>
    </View>
  );
}
