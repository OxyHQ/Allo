import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { MediaRef } from '@allo/react';

import { type MediaUriState, useMediaUri } from '@/lib/allo/useMediaUri';
import { type StatusMediaState, useStatusMedia } from '@/lib/allo/useStatusMedia';

/**
 * `useMediaUri` and `useStatusMedia` answer a URI DERIVED from their current
 * inputs rather than one an effect resets: a URI the cleanup has just released
 * (a revoked object URL, a deleted cache file) must never be answered again —
 * not after the bytes go away, not when the same media is switched off and on.
 * The SDK hooks and the platform sink are replaced so every step is held still.
 */

const mockMinted: { uri: string; released: boolean }[] = [];
jest.mock('@/lib/allo/mediaSink', () => ({
  createMediaUri: (_bytes: Uint8Array, mime: string, blobId: string) => {
    const entry = { uri: `mem://${blobId}/${mime}/${mockMinted.length + 1}`, released: false };
    mockMinted.push(entry);
    return {
      uri: entry.uri,
      release: () => {
        entry.released = true;
      },
    };
  },
}));

let mockFile: { status: 'loading' | 'ready' | 'error'; bytes?: Uint8Array; error?: unknown } = {
  status: 'loading',
};
const mockPendingStatusMedia: {
  id: string;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
}[] = [];
const mockClient = {
  statuses: {
    media: (id: string) =>
      new Promise<Uint8Array>((resolve, reject) => {
        mockPendingStatusMedia.push({ id, resolve, reject });
      }),
  },
};
jest.mock('@allo/react', () => ({
  useMediaFile: (ref: unknown) => (ref ? mockFile : { status: 'loading' }),
  useAlloClient: () => mockClient,
}));
jest.mock('@/utils/logger', () => ({ logger: { debug: jest.fn() } }));

beforeEach(() => {
  mockMinted.length = 0;
  mockPendingStatusMedia.length = 0;
  mockFile = { status: 'loading' };
});

function renderHook<P, R>(hook: (props: P) => R, initial: NoInfer<P>) {
  const result: { current: R | undefined } = { current: undefined };
  function Probe(props: P) {
    result.current = hook(props);
    return null;
  }
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<Probe {...(initial as P & React.JSX.IntrinsicAttributes)} />);
  });
  return {
    result: () => result.current as R,
    rerender: (props: P) =>
      act(() => tree.update(<Probe {...(props as P & React.JSX.IntrinsicAttributes)} />)),
    unmount: () => act(() => tree.unmount()),
  };
}

describe('useMediaUri', () => {
  const ref = { blobId: 'blob-1' } as MediaRef;
  type Props = { mediaRef?: MediaRef; mime: string; enabled?: boolean };
  const hook = ({ mediaRef, mime, enabled }: Props): MediaUriState =>
    useMediaUri(mediaRef, mime, enabled);

  it('answers the URI minted for the current bytes, and never one that was released', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    mockFile = { status: 'ready', bytes };
    const view = renderHook(hook, { mediaRef: ref, mime: 'image/png' });
    expect(view.result().uri).toBe(mockMinted[0].uri);
    expect(view.result().loading).toBe(false);

    // Switched off: the bytes go away and the cleanup releases the URI.
    view.rerender({ mediaRef: ref, mime: 'image/png', enabled: false });
    expect(mockMinted[0].released).toBe(true);
    expect(view.result().uri).toBe('');

    // Back on with the same bytes: a fresh URI, never the released one.
    view.rerender({ mediaRef: ref, mime: 'image/png', enabled: true });
    expect(mockMinted).toHaveLength(2);
    expect(view.result().uri).toBe(mockMinted[1].uri);
    expect(mockMinted[1].released).toBe(false);

    view.unmount();
    expect(mockMinted[1].released).toBe(true);
  });

  it('answers nothing and mints nothing without a ref', () => {
    const view = renderHook(hook, { mediaRef: undefined, mime: 'image/png' });
    expect(view.result()).toMatchObject({ uri: '', loading: true });
    expect(mockMinted).toHaveLength(0);
  });
});

describe('useStatusMedia', () => {
  type Props = { statusId?: string; enabled?: boolean };
  const hook = ({ statusId, enabled }: Props): StatusMediaState =>
    useStatusMedia(statusId, enabled);

  it('loads, settles, and never answers a released picture after being switched off and on', async () => {
    const view = renderHook(hook, { statusId: 's1', enabled: true });
    expect(view.result()).toEqual({ uri: '', loading: true, error: undefined });

    await act(async () => mockPendingStatusMedia[0].resolve(new Uint8Array([9])));
    expect(view.result()).toEqual({ uri: mockMinted[0].uri, loading: false, error: undefined });

    view.rerender({ statusId: 's1', enabled: false });
    expect(mockMinted[0].released).toBe(true);
    expect(view.result()).toEqual({ uri: '', loading: false, error: undefined });

    // The same status opened again: loading, not the URI that was just released.
    view.rerender({ statusId: 's1', enabled: true });
    expect(view.result()).toEqual({ uri: '', loading: true, error: undefined });

    await act(async () => mockPendingStatusMedia[1].resolve(new Uint8Array([9])));
    expect(view.result().uri).toBe(mockMinted[1].uri);
    view.unmount();
  });

  it("does not carry one status's error over to the next", async () => {
    const view = renderHook(hook, { statusId: 's1' });
    const failure = new Error('gone');
    await act(async () => mockPendingStatusMedia[0].reject(failure));
    expect(view.result()).toEqual({ uri: '', loading: false, error: failure });

    view.rerender({ statusId: 's2' });
    expect(view.result()).toEqual({ uri: '', loading: true, error: undefined });
    view.unmount();
  });

  it('answers nothing and is not loading without a status', () => {
    const view = renderHook(hook, { statusId: undefined });
    expect(view.result()).toEqual({ uri: '', loading: false, error: undefined });
    expect(mockPendingStatusMedia).toHaveLength(0);
  });
});
