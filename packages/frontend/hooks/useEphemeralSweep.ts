import { useSyncExternalStore } from 'react';

import { CHAT_BACKEND } from '@/lib/chat/backend';
import { ephemeralSweeper } from '@/lib/chat/ephemeralSweep';
import type { AlloUnsubscribe } from '@/lib/matrix/types';

/**
 * Keeps this device removing its own expired messages from the homeserver.
 *
 * Subscribing is what runs the sweep — the same rule the conversation list
 * follows — so this is called once, from the chat layout, and no screen has to
 * remember anything. It answers with the conversations currently on a timer,
 * which is a fact worth being able to show and which no caller has to use.
 *
 * It is a hook and not a module-level side effect because a module that started
 * a sweep when it was imported would start one in every test that imported
 * anything near it, and because there is nothing to sweep before there is a
 * session. It is not an Effect because there is nothing to synchronise on a
 * render: the sweep belongs to the app, and `useSyncExternalStore` is how React
 * reads something that outlives the component reading it.
 */

const NOTHING: readonly string[] = [];
const NO_UNSUBSCRIBE: AlloUnsubscribe = () => {};
const subscribeToNothing = (): AlloUnsubscribe => NO_UNSUBSCRIBE;
const nothing = (): readonly string[] => NOTHING;

const enabled = CHAT_BACKEND === 'matrix';

export function useEphemeralSweep(): readonly string[] {
  return useSyncExternalStore(
    enabled ? ephemeralSweeper.subscribe : subscribeToNothing,
    enabled ? ephemeralSweeper.getSnapshot : nothing,
    nothing,
  );
}
