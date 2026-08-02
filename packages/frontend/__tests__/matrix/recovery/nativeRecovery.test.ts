import { EnableRecoveryProgress, RecoveryState } from '@unomed/react-native-matrix-sdk';

import {
  describeEnableRecoveryProgress,
  toRecoveryState,
} from '@/lib/matrix/native/recovery';

jest.mock('@unomed/react-native-matrix-sdk');

/**
 * The native binding's recovery vocabulary, translated.
 *
 * Two things are being protected. One is the mapping itself: swap `Disabled`
 * and `Incomplete` and the state machine creates a second 4S store for a device
 * that only needed to open the first. The other is what the progress listener is
 * allowed to say — the `Done` variant carries the recovery key, and a listener
 * that logs its payload writes a credential that opens the user's whole history
 * into the log.
 */

describe('toRecoveryState', () => {
  it('maps every state the binding has', () => {
    expect(toRecoveryState(RecoveryState.Disabled)).toBe('disabled');
    expect(toRecoveryState(RecoveryState.Incomplete)).toBe('incomplete');
    expect(toRecoveryState(RecoveryState.Enabled)).toBe('enabled');
    expect(toRecoveryState(RecoveryState.Unknown)).toBe('unknown');
  });

  it('does not collapse “not settled yet” into any actionable state', () => {
    // `Unknown` means the crypto stack has not finished starting. Reporting it
    // as `disabled` would have the caller create 4S over an account that has it.
    expect(toRecoveryState(RecoveryState.Unknown)).not.toBe('disabled');
    expect(toRecoveryState(RecoveryState.Unknown)).not.toBe('enabled');
  });
});

describe('describeEnableRecoveryProgress', () => {
  it('never repeats the recovery key the final step carries', () => {
    const recoveryKey = 'EsTb VXCk 6bV3 vGSX zPtN VNPa Zbnc CrhV kBEQ TTfE Nefv N9Hh';

    const description = describeEnableRecoveryProgress(
      new EnableRecoveryProgress.Done({ recoveryKey }),
    );

    expect(description).toBe('done');
    expect(description).not.toContain(recoveryKey);
    // Not even a fragment of it: the key is grouped in fours and a description
    // that quoted "part" of it would still be a leak.
    expect(description).not.toContain('EsTb');
  });

  it('reports the steps that carry no secret', () => {
    expect(describeEnableRecoveryProgress(new EnableRecoveryProgress.Starting())).toBe(
      'starting',
    );
    expect(describeEnableRecoveryProgress(new EnableRecoveryProgress.CreatingBackup())).toBe(
      'creating the key backup',
    );
    expect(
      describeEnableRecoveryProgress(new EnableRecoveryProgress.CreatingRecoveryKey()),
    ).toBe('creating the recovery key');
  });

  it('reports how far the room key upload has got', () => {
    expect(
      describeEnableRecoveryProgress(
        new EnableRecoveryProgress.BackingUp({ backedUpCount: 12, totalCount: 40 }),
      ),
    ).toBe('backing up room keys (12/40)');
  });

  it('reports a failed batch as a step that will retry, not as the end', () => {
    // The binding keeps going after one; describing it as a failure of the whole
    // call would have the app tell the user recovery did not happen.
    expect(
      describeEnableRecoveryProgress(new EnableRecoveryProgress.RoomKeyUploadError()),
    ).toBe('a batch of room keys failed to upload; the backup will retry');
  });
});
