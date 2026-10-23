import { describe, expect, it, mock } from 'bun:test';
import {
  alloDirectMessageLinks,
  alloShareLinks,
  alloStoreUrl,
  openInAllo,
  type OpenInAlloDeps,
} from '../links';

const ID = '01929c4e-7b1a-7c3d-9e2f-0a1b2c3d4e5f';

describe('links', () => {
  it('addresses a direct conversation by account id, and nothing that could escape the segment', () => {
    expect(alloDirectMessageLinks(` ${ID} `)).toEqual({
      app: `allo://c/${ID}`,
      web: `https://allo.you/c/${ID}`,
    });
    for (const bad of [undefined, '', 'a/b', 'a?b', 'a#b', 'a%2Fb', '@alice']) {
      expect(alloDirectMessageLinks(bad)).toBeNull();
    }
  });

  it('carries a direct message draft as one encoded query value, and no blank one', () => {
    const text = 'see https://e.x/p/1?a=1&b=2';
    expect(alloDirectMessageLinks(ID, { text: ` ${text} ` })?.app).toBe(
      `allo://c/${ID}?text=${encodeURIComponent(text)}`,
    );
    expect(alloDirectMessageLinks(ID, { text: '  ' })?.app).toBe(`allo://c/${ID}`);
  });

  it('carries share text as one encoded query value', () => {
    const text = 'https://mention.earth/p/abc?x=1&y=2#z';
    expect(alloShareLinks(text)?.web).toBe(
      `https://allo.you/share?text=${encodeURIComponent(text)}`,
    );
    expect(alloShareLinks('   ')).toBeNull();
  });

  it('accepts only an https store listing for the platform', () => {
    const listings = { ios: 'https://apps.apple.com/app/id1', android: 'market://details?id=x' };
    expect(alloStoreUrl('ios', listings)).toBe(listings.ios);
    expect(alloStoreUrl('android', listings)).toBeUndefined();
    expect(alloStoreUrl('web', listings)).toBeUndefined();
  });
});

describe('openInAllo', () => {
  const links = alloDirectMessageLinks(ID);
  const deps = (overrides: Partial<OpenInAlloDeps> = {}) =>
    ({
      platformOS: 'android',
      openAppUrl: mock(() => Promise.resolve(true)),
      openWebUrl: mock(() => Promise.resolve()),
      offerInstall: mock(() => {}),
      ...overrides,
    }) satisfies OpenInAlloDeps;
  const notInstalled = () => mock(() => Promise.reject(new Error('No Activity found')));

  it('takes the installed app, or the web app on web', async () => {
    expect(await openInAllo(links, deps())).toBe('app');
    const web = deps({ platformOS: 'web' });
    expect(await openInAllo(links, web)).toBe('web');
    expect(web.openWebUrl).toHaveBeenCalledWith(`https://allo.you/c/${ID}`);
    expect(web.openAppUrl).not.toHaveBeenCalled();
  });

  it('without the app, offers the store when listed, else opens the web app', async () => {
    const listed = deps({ openAppUrl: notInstalled(), storeUrl: 'https://store.example/allo' });
    expect(await openInAllo(links, listed)).toBe('offered');
    expect(listed.offerInstall).toHaveBeenCalledWith({
      storeUrl: 'https://store.example/allo',
      webUrl: `https://allo.you/c/${ID}`,
    });
    expect(await openInAllo(links, deps({ openAppUrl: notInstalled() }))).toBe('browser');
  });

  it('opens nothing without links', async () => {
    const d = deps();
    expect(await openInAllo(null, d)).toBe('invalid');
    expect(d.openAppUrl).not.toHaveBeenCalled();
  });
});
