import { EnableRecoveryProgress_Tags, RecoveryState } from '@unomed/react-native-matrix-sdk';
import type { EnableRecoveryProgress } from '@unomed/react-native-matrix-sdk';

import type { AlloRecoveryState } from '@/lib/matrix/types';

/**
 * Translation of the binding's recovery vocabulary into the port's, and the one
 * rule about what may be said out loud while recovery runs.
 *
 * Pure functions of SDK records, which is what makes this the part of the native
 * recovery path that can be tested without a device.
 */

/**
 * A lookup table rather than a switch, so the compiler notices when the binding
 * gains a variant: a missing key is a type error, not a silent fall-through to
 * whichever branch happened to be last.
 */
const RECOVERY_STATES: Record<RecoveryState, AlloRecoveryState> = {
  [RecoveryState.Unknown]: 'unknown',
  [RecoveryState.Enabled]: 'enabled',
  [RecoveryState.Disabled]: 'disabled',
  [RecoveryState.Incomplete]: 'incomplete',
};

export function toRecoveryState(state: RecoveryState): AlloRecoveryState {
  return RECOVERY_STATES[state];
}

/**
 * A log line for one step of `enableRecovery`, or `undefined` for a step not
 * worth a line.
 *
 * **The reason this function exists at all is the `Done` variant.** It carries
 * `recoveryKey`: the base58 form of the 4S key, a credential exactly as powerful
 * as the passphrase it was derived from — anyone holding it opens the user's
 * entire message history. The obvious implementation of a progress listener is
 * `logger.info(JSON.stringify(progress))`, and that one writes it to the log.
 * So the translation is a named, tested function instead of a line inside a
 * callback, and `Done` is reported by name with its payload dropped.
 *
 * `RoomKeyUploadError` is a step failing, not the whole call: the binding keeps
 * going and retries, so it is reported as a warning rather than raised.
 */
export function describeEnableRecoveryProgress(
  progress: EnableRecoveryProgress,
): string | undefined {
  switch (progress.tag) {
    case EnableRecoveryProgress_Tags.Starting:
      return 'starting';
    case EnableRecoveryProgress_Tags.CreatingBackup:
      return 'creating the key backup';
    case EnableRecoveryProgress_Tags.CreatingRecoveryKey:
      return 'creating the recovery key';
    case EnableRecoveryProgress_Tags.BackingUp:
      return `backing up room keys (${progress.inner.backedUpCount}/${progress.inner.totalCount})`;
    case EnableRecoveryProgress_Tags.RoomKeyUploadError:
      return 'a batch of room keys failed to upload; the backup will retry';
    case EnableRecoveryProgress_Tags.Done:
      // Deliberately not `progress.inner.recoveryKey`.
      return 'done';
  }
}
