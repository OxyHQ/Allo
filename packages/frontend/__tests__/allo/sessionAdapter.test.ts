import { OxyServices } from '@oxy.so/core';
import { createSessionAdapter } from '@/lib/allo/session';

// Local transport state only; these unsigned fixture claims are never sent to an API.
const fixtureToken = (userId: string, revision: number) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ userId, revision })).toString('base64url')}.fixture`;

describe('Allo session adapter with the canonical Oxy session namespace', () => {
  it('observes the current effective account during refresh, switch, and sign-out', async () => {
    const oxy = new OxyServices({ baseURL: 'http://127.0.0.1:1' });
    const session = createSessionAdapter(oxy);
    const observed: (string | null)[] = [];
    const stop = session.subscribe(() => observed.push(session.getAccountId()));
    expect(session.getAccountId()).toBeNull();
    expect(await session.getAccessToken()).toBeNull();

    const a = fixtureToken('account-a', 1);
    oxy.session.setAccessToken(a);
    expect(await session.getAccessToken()).toBe(a);
    const refreshed = fixtureToken('account-a', 2);
    oxy.session.setAccessToken(refreshed);
    expect(await session.getAccessToken()).toBe(refreshed);
    const b = fixtureToken('account-b', 3);
    oxy.session.setAccessToken(b);
    expect(session.getAccountId()).toBe('account-b');
    expect(await session.getAccessToken()).toBe(b);
    oxy.session.clear();
    expect(session.getAccountId()).toBeNull();
    expect(await session.getAccessToken()).toBeNull();
    expect(observed).toEqual(['account-a', 'account-a', 'account-b', null]);

    stop();
    oxy.session.setAccessToken(a);
    expect(observed).toHaveLength(4);
    oxy.session.clear();
  });
});
