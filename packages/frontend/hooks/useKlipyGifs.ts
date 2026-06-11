/**
 * React Query hook backing the GIF picker (F2.6).
 *
 * Returns an infinite, paginated stream of GIFs: trending when the (trimmed)
 * query is empty, search results otherwise. Pagination uses Klipy's 1-based page
 * cursor; `fetchNextPage` advances it. Switching between trending and a search
 * term changes the query key, so React Query caches each independently and
 * cancels the in-flight request via the provided `AbortSignal`.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchTrendingGifs, searchGifs, type KlipyGif, type KlipyGifPage } from '@/lib/klipy';

/** Stable query-key root so all GIF queries share a cache namespace. */
const GIF_QUERY_KEY = 'klipy-gifs';

/** First (1-based) page Klipy serves. */
const FIRST_PAGE = 1;

/** Flattened result + the infinite-query controls the picker grid needs. */
export interface UseKlipyGifsResult {
  gifs: KlipyGif[];
  isLoading: boolean;
  isError: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
}

/**
 * Build the query function for a given (already-trimmed) search term. Exported so
 * the page-cursor logic can be unit-tested with a mocked fetch, independent of
 * React.
 */
export function makeGifQueryFn(trimmedQuery: string) {
  return ({
    pageParam,
    signal,
  }: {
    pageParam: number;
    signal: AbortSignal;
  }): Promise<KlipyGifPage> =>
    trimmedQuery.length === 0
      ? fetchTrendingGifs(pageParam, signal)
      : searchGifs(trimmedQuery, pageParam, signal);
}

/** Derive the next 1-based page cursor from a fetched page (null = exhausted). */
export function getNextGifPageParam(lastPage: KlipyGifPage): number | null {
  return lastPage.nextPage;
}

export function useKlipyGifs(query: string): UseKlipyGifsResult {
  const trimmedQuery = query.trim();

  const result = useInfiniteQuery({
    queryKey: [GIF_QUERY_KEY, trimmedQuery],
    queryFn: makeGifQueryFn(trimmedQuery),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: getNextGifPageParam,
    staleTime: 5 * 60 * 1000,
  });

  const gifs = result.data?.pages.flatMap((page) => page.gifs) ?? [];

  return {
    gifs,
    isLoading: result.isLoading,
    isError: result.isError,
    isFetchingNextPage: result.isFetchingNextPage,
    hasNextPage: result.hasNextPage,
    fetchNextPage: () => {
      void result.fetchNextPage();
    },
    refetch: () => {
      void result.refetch();
    },
  };
}
