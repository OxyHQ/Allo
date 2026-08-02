import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';

import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import type { BridgeLoginDisplay } from '@/lib/bridges/contract';

/**
 * A `display_and_wait` step: something to look at while the bridge waits for the
 * other end (`docs/matrix/bridges.md` §5.2).
 *
 * §5.2 pins the four kinds the bridge can send — `qr`, `emoji`, `code`,
 * `nothing` — and each is a different instruction to the user: scan this on your
 * other phone, confirm you are seeing these emoji, type this code there, or
 * simply wait. Collapsing them would produce a screen that says "waiting" while
 * holding the thing the user was supposed to act on.
 *
 * A kind this build does not know falls through to the waiting state rather than
 * to nothing, so a bridge that adds a fifth produces a login that is merely
 * unhelpful instead of one that appears to have frozen.
 *
 * ## The QR is drawn locally
 *
 * `data` is the payload, not a picture. It is rendered here rather than fetched,
 * because the alternative is a round trip in the middle of a window that WhatsApp
 * closes after about 2m40s. `imageUrl` is honoured when the bridge sends one
 * instead — it is optional in the protocol and the two are not mutually
 * exclusive, so the payload wins: a QR generated from the exact bytes cannot be a
 * cached picture of an expired one.
 */

export interface LoginStepDisplayProps {
  readonly display: BridgeLoginDisplay;
}

const QR_SIZE = 220;

export function LoginStepDisplay({ display }: LoginStepDisplayProps) {
  const { t } = useTranslation();
  const theme = useTheme();

  if (display.type === 'qr' && display.data !== undefined) {
    return (
      <View className="items-center py-4">
        {/*
          * A QR is read by contrast, not by palette. It is drawn black on white
          * in both themes on purpose: inverting it for dark mode produces a code
          * that many scanners refuse, which would read to the user as the bridge
          * being broken.
          */}
        <View className="rounded-2xl p-4" style={{ backgroundColor: '#FFFFFF' }}>
          <QRCode value={display.data} size={QR_SIZE} />
        </View>
      </View>
    );
  }

  if (display.imageUrl !== undefined) {
    return (
      <View className="items-center py-4">
        <Image
          source={{ uri: display.imageUrl }}
          style={{ width: QR_SIZE, height: QR_SIZE }}
          contentFit="contain"
          accessibilityLabel={t('bridges.link.displayImage', {
            defaultValue: 'Code to scan',
          })}
        />
      </View>
    );
  }

  if (display.type === 'code' && display.data !== undefined) {
    return (
      <View className="items-center py-6">
        <ThemedText
          selectable
          className="text-center"
          style={{ fontSize: 34, letterSpacing: 6, color: theme.colors.text }}
        >
          {display.data}
        </ThemedText>
      </View>
    );
  }

  if (display.type === 'emoji' && display.data !== undefined) {
    return (
      <View className="items-center py-6">
        <ThemedText className="text-center" style={{ fontSize: 40 }}>
          {display.data}
        </ThemedText>
      </View>
    );
  }

  return (
    <View className="items-center py-8">
      <ActivityIndicator color={theme.colors.primary} />
      <ThemedText
        className="mt-3 text-center"
        style={{ color: theme.colors.textSecondary }}
      >
        {t('bridges.link.waiting', { defaultValue: 'Waiting for the other device…' })}
      </ThemedText>
    </View>
  );
}
