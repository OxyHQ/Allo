import { planKeyBackup, toRecoveryState } from '@/lib/matrix/web/recovery';

/**
 * The two judgements the web half has to assemble, which the native binding
 * makes for itself.
 *
 * Both of them decide whether something irreversible happens, so both are worth
 * more than the four lines each takes to write.
 */

describe('toRecoveryState', () => {
  it('reports no 4S on the account as disabled', () => {
    expect(
      toRecoveryState({ defaultKeyId: null, crossSigningReady: false, backupActive: false }),
    ).toBe('disabled');
  });

  it('reports 4S that exists as never disabled, whatever this device has', () => {
    // The dangerous direction. `disabled` sends the caller to `enableRecovery`,
    // which creates a second store and makes it the account's default — the old
    // one, holding the keys to the history, stops being reachable.
    for (const crossSigningReady of [true, false]) {
      for (const backupActive of [true, false]) {
        expect(
          toRecoveryState({ defaultKeyId: 'KEYID', crossSigningReady, backupActive }),
        ).not.toBe('disabled');
      }
    }
  });

  it('reports a device with cross-signing and a running backup as enabled', () => {
    expect(
      toRecoveryState({ defaultKeyId: 'KEYID', crossSigningReady: true, backupActive: true }),
    ).toBe('enabled');
  });

  it('reports a device with cross-signing but no running backup as incomplete', () => {
    // It is verified, and it still cannot read a word of anything sent before it
    // existed. That is not "done".
    expect(
      toRecoveryState({ defaultKeyId: 'KEYID', crossSigningReady: true, backupActive: false }),
    ).toBe('incomplete');
  });

  it('reports a device with a running backup but no cross-signing as incomplete', () => {
    // Unverified, so everyone it talks to sees an unverified device — and it
    // does not hold the self-signing key that recovery would give it.
    expect(
      toRecoveryState({ defaultKeyId: 'KEYID', crossSigningReady: false, backupActive: true }),
    ).toBe('incomplete');
  });

  it('never answers unknown', () => {
    // Web has no equivalent of the binding's unsettled state: every input is a
    // definite answer or an exception. An `unknown` here would stall recovery
    // forever, because nothing on this platform would ever resolve it.
    const answers = [null, 'KEYID'].flatMap((defaultKeyId) =>
      [true, false].flatMap((crossSigningReady) =>
        [true, false].map((backupActive) =>
          toRecoveryState({ defaultKeyId, crossSigningReady, backupActive }),
        ),
      ),
    );
    expect(answers).not.toContain('unknown');
  });
});

describe('planKeyBackup', () => {
  it('creates a backup when the server holds none', () => {
    expect(planKeyBackup({ serverHasBackup: false, backupActive: false })).toBe('create');
  });

  it('adopts the backup this device is already running', () => {
    // Creating here would mint a new version and abandon the old one.
    expect(planKeyBackup({ serverHasBackup: true, backupActive: true })).toBe('adopt-active');
  });

  it('refuses when the server holds a backup this device is not using', () => {
    // The case that loses history. A new version would leave every room key that
    // only the old version holds decryptable by a key nobody is left holding.
    // The native SDK raises `BackupExistsOnServer` for exactly this.
    expect(planKeyBackup({ serverHasBackup: true, backupActive: false })).toBe('refuse');
  });

  it('never creates over a backup that is already on the server', () => {
    for (const backupActive of [true, false]) {
      expect(planKeyBackup({ serverHasBackup: true, backupActive })).not.toBe('create');
    }
  });
});
