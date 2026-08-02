import {
  bridgeAccountListSchema,
  bridgeLinkPollSchema,
  bridgeLinkStateSchema,
  bridgeNetworkListSchema,
  isWaitingPoll,
} from '@/lib/bridges/contract';

/**
 * `/api/bridges/*` as a boundary (`docs/matrix/bridges.md` §5.2).
 *
 * The payload is relayed from a mautrix bridge — another project, on a monthly
 * CalVer schedule, which has already deleted an entire provisioning API version
 * (§10.1). The backend narrows that shape; it does not author it. And a phone
 * that has not been updated in six months talks to today's backend regardless.
 *
 * So these tests are about the two directions separately: what must be rejected
 * loudly, and what must keep working when the server adds something the app has
 * never seen.
 */

const TELEGRAM = {
  id: 'telegram',
  displayName: 'Telegram',
  requiresProxy: false,
  capabilities: { secretChats: false },
  loginFlows: [{ id: 'phone', name: 'Phone number' }],
};

describe('a network catalogue', () => {
  it('accepts the payload the backend documents', () => {
    const parsed = bridgeNetworkListSchema.parse({ networks: [TELEGRAM] });

    expect(parsed.networks[0]).toMatchObject({
      id: 'telegram',
      requiresProxy: false,
      capabilities: { secretChats: false },
    });
  });

  it('keeps working against a backend too old to send requiresProxy', () => {
    /**
     * Version skew, and the default is chosen with the trade in front of us: a
     * missing field means the app still lists the network rather than refusing to
     * draw a screen. It also means no ban warning for it — which is why exactly
     * one function reads this field, so the day that trade needs revisiting there
     * is one place to change.
     */
    const { requiresProxy, ...withoutField } = TELEGRAM;
    expect(requiresProxy).toBe(false);

    const parsed = bridgeNetworkListSchema.parse({ networks: [withoutField] });
    expect(parsed.networks[0].requiresProxy).toBe(false);
  });

  it('accepts a network id this build has never heard of', () => {
    /**
     * §9.2: turning a network on is an environment variable and a deploy, not a
     * release in two app stores. A client that rejected `"signal"` because its
     * build predated it would make that impossible.
     */
    const parsed = bridgeNetworkListSchema.parse({
      networks: [{ ...TELEGRAM, id: 'signal', displayName: 'Signal' }],
    });

    expect(parsed.networks[0].id).toBe('signal');
  });

  it('accepts a login field type the bridge invented after this build shipped', () => {
    /**
     * The ten `user_input` field types belong to the bridge, not to Allo. An enum
     * here would turn a bridge release adding an eleventh into a login that
     * cannot start, when the correct behaviour is a plain text box.
     */
    const parsed = bridgeLinkStateSchema.parse({
      linkId: 'lnk_1',
      network: 'telegram',
      expiresAt: '2026-08-01T12:00:00.000Z',
      step: {
        type: 'user_input',
        stepId: 'fi.mau.telegram.login.phone_number',
        fields: [{ id: 'f', type: 'retina_scan' }],
      },
    });

    expect(parsed.step.fields?.[0].type).toBe('retina_scan');
  });

  it('rejects a network with no way to sign in', () => {
    /**
     * §5.2: a network whose flows cannot be read is omitted by the backend rather
     * than listed without them, because a row that cannot start a login is worse
     * than no row. If one arrives anyway, it is a broken payload and not a network.
     */
    expect(() =>
      bridgeNetworkListSchema.parse({ networks: [{ ...TELEGRAM, loginFlows: [] }] }),
    ).toThrow();
  });

  it('rejects a step type the app has no way to draw', () => {
    /**
     * §5.2 pins the relayed set to three of bridgev2's six. `cookies` is Meta's
     * webview login: real, refused by the backend, and a client that accepted it
     * here would draw an empty screen and hang — the failure the closed enum
     * exists to turn into a legible error.
     */
    expect(() =>
      bridgeLinkStateSchema.parse({
        linkId: 'lnk_1',
        network: 'instagram',
        expiresAt: '2026-08-01T12:00:00.000Z',
        step: { type: 'cookies', stepId: 'meta.login.cookies' },
      }),
    ).toThrow();
  });
});

describe('the long-poll behind a QR code', () => {
  const WAITING = {
    linkId: 'lnk_1',
    network: 'whatsapp',
    expiresAt: '2026-08-01T12:00:00.000Z',
    waiting: true as const,
  };

  const ADVANCED = {
    linkId: 'lnk_1',
    network: 'whatsapp',
    expiresAt: '2026-08-01T12:00:00.000Z',
    step: {
      type: 'display_and_wait',
      stepId: 'fi.mau.whatsapp.login.qr',
      display: { type: 'qr', data: 'refreshed-code' },
    },
  };

  it('tells a waiting answer from an advanced one', () => {
    /**
     * A timeout is not an error (§5.2): a phone cannot hold an HTTP request open
     * indefinitely, so the backend answers with the step unchanged and the client
     * asks again.
     */
    expect(isWaitingPoll(bridgeLinkPollSchema.parse(WAITING))).toBe(true);
    expect(isWaitingPoll(bridgeLinkPollSchema.parse(ADVANCED))).toBe(false);
  });

  it('does not lose a delivered step to the looser branch of the union', () => {
    /**
     * The stricter shape is tried first on purpose. A union that matched the
     * waiting shape first would parse a real step as "nothing happened" — and on a
     * QR screen the visible symptom is a code that never refreshes and a login
     * that silently expires.
     */
    const parsed = bridgeLinkPollSchema.parse(ADVANCED);

    expect(isWaitingPoll(parsed)).toBe(false);
    if (!isWaitingPoll(parsed)) {
      expect(parsed.step.display?.data).toBe('refreshed-code');
    }
  });
});

describe('a linked account', () => {
  it('accepts the six states the backend collapses the bridge into', () => {
    const parsed = bridgeAccountListSchema.parse({
      accounts: [
        { id: 'a1', network: 'telegram', state: 'connected' },
        { id: 'a2', network: 'telegram', state: 'action_required', errorCode: 'X' },
      ],
    });

    expect(parsed.accounts.map((account) => account.state)).toEqual([
      'connected',
      'action_required',
    ]);
  });

  it('rejects a state nobody has written a sentence for', () => {
    /**
     * Closed, unlike the network id, and for the opposite reason: the app has to
     * SAY something for each state, and there is no sensible rendering of one no
     * screen has words for.
     */
    expect(() =>
      bridgeAccountListSchema.parse({
        accounts: [{ id: 'a1', network: 'telegram', state: 'BACKFILLING' }],
      }),
    ).toThrow();
  });
});
