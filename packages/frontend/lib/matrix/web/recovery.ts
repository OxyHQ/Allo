import type { AlloRecoveryState } from '@/lib/matrix/types';

/**
 * The two judgements the web recovery path makes, kept apart from the calls that
 * feed them.
 *
 * The native binding answers both of these itself — `recoveryState()` is one
 * call, and `enableRecovery` refuses on its own when a backup it cannot use
 * already exists. On web they have to be assembled, and assembling them is where
 * the expensive mistakes are: reporting `disabled` for an account that has 4S
 * leads straight to creating a second store and stranding the first, and
 * creating a backup version over one already on the server strands every room
 * key that only the old version holds.
 *
 * So both are pure functions of a handful of readings, and both are tested.
 */

/**
 * Assembles {@link AlloRecoveryState} from what the SDK can be asked.
 *
 * @param defaultKeyId the account's default 4S key, or `null` if there is no 4S
 * at all. Authoritative whenever it is read: before the initial sync the SDK
 * fetches the account data from the homeserver rather than reporting the empty
 * store, so "not synced yet" never arrives here disguised as "no recovery".
 * @param crossSigningReady whether this device holds usable cross-signing keys.
 * @param backupActive whether this device's backup engine is running against a
 * version on the server.
 *
 * `unknown` is never returned. On web the crypto stack is fully up before this
 * can be called and every input above is a definite answer or an exception; the
 * state exists in the port for the native binding, which really does spend the
 * first moments of a session unable to say.
 */
export function toRecoveryState({
  defaultKeyId,
  crossSigningReady,
  backupActive,
}: {
  defaultKeyId: string | null;
  crossSigningReady: boolean;
  backupActive: boolean;
}): AlloRecoveryState {
  if (defaultKeyId === null) {
    return 'disabled';
  }
  // Both, not either. A device with cross-signing but no running backup cannot
  // read anything older than itself, which is the whole thing the user is
  // promised; a device with a backup but no cross-signing is not verified and
  // shows up as untrusted to everyone they talk to.
  return crossSigningReady && backupActive ? 'enabled' : 'incomplete';
}

/** What to do about the key backup while 4S is being created. */
export type KeyBackupPlan =
  /** Nothing on the server. Create a version and put its key in 4S. */
  | 'create'
  /** This device is already backing up. Store that key in 4S; create nothing. */
  | 'adopt-active'
  /**
   * The server holds a backup this device is not using. Refuse: see
   * {@link MatrixBackupExistsOnServerError}.
   */
  | 'refuse';

/**
 * Decides whether creating a key backup is safe.
 *
 * The case worth spelling out is the third. `bootstrapSecretStorage` with
 * `setupNewKeyBackup` calls the SDK's backup reset, which mints a *new* version
 * on the server; every room key that lives only in the old version stays there,
 * decryptable by a key nothing is left holding. That is the user's history
 * quietly disappearing at the exact moment the app claimed to be protecting it.
 * The native SDK treats the same situation as an error rather than resolving it,
 * and this is the web half agreeing.
 */
export function planKeyBackup({
  serverHasBackup,
  backupActive,
}: {
  serverHasBackup: boolean;
  backupActive: boolean;
}): KeyBackupPlan {
  if (!serverHasBackup) {
    return 'create';
  }
  return backupActive ? 'adopt-active' : 'refuse';
}
