import type { TimelineItemView } from '@allo/core';
import { useCall } from '@allo/react';
import { useScreenVisible } from '@oxy.so/bloom/screen';
import { useEffect, useRef } from 'react';

import { type SoundCueMemory, soundCue } from '@/lib/chat/soundCue';
import { useTones } from '@/lib/sounds/useTones';
import { useSoundStore } from '@/stores/soundStore';

/** A burst (a group catching up, an album) is one tone, not one per message. */
const MIN_GAP_MS = 1_500;

/**
 * The open conversation's tones. Silent while nobody can see the conversation
 * (the app in the background, where the notification speaks, or another
 * screen over it) and during a call, whose audio a tone would talk over. How a tone is played, so that it honours the silent switch, is
 * `useTones`.
 */
export function useConversationSounds(items: readonly TimelineItemView[]): void {
  const enabled = useSoundStore((state) => state.conversationTones);
  const inCall = useCall() !== null;
  const visible = useScreenVisible();
  const play = useTones();
  const memory = useRef<SoundCueMemory | null>(null);
  const lastPlayed = useRef(0);
  useEffect(() => {
    const now = Date.now();
    const next = soundCue(memory.current, items, now);
    memory.current = next.memory;
    if (!next.cue || !enabled || inCall || !visible) return;
    // A failure always speaks: it is the one tone that asks for something.
    if (next.cue !== 'failure' && now - lastPlayed.current < MIN_GAP_MS) return;
    lastPlayed.current = now;
    play(next.cue);
  }, [items, enabled, inCall, visible, play]);
}
