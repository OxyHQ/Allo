import type { BridgeNetwork } from './contract';

/**
 * How a remote network is drawn, given only its id.
 *
 * ## This is a lookup, not a catalogue
 *
 * `docs/matrix/bridges.md` §9.2: **the app carries no list of networks.** What
 * exists is whatever `GET /api/bridges/networks` returned, and turning one on has
 * to be an environment variable and a deploy rather than a release in two app
 * stores. So nothing here decides whether a network is offered — every function
 * takes a network the server already sent, and an id this build has never heard
 * of gets a usable rendering instead of an error or an omission.
 *
 * The distinction is worth stating because the two look identical in a diff and
 * behave in opposite ways the day someone enables Slack: a catalogue would hide
 * it until the app ships again, a lookup draws it with its initial and its real
 * name from the server.
 *
 * ## Why the marks are monochrome
 *
 * Two reasons that happen to agree.
 *
 * Allo's rule is that colour comes from `theme.colors.*` and nowhere else, so a
 * table of brand hexes here would be the exact thing that rule forbids — and it
 * would be wrong in dark mode, where a brand's own green stops meeting contrast
 * against the row it sits on.
 *
 * And §11 records that Telegram's API terms forbid using their logos. A mark
 * drawn in the interface's own ink, at text size, next to a conversation's name,
 * is identification — the same thing a file-type glyph does — rather than
 * borrowed branding. It is the narrower reading, and it is the one that does not
 * need a lawyer before the feature can ship.
 */

/**
 * The glyph for a network, from FontAwesome 6's `brands` set.
 *
 * Keyed by the backend's own network ids (`config/bridges.ts`). `messenger` is
 * the one that does not match its glyph name, which is why this map exists at all
 * rather than passing the id straight through.
 */
const BRAND_GLYPHS: Readonly<Record<string, string>> = Object.freeze({
  telegram: 'telegram',
  whatsapp: 'whatsapp',
  slack: 'slack',
  discord: 'discord',
  instagram: 'instagram',
  messenger: 'facebook-messenger',
});

/**
 * A brand glyph, or `undefined` for a network with no mark in this build.
 *
 * `undefined` is a supported outcome and not a failure: {@link networkInitial}
 * covers it, and a network drawn with its initial is legible in a way that a
 * missing row is not.
 */
export function networkBrandGlyph(networkId: string): string | undefined {
  return BRAND_GLYPHS[networkId];
}

/** The fallback mark: the first character of whatever the server called it. */
export function networkInitial(network: Pick<BridgeNetwork, 'displayName'>): string {
  return network.displayName.trim().charAt(0).toUpperCase();
}

/**
 * Whether linking this network has to be preceded by the account-ban warning.
 *
 * Keyed off `requiresProxy`, which is the server's word for "this network's
 * anti-fraud makes a shared datacentre egress unacceptable" (§8). That is the
 * same population as "this network bans accounts it catches on an unofficial
 * client": WhatsApp and Meta need a per-user residential exit precisely because
 * they act on the correlation, and Telegram does not need one because it does
 * not.
 *
 * Deriving it rather than listing WhatsApp and Instagram by name is not
 * fastidiousness. A hardcoded pair would go quietly out of date the day
 * `messenger` is enabled — and the failure would be a user linking a
 * ban-prone account with no warning at all, which is the one outcome this
 * feature exists to prevent.
 */
export function requiresBanWarning(
  network: Pick<BridgeNetwork, 'requiresProxy'>,
): boolean {
  return network.requiresProxy;
}

/**
 * Whether a flow should ask for a phone number before it starts.
 *
 * Only the proxy-requiring networks have any use for it: §8.3 rule 2 makes the
 * number one of three hints for choosing which country a lease egresses from, and
 * for every other network the backend would receive a phone number it has nothing
 * to do with. Not sending it is the cheapest privacy measure available.
 */
export function wantsPhoneNumberHint(
  network: Pick<BridgeNetwork, 'requiresProxy'>,
): boolean {
  return network.requiresProxy;
}

/**
 * Capabilities the user must be told are missing, at the moment of linking.
 *
 * §11 is explicit that Telegram's secret chats belong here and not in a FAQ: they
 * cannot be bridged for an architectural reason — a bridge authenticates as a new
 * device and a secret chat's keys are bound to the device that accepted it — and
 * a user who links Telegram and cannot find them will conclude the bridge is
 * broken, correctly, if nobody said so.
 *
 * Only `false` entries are returned. A capability the network HAS is not news.
 */
export function missingCapabilities(
  network: Pick<BridgeNetwork, 'capabilities'>,
): readonly string[] {
  return Object.entries(network.capabilities)
    .filter(([, supported]) => supported === false)
    .map(([name]) => name);
}
