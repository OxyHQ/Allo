import type { CallHistoryEntry, CallView } from "@allo/core";
import { useCallback, useMemo } from "react";
import { useAlloContext } from "../AlloProvider";
import { useClientSnapshot } from "../internal/useClientSnapshot";

export interface CallActions {
  /** Rings every other member's devices. Resolves when the server has the call, not when somebody answers. */
  start(conversationId: string, mode?: "voice" | "video"): Promise<CallView>;
  answer(): Promise<void>;
  decline(): Promise<void>;
  end(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setCameraEnabled(on: boolean): Promise<void>;
}

/**
 * The call this device is in, or `null`. One at a time, as a phone does.
 *
 * Subscribes to `call`. The view is a frozen snapshot per change, so a screen
 * re-renders when the call moves and not otherwise.
 *
 * Whether audio actually flows depends on the media adapter the host gave the
 * client (ADR 0002, Decision 5). Without one the call still rings, is
 * answered, declined and ended — which is what a screen should draw anyway,
 * because it never touches the media itself.
 */
export function useCall(): CallView | null {
  const { client } = useAlloContext();
  return useClientSnapshot(client, "call", () => client.calls.current());
}

/** The things a call screen does. Stable across renders. */
export function useCallActions(): CallActions {
  const { client } = useAlloContext();
  const start = useCallback((conversationId: string, mode?: "voice" | "video") => client.calls.start(conversationId, mode), [client]);
  const answer = useCallback(() => client.calls.answer(), [client]);
  const decline = useCallback(() => client.calls.decline(), [client]);
  const end = useCallback(() => client.calls.end(), [client]);
  const setMuted = useCallback((muted: boolean) => client.calls.setMuted(muted), [client]);
  const setCameraEnabled = useCallback((on: boolean) => client.calls.setCameraEnabled(on), [client]);
  return useMemo(
    () => ({ start, answer, decline, end, setMuted, setCameraEnabled }),
    [start, answer, decline, end, setMuted, setCameraEnabled],
  );
}


/**
 * Every call this device knows about, newest first.
 *
 * Read out of the conversations, because that is where the log lives: a
 * `call_log` message syncs, backs up and reaches both accounts' devices the
 * way any message does. Subscribes to `conversations`, so a call that has just
 * ended appears without a refresh.
 *
 * A plain snapshot, because `history()` holds its result until a conversation
 * changes, like every other getter on the client. It did not at first: it
 * rebuilt the array on each call, `useSyncExternalStore` saw a new snapshot on
 * every render and rendered again, and that is minified React error #185 —
 * which is what this crashed with in production the first time somebody
 * pressed call. The fix belongs in the service, so the next consumer of
 * `client.calls.history()` inherits it instead of rediscovering the loop.
 */
export function useCallHistory(): CallHistoryEntry[] {
  const { client } = useAlloContext();
  return useClientSnapshot(client, "conversations", () => client.calls.history());
}
