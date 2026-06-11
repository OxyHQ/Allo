/**
 * Tests for the Klipy GIF client + picker query helpers (F2.6).
 *
 * Covers:
 *  - defensive narrowing of Klipy's nested `file.{hd,md,sm}.gif` renditions
 *  - page-cursor derivation from `has_next`
 *  - search vs trending routing in the query function
 *  - graceful empty result when no app key is configured
 *
 * `fetch` is mocked globally; `@/config` is mocked so the key + base URL are
 * deterministic regardless of the environment.
 */

jest.mock('@/config', () => ({
  KLIPY_APP_KEY: 'test-key',
  KLIPY_API_URL: 'https://api.klipy.test/api/v1',
  KLIPY_PAGE_SIZE: 24,
}));

// eslint-disable-next-line import/first
import { fetchTrendingGifs, searchGifs, isKlipyConfigured } from '@/lib/klipy';
// eslint-disable-next-line import/first
import { makeGifQueryFn, getNextGifPageParam } from '@/hooks/useKlipyGifs';

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function mockFetchOnce(payload: unknown, ok = true, status = 200): jest.Mock {
  const fetchMock = jest.fn(
    (): Promise<MockResponse> =>
      Promise.resolve({ ok, status, json: () => Promise.resolve(payload) })
  );
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

const klipyItem = {
  id: 'abc',
  title: 'happy dance',
  file: {
    hd: { gif: { url: 'https://cdn.klipy.test/abc-hd.gif', width: 480, height: 360 } },
    sm: { gif: { url: 'https://cdn.klipy.test/abc-sm.gif', width: 120, height: 90 } },
  },
};

describe('klipy client', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports configured when an app key is present', () => {
    expect(isKlipyConfigured()).toBe(true);
  });

  it('narrows a trending response into flat KlipyGifs with preview + full urls', async () => {
    mockFetchOnce({ result: true, data: { data: [klipyItem], has_next: true } });
    const page = await fetchTrendingGifs(1);
    expect(page.gifs).toHaveLength(1);
    expect(page.gifs[0]).toMatchObject({
      id: 'abc',
      url: 'https://cdn.klipy.test/abc-hd.gif',
      previewUrl: 'https://cdn.klipy.test/abc-sm.gif',
      width: 480,
      height: 360,
      title: 'happy dance',
    });
    expect(page.nextPage).toBe(2);
  });

  it('returns nextPage=null when has_next is false', async () => {
    mockFetchOnce({ data: { data: [klipyItem], has_next: false } });
    const page = await fetchTrendingGifs(3);
    expect(page.nextPage).toBeNull();
  });

  it('drops items that lack any usable gif rendition', async () => {
    const broken = { id: 'x', file: { hd: { mp4: { url: 'nope' } } } };
    mockFetchOnce({ data: { data: [broken, klipyItem], has_next: false } });
    const page = await fetchTrendingGifs(1);
    expect(page.gifs).toHaveLength(1);
    expect(page.gifs[0].id).toBe('abc');
  });

  it('encodes the query and hits the search endpoint', async () => {
    const fetchMock = mockFetchOnce({ data: { data: [], has_next: false } });
    await searchGifs('cat hugs', 2);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/test-key/gifs/search');
    expect(calledUrl).toContain('q=cat%20hugs');
    expect(calledUrl).toContain('page=2');
  });

  it('throws on a non-2xx response so callers can surface an error', async () => {
    mockFetchOnce({}, false, 500);
    await expect(fetchTrendingGifs(1)).rejects.toThrow('500');
  });
});

describe('useKlipyGifs helpers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('routes empty query to trending and non-empty to search', async () => {
    const fetchMock = mockFetchOnce({ data: { data: [], has_next: false } });
    const signal = new AbortController().signal;

    await makeGifQueryFn('')({ pageParam: 1, signal });
    expect((fetchMock.mock.calls[0][0] as string)).toContain('/gifs/trending');

    await makeGifQueryFn('dogs')({ pageParam: 1, signal });
    expect((fetchMock.mock.calls[1][0] as string)).toContain('/gifs/search');
  });

  it('derives the next page param from the fetched page', () => {
    expect(getNextGifPageParam({ gifs: [], nextPage: 5 })).toBe(5);
    expect(getNextGifPageParam({ gifs: [], nextPage: null })).toBeNull();
  });
});
