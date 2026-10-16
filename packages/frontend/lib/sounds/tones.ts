import type { SoundCue } from '@/lib/chat/soundCue';

/** The three conversation tones. */
export const TONE_ASSETS: Readonly<Record<SoundCue, number>> = {
  incoming: require('@/assets/sounds/incoming.wav'),
  outgoing: require('@/assets/sounds/outgoing.wav'),
  failure: require('@/assets/sounds/failure.wav'),
};

/** A fixed order, for an API that loads the tones as a list. */
export const TONE_CUES: readonly SoundCue[] = ['incoming', 'outgoing', 'failure'];
