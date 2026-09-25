import React from 'react';
import { Linking } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { hrefFromUrl, rememberPendingHref, takePendingHref } from '@/lib/navigation/pendingHref';
import { resetInitialUrlForTests, usePendingHref } from '@/lib/navigation/usePendingHref';

/**
 * A DEEP LINK SURVIVES SIGN-IN.
 *
 * Signed out, `allo://c/<id>` or `https://allo.you/c/<id>` was redirected to the
 * welcome screen and, after signing in, landed on the chat list: the
 * conversation the link named was lost (OxyHQ/Allo#176).
 */

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));

describe('hrefFromUrl', () => {
  it.each([
    ['https://allo.you/c/0190abc', '/c/0190abc'],
    ['https://allo.you/c/0190abc/', '/c/0190abc'],
    ['https://allo.you/c/0190abc?x=1#frag', '/c/0190abc?x=1'],
    ['allo://c/0190abc', '/c/0190abc'],
    ['allo:///c/0190abc', '/c/0190abc'],
    ['allo://@alice', '/@alice'],
    ['allo://dm/alice', '/dm/alice'],
    ['exp://192.168.1.2:8081/--/c/0190abc', '/c/0190abc'],
    ['/settings/devices', '/settings/devices'],
  ])('%s -> %s', (url, href) => {
    expect(hrefFromUrl(url)).toBe(href);
  });

  it.each([
    null,
    '',
    'https://allo.you',
    'https://allo.you/',
    'allo://',
    'exp://192.168.1.2:8081',
    // OAuth callbacks land on the app, but they are not where anybody was going.
    'https://allo.you/?code=abc&state=def',
    'allo://oauth?code=abc&state=def',
    'https://allo.you/c/x?error=access_denied',
    // Never another origin.
    'https://allo.you//evil.example/x',
    'not a url',
  ])('%s -> null', (url) => {
    expect(hrefFromUrl(url)).toBeNull();
  });
});

describe('the pending href', () => {
  it('is handed back once, and the latest destination wins', () => {
    rememberPendingHref('/c/one');
    rememberPendingHref(null);
    rememberPendingHref('/c/two');
    expect(takePendingHref()).toBe('/c/two');
    expect(takePendingHref()).toBeNull();
  });
});

describe('usePendingHref', () => {
  let launchUrl: string | null;
  let urlListener: ((event: { url: string }) => void) | null;

  function Probe({ signedIn }: { signedIn: boolean }) {
    usePendingHref(signedIn);
    return null;
  }

  async function render(signedIn: boolean) {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe signedIn={signedIn} />);
    });
    return {
      update: async (next: boolean) => {
        await act(async () => renderer.update(<Probe signedIn={next} />));
      },
      unmount: () => act(() => renderer.unmount()),
    };
  }

  beforeEach(() => {
    mockReplace.mockReset();
    resetInitialUrlForTests();
    takePendingHref();
    launchUrl = null;
    urlListener = null;
    jest.spyOn(Linking, 'getInitialURL').mockImplementation(() => Promise.resolve(launchUrl));
    jest.spyOn(Linking, 'addEventListener').mockImplementation(((_type: string, listener: (event: { url: string }) => void) => {
      urlListener = listener;
      return { remove: () => { urlListener = null; } };
    }) as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('opens the conversation a signed-out launch link named, once signed in', async () => {
    launchUrl = 'https://allo.you/c/0190abc';
    const app = await render(false);
    expect(mockReplace).not.toHaveBeenCalled();

    await app.update(true);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith('/c/0190abc');
    app.unmount();
  });

  it('keeps a link that arrives while the app is running signed out', async () => {
    const app = await render(false);
    act(() => urlListener?.({ url: 'allo://c/0190def' }));

    await app.update(true);
    expect(mockReplace).toHaveBeenCalledWith('/c/0190def');
    app.unmount();
  });

  it('does nothing without a link, and does not replay the launch link after a sign-out', async () => {
    launchUrl = 'allo://c/0190abc';
    const app = await render(false);
    await app.update(true);
    expect(mockReplace).toHaveBeenCalledTimes(1);

    await app.update(false);
    await app.update(true);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it('ignores links while signed in, which the router already follows', async () => {
    launchUrl = 'allo://c/0190abc';
    const app = await render(true);
    act(() => urlListener?.({ url: 'allo://c/0190def' }));
    expect(mockReplace).not.toHaveBeenCalled();
    expect(takePendingHref()).toBeNull();
    app.unmount();
  });
});
