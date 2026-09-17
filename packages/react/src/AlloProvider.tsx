/**
 * `<AlloProvider client={client}>` puts one `AlloClient` in React context and
 * owns the per-tree caches the hooks share (decrypted media, the last
 * instance error). It does NOT start the client: the app decides when, once
 * the Oxy session is known, and calls `client.start()` itself.
 */
import type { AlloClient } from "@allo/core";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { InstanceErrorTracker } from "./errorTracker";
import { DEFAULT_MEDIA_CACHE_SIZE, MediaCache } from "./mediaCache";

export interface AlloContextValue {
  client: AlloClient;
  mediaCache: MediaCache;
  instanceErrors: InstanceErrorTracker;
}

const AlloContext = createContext<AlloContextValue | null>(null);
AlloContext.displayName = "AlloContext";

export interface AlloProviderProps {
  client: AlloClient;
  /** Decrypted media blobs kept in memory for `useMediaFile`. Default 50. */
  mediaCacheSize?: number;
  children?: ReactNode;
}

export function AlloProvider({ client, mediaCacheSize = DEFAULT_MEDIA_CACHE_SIZE, children }: AlloProviderProps) {
  const value = useMemo<AlloContextValue>(
    () => ({ client, mediaCache: new MediaCache(mediaCacheSize), instanceErrors: new InstanceErrorTracker(client) }),
    [client, mediaCacheSize],
  );
  useEffect(() => value.instanceErrors.attach(), [value]);
  return <AlloContext.Provider value={value}>{children}</AlloContext.Provider>;
}

const OUTSIDE_PROVIDER = "@allo/react: no AlloProvider found. Wrap the tree in <AlloProvider client={client}> before using Allo hooks.";

/** Internal: the whole context. Throws outside the provider. */
export function useAlloContext(): AlloContextValue {
  const value = useContext(AlloContext);
  if (!value) throw new Error(OUTSIDE_PROVIDER);
  return value;
}

/** The client the nearest `AlloProvider` holds. Throws with a clear message outside one. */
export function useAlloClient(): AlloClient {
  return useAlloContext().client;
}
