import type { BackupStatus } from "@allo/core";
import { useCallback, useMemo } from "react";
import { useAlloContext } from "../AlloProvider";
import { useClientSnapshot } from "../internal/useClientSnapshot";

export interface Backup {
  /** Referentially stable between `backup` emissions. `remote` is `null` until `refreshStatus()` has asked the server. */
  status: BackupStatus;
  /**
   * Turns the encrypted backup on and resolves to the 12-word recovery phrase.
   * It is returned ONCE and stored nowhere: the SDK keeps only the key derived
   * from it. Show it, have the person confirm they wrote it down, and drop it.
   * Rejects (`InvalidStateError`) when already enabled.
   */
  enable(): Promise<string>;
  /** Exports, encrypts and uploads now, replacing the previous backup. The SDK also refreshes on its own after enough new events. */
  refresh(): Promise<void>;
  /** Deletes the remote backup and forgets the key. Idempotent. */
  disable(): Promise<void>;
  /**
   * Rebuilds conversations and timelines from the account's backup on a fresh
   * device. A wrong phrase rejects with `RecoveryPhraseError` before anything
   * is downloaded; on success the key is kept so refreshes continue from here.
   */
  restore(phrase: string): Promise<void>;
  /** Asks the server whether a backup exists; the answer lands in `status.remote`. */
  refreshStatus(): Promise<void>;
}

/** Encrypted account backup and recovery. Subscribes to `backup`. */
export function useBackup(): Backup {
  const { client } = useAlloContext();
  const status = useClientSnapshot(client, "backup", () => client.backup.status());
  const enable = useCallback(() => client.backup.enable(), [client]);
  const refresh = useCallback(() => client.backup.refresh(), [client]);
  const disable = useCallback(() => client.backup.disable(), [client]);
  const restore = useCallback((phrase: string) => client.backup.restore(phrase), [client]);
  const refreshStatus = useCallback(() => client.backup.refreshStatus(), [client]);
  return useMemo(() => ({ status, enable, refresh, disable, restore, refreshStatus }), [status, enable, refresh, disable, restore, refreshStatus]);
}
