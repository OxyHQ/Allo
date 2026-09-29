/**
 * The composer's emoji button and the picker behind it.
 *
 * `ChatComposer` draws a plain emoji button from `onEmojiPress` and leaves the
 * surface to the app, so this is the `emojiSlot`: Bloom's own
 * `ComposerIconButton` as a `PopoverTrigger` — the same disc the default is —
 * over Bloom's `EmojiPicker` in a `Popover`, which is already an anchored panel
 * on a pointer and a bottom sheet on a phone.
 *
 * The panel does NOT close on a pick. Somebody reaching for an emoji usually
 * reaches for two, and the popover still dismisses on Escape and an outside
 * press.
 */
import { ComposerIconButton, EmojiPicker } from '@oxy.so/bloom/chat-composer';
import { RiEmotionLine } from '@oxy.so/bloom/icons/RiEmotionLine';
import { Popover, PopoverContent, PopoverTrigger } from '@oxy.so/bloom/popover';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Sticker } from '@oxy.so/stickers';

import { EMOJI_GROUPS } from '@/lib/chat/emoji';
import { StickerPicker } from './StickerPicker';

/** Eight 36px cells plus the panel's own padding. */
const PANEL_WIDTH = 324;
/** The emoji grid's own default height, so switching tabs does not resize the panel. */
const TAB_HEIGHT = 288;

export function EmojiButton({
  onSelect,
  onSelectSticker,
  disabled,
}: {
  /** The glyph, with the skin tone already applied by the picker. */
  onSelect: (emoji: string) => void;
  /** A sticker to send as its own message. Omit to offer no Stickers tab. */
  onSelectSticker?: (sticker: Sticker) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // The dataset carries English names for the search to match on; the nine
  // labels somebody actually READS come from the bundles.
  const groups = useMemo(
    () => EMOJI_GROUPS.map((group) => ({ ...group, label: t(`composer.emoji.group.${group.key}`) })),
    [t],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ComposerIconButton
          icon={RiEmotionLine}
          accessibilityLabel={t('composer.emoji.label')}
          disabled={disabled}
        />
      </PopoverTrigger>
      <PopoverContent
        label={t('composer.emoji.label')}
        side="top"
        align="end"
        minWidth={PANEL_WIDTH}
        maxWidth={PANEL_WIDTH}>
        <EmojiPicker
          groups={groups}
          onSelectEmoji={onSelect}
          height={TAB_HEIGHT}
          tabs={
            onSelectSticker
              ? [
                  {
                    key: 'stickers',
                    label: t('composer.stickers.label'),
                    // A sticker is a message on its own, so picking one sends it
                    // and closes the panel — unlike an emoji, which is typing.
                    content: (
                      <StickerPicker
                        height={TAB_HEIGHT}
                        onSelect={(sticker) => {
                          setOpen(false);
                          onSelectSticker(sticker);
                        }}
                      />
                    ),
                  },
                ]
              : undefined
          }
          labels={{
            search: t('composer.emoji.search'),
            empty: t('composer.emoji.empty'),
            skinTone: t('composer.emoji.skinTone'),
            emojiTab: t('composer.emoji.label'),
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
