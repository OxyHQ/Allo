import { OxyServices } from '@oxy.so/core';
import { createSessionAdapter } from '@/lib/allo/session';

// Local claims are transport fixtures; no server treats them as signed authority.
const fixtureToken = (userId: string, revision: number, seconds = 3600) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ userId, sessionId: `session-${userId}`, revision, exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url')}.fixture`;
const baseURL = 'https://api.allo.you';

describe('Allo session adapter on the canonical shared transport', () => {
  afterEach(() => jest.restoreAllMocks());
  it('refreshes sockets, observes account changes and never lends the old client another account', async () => {
    const oxy = new OxyServices({ baseURL: 'http://127.0.0.1:1' });
    oxy.session.setAccessToken(fixtureToken('account-a', 1, 1));
    const session = createSessionAdapter(oxy, baseURL);
    const observed: (string | null)[] = [];
    const stop = session.subscribe(() => observed.push(session.getAccountId()));
    try {
      const fresh = fixtureToken('account-a', 2);
      const refresh = jest.fn(async () => fresh);
      oxy.http.setAuthRefreshHandler(refresh);
      expect(await session.getAccessToken()).toBe(fresh);
      expect(refresh).toHaveBeenCalledTimes(1);
      const b = fixtureToken('account-b', 3);
      oxy.session.setAccessToken(b);
      expect(session.getAccountId()).toBe('account-b');
      expect(await session.getAccessToken()).toBeNull();
      await expect(session.authenticatedFetch?.(`${baseURL}/v1/messages`)).rejects.toThrow(
        'account session changed',
      );
      oxy.session.clear();
      expect(session.getAccountId()).toBeNull();
      expect(await session.getAccessToken()).toBeNull();
      expect(observed).toEqual(['account-a', 'account-b', null]);
      stop();
      oxy.session.setAccessToken(fresh);
      expect(observed).toHaveLength(3);
      session.dispose();
      expect(await session.getAccessToken()).toBeNull();
    } finally {
      stop();
      session.dispose();
      oxy.dispose();
    }
  });
  it('forwards HTTP through the linked client and releases its owned subscription', async () => {
    let current = 'account-a';
    const fetch = jest.fn(async () => ({ status: 204 }) as Response);
    const getAccessToken = jest.fn(async () => 'fresh-from-shared-transport');
    const dispose = jest.fn();
    const linked = { fetch, getAccessToken, dispose };
    const createLinkedClient = jest.fn(() => linked);
    const session = createSessionAdapter(
      {
        session: {
          get userId() {
            return current;
          },
          onChange: () => () => {},
        },
        createLinkedClient,
      },
      baseURL,
    );
    expect(createLinkedClient).toHaveBeenCalledWith({ baseURL });
    const headers = { 'X-Allo-Signature': 'existing-instance-signature' };
    await session.authenticatedFetch?.(`${baseURL}/v1/messages`, {
      method: 'POST',
      body: 'bytes',
      headers,
    });
    expect(fetch).toHaveBeenCalledWith(`${baseURL}/v1/messages`, {
      method: 'POST',
      body: 'bytes',
      headers,
    });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(await session.getAccessToken()).toBe('fresh-from-shared-transport');
    expect(getAccessToken).toHaveBeenCalledWith(baseURL);
    current = 'account-b';
    expect(await session.getAccessToken()).toBeNull();
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    session.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
