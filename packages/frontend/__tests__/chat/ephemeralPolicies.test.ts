import {
  EphemeralPolicySource,
  sameEphemeralPolicies,
} from '@/lib/chat/ephemeralPolicies';
import {
  IDLE_RUNTIME_STATE,
  type MatrixRuntimeLike,
  type MatrixRuntimeState,
} from '@/lib/chat/matrixRuntime';
import type {
  AlloChatClient,
  AlloEncryptionState,
  AlloEphemeralPolicy,
  AlloMediaFile,
  AlloOidcLoginRequest,
  AlloRecoveryState,
  AlloRoomDetails,
  AlloRoomListHandle,
  AlloRoomTrust,
  AlloSession,
  AlloTimelineHandle,
  AlloUnsubscribe,
} from '@/lib/matrix/types';

/**
 * Which conversations this account treats as ephemeral, behind
 * `useSyncExternalStore`.
 *
 * Two things are load-bearing and neither is obvious. It has to publish a *new*
 * snapshot only when the answer actually changed, because a new map on every
 * read would re-render the conversation list and re-mask every open timeline;
 * and it has to forget everything when the session goes, because a timer on the
 * conversations of an account nobody is signed in to is a timer that deletes
 * somebody else's messages the moment they sign in.
 */

const ROOM = '!room:allo.you';
const HOUR: AlloEphemeralPolicy = { lifetimeMs: 3_600_000 };
const DAY: AlloEphemeralPolicy = { lifetimeMs: 86_400_000 };

class FakeClient implements AlloChatClient {
  reads = 0;
  writes: { roomId: string; policy: AlloEphemeralPolicy | undefined }[] = [];
  /** What the next read answers with. */
  policies: ReadonlyMap<string, AlloEphemeralPolicy> = new Map();
  failNextRead = false;

  readonly ephemeralPolicies = async (): Promise<ReadonlyMap<string, AlloEphemeralPolicy>> => {
    this.reads += 1;
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error('the homeserver is unreachable');
    }
    return new Map(this.policies);
  };

  readonly setEphemeralPolicy = async (
    roomId: string,
    policy: AlloEphemeralPolicy | undefined,
  ): Promise<void> => {
    this.writes.push({ roomId, policy });
    const next = new Map(this.policies);
    if (policy === undefined) {
      next.delete(roomId);
    } else {
      next.set(roomId, policy);
    }
    this.policies = next;
  };

  /* The rest of the port. Written out rather than cast past the compiler, as
     every other fake client in these tests is: a fake that only claims to be
     part of `AlloChatClient` stops failing to compile when the port grows a
     member, which is exactly when it should. */

  async beginOidcLogin(): Promise<AlloOidcLoginRequest> {
    throw new Error('not used by these tests');
  }

  async resumeOidcLogin(): Promise<undefined> {
    return undefined;
  }

  async restoreSession(): Promise<void> {
    throw new Error('not used by these tests');
  }

  session(): AlloSession {
    throw new Error('not used by these tests');
  }

  observeSession(): AlloUnsubscribe {
    throw new Error('not used by these tests');
  }

  async logout(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async startSync(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async stopSync(): Promise<void> {
    throw new Error('not used by these tests');
  }

  observeSyncState(): AlloUnsubscribe {
    throw new Error('not used by these tests');
  }

  async observeRooms(): Promise<AlloRoomListHandle> {
    throw new Error('not used by these tests');
  }

  async createRoom(): Promise<string> {
    throw new Error('not used by these tests');
  }

  async acceptInvitation(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async leaveRoom(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async roomDetails(): Promise<AlloRoomDetails> {
    throw new Error('not used by these tests');
  }

  async inviteToRoom(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async renameRoom(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async roomTrust(): Promise<AlloRoomTrust> {
    throw new Error('not used by these tests');
  }

  async roomEncryption(): Promise<AlloEncryptionState> {
    throw new Error('not used by these tests');
  }

  async recoveryState(): Promise<AlloRecoveryState> {
    throw new Error('not used by these tests');
  }

  async enableRecovery(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async recoverWithPassphrase(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async openTimeline(): Promise<AlloTimelineHandle> {
    throw new Error('not used by these tests');
  }

  async downloadMedia(): Promise<AlloMediaFile> {
    throw new Error('not used by these tests');
  }

  async registerPusher(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async unregisterPusher(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async close(): Promise<void> {
    throw new Error('not used by these tests');
  }
}

class FakeRuntime implements MatrixRuntimeLike {
  readonly chatClient = new FakeClient();

  #state: MatrixRuntimeState = IDLE_RUNTIME_STATE;
  readonly #listeners = new Set<() => void>();

  subscribe(listener: () => void): AlloUnsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getState(): MatrixRuntimeState {
    return this.#state;
  }

  become(phase: MatrixRuntimeState['phase']): void {
    this.#state = { ...this.#state, phase };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  client(): AlloChatClient {
    return this.chatClient;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function readySource(): { runtime: FakeRuntime; source: EphemeralPolicySource } {
  const runtime = new FakeRuntime();
  return { runtime, source: new EphemeralPolicySource(runtime) };
}

describe('EphemeralPolicySource', () => {
  it('reads nothing until something watches it', async () => {
    const { runtime } = readySource();
    runtime.become('ready');
    await settle();

    expect(runtime.chatClient.reads).toBe(0);
  });

  it('reads the account data as soon as it is watched and the session is up', async () => {
    const { runtime, source } = readySource();
    runtime.chatClient.policies = new Map([[ROOM, HOUR]]);
    runtime.become('ready');

    source.subscribe(() => {});
    await settle();

    expect(source.getSnapshot().get(ROOM)).toEqual(HOUR);
  });

  it('waits for the session rather than failing without one', async () => {
    const { runtime, source } = readySource();
    runtime.chatClient.policies = new Map([[ROOM, HOUR]]);

    source.subscribe(() => {});
    await settle();
    expect(source.getSnapshot().size).toBe(0);

    runtime.become('ready');
    await settle();
    expect(source.getSnapshot().get(ROOM)).toEqual(HOUR);
  });

  it('answers one conversation at a time', async () => {
    const { runtime, source } = readySource();
    runtime.chatClient.policies = new Map([[ROOM, DAY]]);
    runtime.become('ready');
    source.subscribe(() => {});
    await settle();

    expect(source.policyFor(ROOM)).toEqual(DAY);
    expect(source.policyFor('!other:allo.you')).toBeUndefined();
  });

  it('tells its watchers when the answer changes', async () => {
    const { runtime, source } = readySource();
    runtime.become('ready');
    let notifications = 0;
    source.subscribe(() => {
      notifications += 1;
    });
    await settle();

    runtime.chatClient.policies = new Map([[ROOM, HOUR]]);
    await source.refresh();

    expect(notifications).toBe(1);
  });

  it('says nothing when a re-read says the same thing', async () => {
    // Every read builds a new map. Publishing it would give
    // `useSyncExternalStore` a new identity, which re-renders the conversation
    // list and re-schedules the expiry timer of every open conversation.
    const { runtime, source } = readySource();
    runtime.chatClient.policies = new Map([[ROOM, HOUR]]);
    runtime.become('ready');
    let notifications = 0;
    source.subscribe(() => {
      notifications += 1;
    });
    await settle();
    const before = notifications;

    await source.refresh();
    await source.refresh();

    expect(notifications).toBe(before);
  });

  it('writes the change and then reads it back', async () => {
    // Not optimistic. A screen saying "messages disappear after a day" while the
    // homeserver has no such record is a promise nothing is keeping.
    const { runtime, source } = readySource();
    runtime.become('ready');
    source.subscribe(() => {});
    await settle();

    await source.setPolicy(ROOM, DAY);

    expect(runtime.chatClient.writes).toEqual([{ roomId: ROOM, policy: DAY }]);
    expect(source.getSnapshot().get(ROOM)).toEqual(DAY);
  });

  it('turns a conversation back into an ordinary one', async () => {
    const { runtime, source } = readySource();
    runtime.chatClient.policies = new Map([[ROOM, DAY]]);
    runtime.become('ready');
    source.subscribe(() => {});
    await settle();

    await source.setPolicy(ROOM, undefined);

    expect(source.getSnapshot().has(ROOM)).toBe(false);
  });

  it('forgets everything when the session goes away', async () => {
    const { runtime, source } = readySource();
    runtime.chatClient.policies = new Map([[ROOM, HOUR]]);
    runtime.become('ready');
    source.subscribe(() => {});
    await settle();
    expect(source.getSnapshot().size).toBe(1);

    runtime.become('signed-out');

    expect(source.getSnapshot().size).toBe(0);
  });

  it('keeps the last answer when a read fails', async () => {
    // Reported through the log and not through the snapshot: an account whose
    // ephemeral conversations could not be re-read is not an account with none,
    // and reporting none would take the timers off conversations that have them.
    const { runtime, source } = readySource();
    runtime.chatClient.policies = new Map([[ROOM, HOUR]]);
    runtime.become('ready');
    source.subscribe(() => {});
    await settle();

    runtime.chatClient.failNextRead = true;
    await source.refresh();

    expect(source.getSnapshot().get(ROOM)).toEqual(HOUR);
  });

  it('answers the same empty map every time, so nothing re-renders for nothing', () => {
    const { source } = readySource();

    expect(source.getSnapshot()).toBe(source.getSnapshot());
  });
});

describe('sameEphemeralPolicies', () => {
  it('is true for two readings of the same thing', () => {
    expect(sameEphemeralPolicies(new Map([[ROOM, HOUR]]), new Map([[ROOM, { ...HOUR }]]))).toBe(
      true,
    );
  });

  it('is false when a lifetime changed', () => {
    expect(sameEphemeralPolicies(new Map([[ROOM, HOUR]]), new Map([[ROOM, DAY]]))).toBe(false);
  });

  it('is false when a conversation was added or removed', () => {
    expect(sameEphemeralPolicies(new Map([[ROOM, HOUR]]), new Map())).toBe(false);
    expect(sameEphemeralPolicies(new Map(), new Map([[ROOM, HOUR]]))).toBe(false);
  });

  it('is false when the same number of conversations are different ones', () => {
    expect(
      sameEphemeralPolicies(new Map([[ROOM, HOUR]]), new Map([['!other:allo.you', HOUR]])),
    ).toBe(false);
  });
});
