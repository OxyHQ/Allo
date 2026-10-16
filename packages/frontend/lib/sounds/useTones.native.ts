import { useAssets } from 'expo-asset';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useCallback } from 'react';

import type { SoundCue } from '@/lib/chat/soundCue';
import { TONE_ASSETS, TONE_CUES } from './tones';

/** `modules/allo-tones`: a tone as a system sound, which honours the silent switch and the ringer. */
const tones = requireOptionalNativeModule<{ play(uri: string): void }>('AlloTones');

/**
 * Plays a conversation tone through the OS's alert channel, never as media: on
 * silent or vibrate it makes no sound, and it neither pauses nor ducks the
 * user's music. A build without the module plays nothing rather than falling
 * back to a media player that would ignore the silent switch.
 */
export function useTones(): (cue: SoundCue) => void {
  const [assets] = useAssets(TONE_CUES.map((cue) => TONE_ASSETS[cue]));
  return useCallback(
    (cue: SoundCue) => {
      const uri = assets?.[TONE_CUES.indexOf(cue)]?.localUri;
      if (tones && uri) tones.play(uri);
    },
    [assets],
  );
}
