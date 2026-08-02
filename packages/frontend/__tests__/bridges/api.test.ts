import {
  BridgeApiError,
  listBridgeAccounts,
  listBridgeNetworks,
  reconnectBridgeAccount,
  startBridgeLink,
  unlinkBridgeAccount,
} from '@/lib/bridges/api';
import { api } from '@/utils/api';

jest.mock('@/utils/api', () => ({
  api: {
    get: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

const mockedApi = api as jest.Mocked<typeof api>;

/**
 * The client for `/api/bridges/*`: what it sends, and what it does with an answer
 * that is not what it asked for.
 *
 * The transport is mocked because none of the behaviour under test is transport
 * behaviour — it is parsing, path construction and the mapping from a failure to
 * something a screen can branch on.
 */

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reading the catalogue', () => {
  it('returns the networks in the order the server chose', () => {
    /**
     * `loadBridgesConfig` emits them in catalogue order — stable across
     * deployments, unlike the order somebody typed into an environment variable.
     * A second sort in the client would be a second thing that can disagree with
     * the first.
     */
    mockedApi.get.mockResolvedValue({
      data: {
        networks: [
          { id: 'telegram', displayName: 'Telegram', loginFlows: [{ id: 'phone', name: 'P' }] },
          { id: 'slack', displayName: 'Slack', loginFlows: [{ id: 'oauth', name: 'O' }] },
        ],
      },
    });

    return listBridgeNetworks().then((networks) => {
      expect(networks.map((network) => network.id)).toEqual(['telegram', 'slack']);
      expect(mockedApi.get).toHaveBeenCalledWith('/bridges/networks');
    });
  });

  it('reports a response whose shape has moved as exactly that', async () => {
    /**
     * §10.1 rates breakage-by-bridge-update as near certain, and the first
     * question in that ticket is always which side moved. `bridge_response_invalid`
     * is a deploy skew; `bridge_request_failed` is an outage. Conflating them
     * costs an afternoon.
     */
    mockedApi.get.mockResolvedValue({ data: { networks: [{ id: 'telegram' }] } });

    await expect(listBridgeNetworks()).rejects.toMatchObject({
      name: 'BridgeApiError',
      code: 'bridge_response_invalid',
    });
  });

  it('keeps the backend error code so a screen can act on it', async () => {
    /**
     * The difference between a field to correct and a screen to back out of.
     * `FI.MAU.TELEGRAM.PHONE_CODE_INVALID` arrives verbatim from the bridge, which
     * is why `code` is a string and not an enum.
     */
    mockedApi.post.mockRejectedValue({
      status: 400,
      data: { error: 'FI.MAU.TELEGRAM.PHONE_CODE_INVALID', message: 'Invalid code' },
    });

    await expect(
      startBridgeLink({ networkId: 'telegram', flowId: 'phone' }),
    ).rejects.toMatchObject({
      code: 'FI.MAU.TELEGRAM.PHONE_CODE_INVALID',
      message: 'Invalid code',
      status: 400,
    });
  });

  it('survives a failure that carries no envelope at all', async () => {
    mockedApi.get.mockRejectedValue(new Error('Network request failed'));

    const error = await listBridgeAccounts().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BridgeApiError);
    expect((error as BridgeApiError).code).toBe('bridge_request_failed');
  });
});

describe('starting a link', () => {
  const STARTED = {
    linkId: 'lnk_1',
    network: 'telegram',
    expiresAt: '2026-08-01T12:00:00.000Z',
    step: {
      type: 'user_input',
      stepId: 'fi.mau.telegram.login.phone_number',
      fields: [{ id: 'phone', type: 'phone_number' }],
    },
  };

  it('sends only the flow when the network needs no country hint', async () => {
    /**
     * §5.5: the phone number exists solely to choose a proxy lease's country. For
     * a network with no lease it is a phone number the backend has nothing to do
     * with, and the cheapest way not to leak a piece of data is not to send it.
     */
    mockedApi.post.mockResolvedValue({ data: STARTED });

    await startBridgeLink({ networkId: 'telegram', flowId: 'phone' });

    expect(mockedApi.post).toHaveBeenCalledWith('/bridges/networks/telegram/link', {
      flowId: 'phone',
    });
  });

  it('sends the country hint when one was given', async () => {
    mockedApi.post.mockResolvedValue({ data: STARTED });

    await startBridgeLink({
      networkId: 'whatsapp',
      flowId: 'qr',
      phoneNumberHint: '+34600111222',
    });

    expect(mockedApi.post).toHaveBeenCalledWith('/bridges/networks/whatsapp/link', {
      flowId: 'qr',
      phoneNumberHint: '+34600111222',
    });
  });

  it('escapes a network id rather than pasting it into a path', async () => {
    mockedApi.post.mockResolvedValue({ data: STARTED });

    await startBridgeLink({ networkId: 'a/b', flowId: 'phone' });

    expect(mockedApi.post).toHaveBeenCalledWith('/bridges/networks/a%2Fb/link', {
      flowId: 'phone',
    });
  });
});

describe('acting on a linked account', () => {
  it('unlinks by id', async () => {
    mockedApi.delete.mockResolvedValue({ data: { id: 'acc_1', unlinked: true } });

    await unlinkBridgeAccount('acc_1');

    expect(mockedApi.delete).toHaveBeenCalledWith('/bridges/accounts/acc_1');
  });

  it('returns the state a reconnect settled on', async () => {
    /**
     * Not a no-op that answers 200. bridgev2 has no reconnect call, so the backend
     * re-reads `whoami` and reconciles — which is what clears an account the
     * staleness sweep marked `failed` while the bridge was in fact fine.
     */
    mockedApi.post.mockResolvedValue({ data: { id: 'acc_1', state: 'connected' } });

    await expect(reconnectBridgeAccount('acc_1')).resolves.toBe('connected');
    expect(mockedApi.post).toHaveBeenCalledWith('/bridges/accounts/acc_1/reconnect', {});
  });
});
