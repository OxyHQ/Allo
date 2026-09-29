/**
 * The "Stickers" tab of the composer's picker.
 *
 * Shows the packs this Oxy account has installed — the same picker in every
 * Oxy app, since the installed list lives in Oxy — as a grid per pack, and
 * sends a sticker on tap. With nothing installed it shows the shop instead, so
 * the first pack is one tap away. Stills only, not animations: a grid of
 * dozens of Lottie players is the one thing a picker must not cost.
 */
import { Button } from '@oxy.so/bloom/button';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import { Sticker as StickerTile } from '@oxy.so/bloom/sticker';
import { Text } from '@oxy.so/bloom/typography';
import type { Sticker } from '@oxy.so/stickers';
import { useInstallStickerPack, useInstalledStickerPacks, useStickerShop } from '@oxy.so/stickers/react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

/** Four 72px tiles fit the 324px picker panel with its gaps. */
const TILE = 72;

export function StickerPicker({ onSelect, height }: { onSelect: (sticker: Sticker) => void; height: number }) {
  const { t } = useTranslation();
  const installed = useInstalledStickerPacks();

  if (installed.isLoading) return <View style={{ height }} />;

  const packs = installed.data ?? [];
  if (packs.length === 0) return <StickerShop height={height} />;

  return (
    <ScrollView style={{ height }} contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>
      {packs.map((pack) => (
        <View key={pack.id} style={{ gap: 6 }}>
          <Text variant="body-2-medium">{pack.title}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
            {pack.stickers.map((sticker) => (
              <PressableScale
                key={sticker.id}
                accessibilityRole="button"
                accessibilityLabel={`${sticker.emoji[0] ?? ''} ${t('chat.attachment.sticker')}`.trim()}
                onPress={() => onSelect(sticker)}
              >
                <StickerTile fallback={sticker.fallback.url} size={TILE} decorative />
              </PressableScale>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

/** The first run: packs to add, each with its cover and one button. */
function StickerShop({ height }: { height: number }) {
  const { t } = useTranslation();
  const shop = useStickerShop({ limit: 24 });
  const install = useInstallStickerPack();

  return (
    <ScrollView style={{ height }} contentContainerStyle={{ gap: 10, paddingBottom: 8 }}>
      <Text variant="body-2-regular">{t('composer.stickers.empty')}</Text>
      {(shop.data?.items ?? []).map((pack) => (
        <View key={pack.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {pack.cover ? <StickerTile fallback={pack.cover.fallback.url} size={48} decorative /> : null}
          <Text variant="body-medium" style={{ flex: 1 }} numberOfLines={1}>
            {pack.title}
          </Text>
          <Button
            size="sm"
            appearance="subtle"
            loading={install.isPending && install.variables === pack.id}
            onPress={() => install.mutate(pack.id)}
          >
            {t('composer.stickers.add')}
          </Button>
        </View>
      ))}
    </ScrollView>
  );
}
