import { useEffect, useRef } from "react";
import { useAlloContext } from "../AlloProvider";

/**
 * Calls `onError` for every error the client reports (sync, outbox, decrypt,
 * transport). The callback may change between renders without re-subscribing.
 */
export function useAlloErrors(onError: (error: unknown) => void): void {
  const { client } = useAlloContext();
  const latest = useRef(onError);
  latest.current = onError;
  useEffect(() => client.onError((error) => latest.current(error)), [client]);
}
