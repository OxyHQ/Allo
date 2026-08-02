import {
  missingCapabilities,
  networkBrandGlyph,
  networkInitial,
  requiresBanWarning,
  wantsPhoneNumberHint,
} from '@/lib/bridges/networkPresentation';

/**
 * How a network is drawn, and — the part that carries product weight — when the
 * user is warned before linking one.
 *
 * The theme running through every test here is `docs/matrix/bridges.md` §9.2:
 * **the app carries no list of networks.** So the assertions are about
 * behaviour under an id the build has never seen, and about the warning being
 * derived from what the server said rather than from a pair of names somebody
 * typed.
 */

describe('the account-ban warning is derived, never listed', () => {
  it('warns for any network the server marks as needing a proxy', () => {
    /**
     * §8: `requiresProxy` is the server's own word for "this network's anti-fraud
     * acts on correlated egress" — which is the same population as "this network
     * bans accounts it catches on an unofficial client". WhatsApp and Meta need a
     * per-user residential exit for exactly that reason.
     */
    expect(requiresBanWarning({ requiresProxy: true })).toBe(true);
  });

  it('does not warn for a network that does not', () => {
    /**
     * The discrimination is the point. A warning shown on every network is a
     * warning users learn to dismiss, and then it is not there when it matters.
     */
    expect(requiresBanWarning({ requiresProxy: false })).toBe(false);
  });

  it('warns for a network id this build has never heard of, if the server says so', () => {
    /**
     * The failure a hardcoded `['whatsapp', 'instagram']` would produce: the day
     * `messenger` is enabled, a user links a ban-prone account with no warning at
     * all. Nothing in this module can tell which network this is, and that is
     * what makes the day-one behaviour correct.
     */
    expect(requiresBanWarning({ requiresProxy: true })).toBe(true);
    expect(networkBrandGlyph('a-network-invented-tomorrow')).toBeUndefined();
  });

  it('asks for a country hint exactly where a proxy lease has to choose one', () => {
    /**
     * §8.3 rule 2. The number is one of three hints for the lease's country and is
     * never stored; for a network with no lease it would be a phone number the
     * backend has nothing to do with, so it is not collected.
     */
    expect(wantsPhoneNumberHint({ requiresProxy: true })).toBe(true);
    expect(wantsPhoneNumberHint({ requiresProxy: false })).toBe(false);
  });
});

describe('drawing a network', () => {
  it('has a brand mark for every network in the backend catalogue', () => {
    /**
     * These six ids are `config/bridges.ts`'s catalogue. Asserted so that a
     * network gaining a row there and losing its mark here is visible — the
     * fallback would hide it as a perfectly reasonable-looking letter.
     */
    expect(networkBrandGlyph('telegram')).toBe('telegram');
    expect(networkBrandGlyph('whatsapp')).toBe('whatsapp');
    expect(networkBrandGlyph('slack')).toBe('slack');
    expect(networkBrandGlyph('discord')).toBe('discord');
    expect(networkBrandGlyph('instagram')).toBe('instagram');
    expect(networkBrandGlyph('messenger')).toBe('facebook-messenger');
  });

  it('has no mark for an unknown network, and says so rather than guessing', () => {
    expect(networkBrandGlyph('matrix')).toBeUndefined();
  });

  it('falls back to the initial of whatever the server called it', () => {
    /**
     * The ordinary case the first time a deployment turns a new network on — not
     * an error, and not a reason to draw nothing.
     */
    expect(networkInitial({ displayName: 'Signal' })).toBe('S');
    expect(networkInitial({ displayName: '  slack ' })).toBe('S');
  });
});

describe('what a network cannot do, said at the moment of linking', () => {
  it('reports a capability the network lacks', () => {
    /**
     * §11: Telegram's secret chats cannot be bridged, and the reason is
     * architectural — a bridge authenticates as a new device, and a secret chat's
     * keys are bound to the device that accepted it. The design is explicit that
     * this belongs at the moment of linking and not in a FAQ, because a user who
     * cannot find those chats will conclude the bridge is broken and will be right
     * to complain if nobody said so.
     */
    expect(missingCapabilities({ capabilities: { secretChats: false } })).toEqual([
      'secretChats',
    ]);
  });

  it('says nothing about a capability the network has', () => {
    expect(missingCapabilities({ capabilities: { secretChats: true } })).toEqual([]);
    expect(missingCapabilities({ capabilities: {} })).toEqual([]);
  });
});
