import { useAudioPlayer } from 'expo-audio';
import { useCallback } from 'react';

import type { SoundCue } from '@/lib/chat/soundCue';
import { TONE_ASSETS } from './tones';

/**
 * The web's tones. A browser has no silent switch or ringer to honour, so a
 * plain audio element is the alert channel there.
 */
export function useTones(): (cue: SoundCue) => void {
  const incoming = useAudioPlayer(TONE_ASSETS.incoming);
  const outgoing = useAudioPlayer(TONE_ASSETS.outgoing);
  const failure = useAudioPlayer(TONE_ASSETS.failure);
  return useCallback(
    (cue: SoundCue) => {
      const player = { incoming, outgoing, failure }[cue];
      player.seekTo(0);
      player.play();
    },
    [incoming, outgoing, failure],
  );
}
