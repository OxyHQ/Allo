import { QueryClient } from '@tanstack/react-query';

/**
 * React Query client configuration
 * This centralized configuration allows for consistent query behavior throughout the app
 */

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data considered fresh for 5 minutes
      staleTime: 1000 * 60 * 5,

      // Keep unused data in cache for 10 minutes before garbage collection
      gcTime: 1000 * 60 * 10,

      // Smart retry: retry network errors, don't retry 4xx client errors
      retry: (failureCount, error: any) => {
        // Don't retry on 4xx errors (client errors like 404, 401)
        if (error?.response?.status && error.response.status >= 400 && error.response.status < 500) {
          return false;
        }
        // Retry up to 2 times for network errors and 5xx errors
        return failureCount < 2;
      },

      // Exponential backoff for retries
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),

      // Disable automatic refetching when window gets focus (better for mobile apps)
      refetchOnWindowFocus: false,

      // Enable refetching on reconnect (good for recovering from network issues)
      refetchOnReconnect: true,

      // Network mode: online-first, but allow cache when offline
      networkMode: 'online',
    },
    mutations: {
      // Retry mutations once for network errors
      retry: (failureCount, error: any) => {
        if (error?.response?.status && error.response.status >= 400 && error.response.status < 500) {
          return false;
        }
        return failureCount < 1;
      },

      // Network mode for mutations
      networkMode: 'online',
    },
  },
});

/**
 * Custom hook to invalidate all queries matching a specific key pattern
 * Useful for refreshing multiple related queries at once
 */
export function invalidateRelatedQueries(queryClient: QueryClient, keyPattern: unknown[]) {
  // Remove the first element (base type), keep other filtering criteria
  const filterKey = keyPattern.slice(1);
  
  // Find and invalidate all queries that match the pattern
  return queryClient.invalidateQueries({
    predicate: (query) => {
      // Skip if query key isn't an array or doesn't have a base type match
      if (!Array.isArray(query.queryKey) || query.queryKey[0] !== keyPattern[0]) {
        return false;
      }

      // Match if no additional filters, or if all filter criteria are satisfied
      return filterKey.length === 0 || 
        filterKey.every((key, index) => 
          key === undefined || key === query.queryKey[index + 1]
        );
    },
  });
}