import type { AlloError, InstanceState, InstanceView, PendingEnrollmentView } from "@allo/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAlloContext } from "../AlloProvider";
import { useClientSnapshot, useVersionedClientSnapshot } from "../internal/useClientSnapshot";

export interface InstanceStateView {
  state: InstanceState;
  /** This installation's registered instance, `null` before registration or after `reset()`. */
  instance: InstanceView | null;
  /** The last error the client reported while not `active`; cleared once it is. */
  error?: AlloError;
}

/** This device's enrollment state. Subscribes to `instance`. */
export function useInstanceState(): InstanceStateView {
  const { client, instanceErrors } = useAlloContext();
  const state = useClientSnapshot(client, "instance", () => client.instance.state());
  // `current()` builds a new view per call (core has no cache for it), so it is read once per `instance` emission.
  const instance = useVersionedClientSnapshot(client, "instance", () => client.instance.current());
  const subscribeErrors = useCallback((onChange: () => void) => instanceErrors.subscribe(onChange), [instanceErrors]);
  const getError = useCallback(() => instanceErrors.current(), [instanceErrors]);
  const error = useSyncExternalStore(subscribeErrors, getError, getError);
  return useMemo(() => (error ? { state, instance, error } : { state, instance }), [state, instance, error]);
}

export interface OwnInstances {
  /** Every instance of this account the server lists, this one included (`isThis`). */
  instances: InstanceView[];
  revoke(instanceId: string): Promise<void>;
  /** Re-fetches the list from the server. */
  refresh(): Promise<void>;
}

/** The account's devices. Subscribes to `instances`. */
export function useOwnInstances(): OwnInstances {
  const { client } = useAlloContext();
  const instances = useClientSnapshot(client, "instances", () => client.instance.list());
  const revoke = useCallback((instanceId: string) => client.instance.revoke(instanceId), [client]);
  const refresh = useCallback(() => client.instance.refresh(), [client]);
  return useMemo(() => ({ instances, revoke, refresh }), [instances, revoke, refresh]);
}

export interface PendingEnrollments {
  pending: PendingEnrollmentView[];
  /** Approves; pass the challenge the user verified by fingerprint so a swapped one is refused before anything is signed. */
  approve(instanceId: string, expectedChallenge?: string): Promise<void>;
  reject(instanceId: string): Promise<void>;
  /** Re-fetches pending enrollments from the server. */
  refresh(): Promise<void>;
}

/** Devices of this account waiting for approval. Subscribes to `instances`. */
export function usePendingEnrollments(): PendingEnrollments {
  const { client } = useAlloContext();
  const pending = useClientSnapshot(client, "instances", () => client.instance.pending());
  const approve = useCallback((instanceId: string, expectedChallenge?: string) => client.instance.approve(instanceId, expectedChallenge), [client]);
  const reject = useCallback((instanceId: string) => client.instance.reject(instanceId), [client]);
  const refresh = useCallback(() => client.instance.refreshPending(), [client]);
  return useMemo(() => ({ pending, approve, reject, refresh }), [pending, approve, reject, refresh]);
}
