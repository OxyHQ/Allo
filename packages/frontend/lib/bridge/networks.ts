/**
 * Interop bridge (F3.x) — per-network presentation metadata.
 *
 * Static, render-time descriptors for the external networks Allo can bridge to:
 * the human label shown on badges/cards and the Ionicons glyph used for the
 * network avatar fallback. Kept separate from `@allo/shared-types`
 * (`NETWORK_CAPABILITIES`) because those are wire/behaviour facts shared with the
 * backend, whereas these are frontend-only display strings/icons.
 */

import type { Ionicons } from '@expo/vector-icons';
import type { Network } from '@allo/shared-types';

/** Ionicons glyph name (typed so it can be passed straight to `<Ionicons name>`). */
type IoniconName = keyof typeof Ionicons.glyphMap;

/** Networks the bridge UI surfaces today. `allo` is native and never bridged. */
export const BRIDGEABLE_NETWORKS: Exclude<Network, 'allo'>[] = ['telegram'];

interface NetworkPresentation {
  /** Human-facing network name (e.g. shown on the conversation badge). */
  readonly label: string;
  /** Ionicons glyph used as the network avatar / card icon. */
  readonly icon: IoniconName;
  /** Accent color for the network badge/icon (brand color). */
  readonly color: string;
}

/**
 * Display metadata per network. The labels are proper nouns (brand names) and are
 * intentionally NOT translated. `allo` is included for completeness but is never
 * rendered as a bridged network.
 */
export const NETWORK_PRESENTATION: Record<Network, NetworkPresentation> = {
  allo: { label: 'Allo', icon: 'chatbubble-ellipses', color: '#005c67' },
  telegram: { label: 'Telegram', icon: 'paper-plane', color: '#229ED9' },
  whatsapp: { label: 'WhatsApp', icon: 'logo-whatsapp', color: '#25D366' },
  gmessages: { label: 'Google Messages', icon: 'chatbubbles', color: '#1A73E8' },
};

/** Resolve the display label for a network (brand name; not translated). */
export function networkLabel(network: Network): string {
  return NETWORK_PRESENTATION[network]?.label ?? network;
}
