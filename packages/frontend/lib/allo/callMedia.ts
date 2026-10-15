import { useSyncExternalStore } from 'react';
import type { AlloClient } from '@allo/core';
import { useAlloClient } from '@allo/react';
import type { WebRtcCallMedia } from '@/lib/calls/webrtc';
import { createMediaState } from '@/lib/calls/mediaState';
const mediaByClient = new WeakMap<AlloClient, WebRtcCallMedia>();
const empty = createMediaState();
export function bindCallMedia(client: AlloClient, media: WebRtcCallMedia) {
  mediaByClient.set(client, media);
}
export function useCallMedia() {
  const client = useAlloClient();
  const state = mediaByClient.get(client)?.state ?? empty;
  return useSyncExternalStore(state.subscribe, state.getSnapshot, empty.getSnapshot);
}
