/**
 * The seam between domain code and Socket.IO.
 *
 * Presence is deliberately NOT here. Everything below is a room emit a route
 * or a worker asks for; presence is per SOCKET, decided by what that socket
 * said it was showing, and it belongs to `presenceHub.ts`.
 *
 * Routes and workers emit through {@link getRealtime}; without a server set
 * (tests, one-shot scripts) every call is a no-op. Importing this module never
 * creates a server. `src/runtime/socket.ts` builds the real implementation.
 */

import type {
  HistoryOfferEvent,
  InstanceApprovedEvent,
  InstanceRevokedEvent,
  KeyPackagesLowEvent,
  StatusPostedEvent,
  SyncNudgeEvent,
  TypingEvent,
} from "@allo/shared-types";

export interface Realtime {
  /** `sync.nudge` to each instance's room: something is waiting in its stream. */
  nudge(instanceIds: readonly string[], event: SyncNudgeEvent): void;
  instanceApproved(instanceId: string, event: InstanceApprovedEvent): void;
  instanceRevoked(accountId: string, event: InstanceRevokedEvent): void;
  keyPackagesLow(instanceId: string, event: KeyPackagesLowEvent): void;
  /** `history.offer` to the recipient instance's room: another instance of its account offered it history. */
  historyOffer(instanceId: string, event: HistoryOfferEvent): void;
  /** `status.posted` to a recipient instance's room: something it holds a key for was posted. */
  statusPosted(instanceId: string, event: StatusPostedEvent): void;
  typing(instanceIds: readonly string[], event: TypingEvent): void;
  /** Whether at least one socket of the instance is connected — across every task when the Redis adapter is attached. */
  isInstanceConnected(instanceId: string): Promise<boolean>;
  /** Disconnect every socket of the instance; the next handshake is refused by the signature check. */
  disconnectInstance(instanceId: string): Promise<void>;
}

/** The implementation every emit falls back to: silence. */
export const NOOP_REALTIME: Realtime = {
  nudge: () => undefined,
  instanceApproved: () => undefined,
  instanceRevoked: () => undefined,
  keyPackagesLow: () => undefined,
  historyOffer: () => undefined,
  statusPosted: () => undefined,
  typing: () => undefined,
  isInstanceConnected: async () => false,
  disconnectInstance: async () => undefined,
};

let current: Realtime = NOOP_REALTIME;

export function setRealtime(realtime: Realtime): void {
  current = realtime;
}

export function getRealtime(): Realtime {
  return current;
}

export function clearRealtime(realtime?: Realtime): void {
  if (!realtime || current === realtime) current = NOOP_REALTIME;
}
