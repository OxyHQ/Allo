import {
  ensureMatrixRecovery,
  type RecoveryCapableClient,
} from '@/lib/matrix/recovery/ensureRecovery';
import type { AlloRecoveryState } from '@/lib/matrix/types';

/**
 * The decision that stands between a user and their message history.
 *
 * Every case below is a state a device really reaches, and in three of them the
 * wrong branch is expensive in a way no test at runtime would catch:
 *
 * - `disabled` → anything but create: recovery never gets set up, and every
 *   message the user sends is only readable on the device that sent it.
 * - `incomplete` → create: a *second* 4S store replaces the first as the
 *   account's default. The keys to the user's history are still on the server
 *   and nothing opens them again.
 * - `enabled`/`unknown` → create: the same loss, from a device that had nothing
 *   wrong with it.
 *
 * The fakes make each of those a visible call rather than an SDK side effect.
 */

class FakeRecoveryClient implements RecoveryCapableClient {
  readonly calls: string[] = [];
  enableRecoveryPassphrase: string | undefined;
  recoverPassphrase: string | undefined;

  #state: AlloRecoveryState;
  #failWith: Error | undefined;

  constructor(state: AlloRecoveryState) {
    this.#state = state;
  }

  failNextAction(error: Error): void {
    this.#failWith = error;
  }

  async recoveryState(): Promise<AlloRecoveryState> {
    this.calls.push('recoveryState');
    return this.#state;
  }

  async enableRecovery(passphrase: string): Promise<void> {
    this.calls.push('enableRecovery');
    this.enableRecoveryPassphrase = passphrase;
    if (this.#failWith !== undefined) {
      throw this.#failWith;
    }
  }

  async recoverWithPassphrase(passphrase: string): Promise<void> {
    this.calls.push('recoverWithPassphrase');
    this.recoverPassphrase = passphrase;
    if (this.#failWith !== undefined) {
      throw this.#failWith;
    }
  }
}

const PHRASE = 'the oxy phrase';
const PASSPHRASE = 'derived-passphrase';

/** Reads a phrase, and records that it was read at all. */
function phraseReader(result: string | null | Error): {
  read: () => Promise<string | null>;
  reads: () => number;
} {
  let reads = 0;
  return {
    read: async () => {
      reads += 1;
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    reads: () => reads,
  };
}

const derivePassphrase = async (phrase: string): Promise<string> => {
  expect(phrase).toBe(PHRASE);
  return PASSPHRASE;
};

describe('ensureMatrixRecovery', () => {
  it('creates 4S when the account has none', async () => {
    const client = new FakeRecoveryClient('disabled');

    await expect(
      ensureMatrixRecovery(client, {
        readPhrase: phraseReader(PHRASE).read,
        derivePassphrase,
      }),
    ).resolves.toEqual({ kind: 'created' });

    expect(client.calls).toEqual(['recoveryState', 'enableRecovery']);
    expect(client.enableRecoveryPassphrase).toBe(PASSPHRASE);
  });

  it('recovers, and never creates, when 4S exists and this device lacks secrets', async () => {
    // The state a new phone is in the moment it finishes signing in. Creating
    // here would replace the account's 4S store and strand the old one.
    const client = new FakeRecoveryClient('incomplete');

    await expect(
      ensureMatrixRecovery(client, {
        readPhrase: phraseReader(PHRASE).read,
        derivePassphrase,
      }),
    ).resolves.toEqual({ kind: 'recovered' });

    expect(client.calls).toEqual(['recoveryState', 'recoverWithPassphrase']);
    expect(client.recoverPassphrase).toBe(PASSPHRASE);
  });

  it('does nothing at all when this device already has everything', async () => {
    const client = new FakeRecoveryClient('enabled');

    await expect(ensureMatrixRecovery(client)).resolves.toEqual({
      kind: 'already-enabled',
    });

    expect(client.calls).toEqual(['recoveryState']);
  });

  it('does not read the Oxy phrase when there is nothing to do', async () => {
    // Reading it can raise a biometric prompt and puts a credential in memory.
    // Neither is acceptable on the ordinary launch of a device that is fine.
    const reader = phraseReader(PHRASE);
    const client = new FakeRecoveryClient('enabled');

    await ensureMatrixRecovery(client, { readPhrase: reader.read, derivePassphrase });

    expect(reader.reads()).toBe(0);
  });

  it('acts on nothing while the crypto stack has not settled', async () => {
    // `unknown` is the native binding's answer for the first moments of a
    // session. Guessing `disabled` here destroys 4S; guessing `enabled` skips a
    // recovery the device needed. Waiting is the only correct move.
    const reader = phraseReader(PHRASE);
    const client = new FakeRecoveryClient('unknown');

    await expect(
      ensureMatrixRecovery(client, { readPhrase: reader.read, derivePassphrase }),
    ).resolves.toEqual({ kind: 'skipped', reason: 'state-not-settled' });

    expect(client.calls).toEqual(['recoveryState']);
    expect(reader.reads()).toBe(0);
  });

  it('reports a device with no stored phrase separately from one that could not be read', async () => {
    // Two different things to do about them: the first needs the user to type
    // the phrase, the second needs another attempt in a moment. Collapsing them
    // either nags a user who can do nothing or silently drops a recovery that
    // would have worked.
    const absent = new FakeRecoveryClient('incomplete');
    await expect(
      ensureMatrixRecovery(absent, {
        readPhrase: phraseReader(null).read,
        derivePassphrase,
      }),
    ).resolves.toEqual({ kind: 'skipped', reason: 'no-phrase-on-this-device' });
    expect(absent.calls).toEqual(['recoveryState']);

    const locked = new FakeRecoveryClient('incomplete');
    await expect(
      ensureMatrixRecovery(locked, {
        readPhrase: phraseReader(new Error('keychain is locked')).read,
        derivePassphrase,
      }),
    ).resolves.toEqual({ kind: 'skipped', reason: 'phrase-unreadable' });
    expect(locked.calls).toEqual(['recoveryState']);
  });

  it('creates nothing when the phrase is missing on a device with no 4S either', async () => {
    // Both halves are absent, which is web today. The temptation is to "set
    // something up anyway"; there is nothing to set it up from.
    const client = new FakeRecoveryClient('disabled');

    await expect(
      ensureMatrixRecovery(client, {
        readPhrase: phraseReader(null).read,
        derivePassphrase,
      }),
    ).resolves.toEqual({ kind: 'skipped', reason: 'no-phrase-on-this-device' });

    expect(client.calls).toEqual(['recoveryState']);
  });

  it('lets a failed recovery reach the caller instead of reporting a skip', async () => {
    // "It did not need doing" and "it was tried and failed" are answers the UI
    // has to draw differently: only one of them means the user's history is not
    // here and something is wrong.
    const client = new FakeRecoveryClient('incomplete');
    const failure = new Error('the homeserver refused');
    client.failNextAction(failure);

    await expect(
      ensureMatrixRecovery(client, {
        readPhrase: phraseReader(PHRASE).read,
        derivePassphrase,
      }),
    ).rejects.toBe(failure);
  });

  it('lets a failed creation reach the caller too', async () => {
    const client = new FakeRecoveryClient('disabled');
    const failure = new Error('a backup already exists on the server');
    client.failNextAction(failure);

    await expect(
      ensureMatrixRecovery(client, {
        readPhrase: phraseReader(PHRASE).read,
        derivePassphrase,
      }),
    ).rejects.toBe(failure);
  });

  it('never reports the passphrase in what it returns', async () => {
    // The outcome is the value that gets logged, put in state, and shown. It
    // must not be a place a credential can travel.
    const client = new FakeRecoveryClient('incomplete');

    const outcome = await ensureMatrixRecovery(client, {
      readPhrase: phraseReader(PHRASE).read,
      derivePassphrase,
    });

    expect(JSON.stringify(outcome)).not.toContain(PASSPHRASE);
    expect(JSON.stringify(outcome)).not.toContain(PHRASE);
  });
});
