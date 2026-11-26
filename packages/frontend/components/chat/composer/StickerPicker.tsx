import { Sticker as StickerTile } from '@oxy.so/bloom/sticker';
import type { Sticker } from '@oxy.so/stickers';
import {
  useInstallStickerPack,
  useInstalledStickerPacks,
  useStickerShop,
} from '@oxy.so/stickers/react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

import {
  Button as LButton,
  Embed,
  HStack,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

/** Four 72px tiles fit the 324px picker panel with its gaps. */
const TILE = 72;

export function StickerPicker({
  onSelect,
  height,
}: {
  onSelect: (sticker: Sticker) => void;
  height: number;
}) {
  const { t } = useTranslation();
  const installed = useInstalledStickerPacks();

  if (installed.isLoading) return toElement(VStack().frame({ height: height }));

  const packs = installed.data ?? [];
  if (packs.length === 0) return <StickerShop height={height} />;

  return (
    <ScrollView style={{ height }} contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>
      {packs.map((pack) =>
        toElement(
          VStack(
            LText(pack.title).font('body-2').weight('medium'),
            HStack(
              Embed(
                pack.stickers.map((sticker) =>
                  toElement(
                    VStack(
                      Embed(<StickerTile fallback={sticker.fallback.url} size={TILE} decorative />),
                    )
                      .role('button')
                      .label(`${sticker.emoji[0] ?? ''} ${t('chat.attachment.sticker')}`.trim())
                      .onPress(() => onSelect(sticker))
                      .pressScale(),
                    sticker.id,
                  ),
                ),
              ),
            )
              .wrap()
              .spacing('xs'),
          ).spacing('6'),
          pack.id,
        ),
      )}
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
      {toElement(LText(t('composer.stickers.empty')).font('body-2'))}
      {(shop.data?.items ?? []).map((pack) =>
        toElement(
          HStack(
            Embed(
              pack.cover ? (
                <StickerTile fallback={pack.cover.fallback.url} size={48} decorative />
              ) : null,
            ),
            LText(pack.title).grow().font('body').weight('medium').lines(1),
            LButton(LText(t('composer.stickers.add')))
              .size('sm')
              .style('subtle')
              .loading(install.isPending && install.variables === pack.id)
              .onPress(() => install.mutate(pack.id)),
          )
            .align('center')
            .spacing('10'),
          pack.id,
        ),
      )}
    </ScrollView>
  );
}
