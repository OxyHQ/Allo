import type { HistoryOfferView, HistoryProgress } from "@allo/core";
import { useCallback, useMemo } from "react";
import { useAlloContext } from "../AlloProvider";
import { useClientSnapshot } from "../internal/useClientSnapshot";

export interface HistoryTransfer {
  /**
   * What this device is doing with history right now. `phase` is `idle` when
   * nothing is; while receiving, `fromInstanceId` names the donor so a banner
   * can say whose history is arriving. Referentially stable between `history`
   * emissions.
   */
  progress: HistoryProgress;
  /** Offers made to THIS device, as last listed. The SDK auto-accepts one from a verified same-account device; the rest wait here. */
  pendingOffers: HistoryOfferView[];
  /** Accepts an offer by hand. Refuses (`UntrustedInstanceError`) a donor that is not an active, chain-verified instance of this account. */
  accept(offerId: string): Promise<void>;
  /** Re-lists pending offers from the server. */
  refresh(): Promise<void>;
}

/**
 * E2EE history transfer between devices of one account. Subscribes to
 * `history`. A newly approved device normally needs none of the actions: the
 * elector offers once it has added the device to a group, and the device
 * accepts on its own; the screen only has to watch `progress`.
 */
export function useHistoryTransfer(): HistoryTransfer {
  const { client } = useAlloContext();
  const progress = useClientSnapshot(client, "history", () => client.history.progress());
  const pendingOffers = useClientSnapshot(client, "history", () => client.history.pendingOffers());
  const accept = useCallback((offerId: string) => client.history.accept(offerId), [client]);
  const refresh = useCallback(() => client.history.refreshOffers(), [client]);
  return useMemo(() => ({ progress, pendingOffers, accept, refresh }), [progress, pendingOffers, accept, refresh]);
}
