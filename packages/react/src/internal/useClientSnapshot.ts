/**
 * The one primitive every hook is built on: `useSyncExternalStore` over a
 * client topic and the matching getter. Core caches every snapshot and
 * replaces it only when the topic emits, so the getter is safe to call on
 * every render and React sees a stable reference between emissions.
 */
import type { AlloClient, SubscriptionTopic } from "@allo/core";
import { useCallback, useRef, useSyncExternalStore } from "react";

export function useClientSnapshot<T>(client: AlloClient, topic: SubscriptionTopic, getSnapshot: () => T): T {
  const subscribe = useCallback((onChange: () => void) => client.subscribe(topic, onChange), [client, topic]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * For a getter that builds a new value on every call: the value is read once
 * per emission of the topic and held until the next, so React sees a stable
 * reference. `client.instance.current()` is the one such getter today.
 */
export function useVersionedClientSnapshot<T>(client: AlloClient, topic: SubscriptionTopic, getSnapshot: () => T): T {
  const cache = useRef<{ client: AlloClient; topic: SubscriptionTopic; version: number; read: number; value: T } | null>(null);
  if (cache.current === null || cache.current.client !== client || cache.current.topic !== topic) {
    cache.current = { client, topic, version: 0, read: -1, value: undefined as T };
  }
  const subscribe = useCallback(
    (onChange: () => void) =>
      client.subscribe(topic, () => {
        if (cache.current) cache.current.version++;
        onChange();
      }),
    [client, topic],
  );
  const read = useCallback(() => {
    const c = cache.current!;
    if (c.read !== c.version) {
      c.value = getSnapshot();
      c.read = c.version;
    }
    return c.value;
    // getSnapshot is a fresh closure every render over the same getter; the version is what invalidates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, topic]);
  return useSyncExternalStore(subscribe, read, read);
}

const TOPIC_SEPARATOR = "|";

/** The same, over several topics at once, for a value that depends on more than one emitter. */
export function useClientSnapshotOf<T>(client: AlloClient, topics: readonly SubscriptionTopic[], getSnapshot: () => T): T {
  const key = topics.join(TOPIC_SEPARATOR);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribes = key.split(TOPIC_SEPARATOR).map((topic) => client.subscribe(topic as SubscriptionTopic, onChange));
      return () => {
        for (const off of unsubscribes) off();
      };
    },
    [client, key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
