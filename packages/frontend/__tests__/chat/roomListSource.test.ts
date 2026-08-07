import { RoomListSource } from '@/lib/chat/roomListSource';
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
  AlloRoomSummary,
  AlloRoomTrust,
  AlloSession,
  AlloSyncState,
  AlloTimelineHandle,
  AlloUnsubscribe,
} from '@/lib/matrix/types';

/**
 * The adapter between the port's room list and `useSyncExternalStore`.
 *
 * What it has to get right is the part the port leaves to its caller: the list
 * can only be opened once sync is running, so opening waits for the runtime, and
 * anything still resolving when the runtime goes away has to be given up rather
 * than published.
 */

function summary(roomId: string): AlloRoomSummary {
  return {
    roomId,
    displayName: roomId,
    avatarUrl: undefined,
    isDirect: true,
    membership: 'joined',
    encryption: 'encrypted',
    unreadCount: 0,
    latestMessage: undefined,
  };
}

class FakeRoomList implements AlloRoomListHandle {
  closes = 0;
  #rooms: readonly AlloRoomSummary[] = [];

  constructor(private readonly onChange: (rooms: readonly AlloRoomSummary[]) => void) {}

  rooms(): readonly AlloRoomSummary[] {
    return this.#rooms;
  }

  /** What the port does when sync delivers a change. */
  publish(rooms: readonly AlloRoomSummary[]): void {
    this.#rooms = rooms;
    this.onChange(rooms);
  }

  close(): void {
    this.closes += 1;
  }
}

/**
 * A client that can hand out room lists and nothing else.
 *
 * Everything the source under test never calls throws rather than returning a
 * plausible value, so a change that started calling one of them fails here
 * instead of quietly working against a stub.
 */
class FakeChatClient implements AlloChatClient {
  readonly lists: FakeRoomList[] = [];
  observeRoomsCalls = 0;
  /** When set, `observeRooms` waits for {@link release} before resolving. */
  #pending: (() => void) | undefined;
  #holdOpen = false;

  holdOpen(): void {
    this.#holdOpen = true;
  }

  release(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.();
  }

  async observeRooms(
    onChange: (rooms: readonly AlloRoomSummary[]) => void,
  ): Promise<AlloRoomListHandle> {
    this.observeRoomsCalls += 1;
    const list = new FakeRoomList(onChange);
    this.lists.push(list);
    if (this.#holdOpen) {
      await new Promise<void>((resolve) => {
        this.#pending = resolve;
      });
    }
    return list;
  }

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

  observeSyncState(_onChange: (state: AlloSyncState) => void): AlloUnsubscribe {
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

  /** No conversation in these tests is ephemeral unless a case says so. */
  async ephemeralPolicies(): Promise<ReadonlyMap<string, AlloEphemeralPolicy>> {
    return new Map();
  }

  async setEphemeralPolicy(): Promise<void> {
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
    throw new Error('This fake does not register pushers.');
  }

  async unregisterPusher(): Promise<void> {
    throw new Error('This fake does not register pushers.');
  }

  async close(): Promise<void> {
    throw new Error('not used by these tests');
  }
}

class FakeRuntime implements MatrixRuntimeLike {
  readonly chatClient = new FakeChatClient();

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

describe('RoomListSource', () => {
  it('answers with an empty list before anything is open', () => {
    const source = new RoomListSource(new FakeRuntime());

    expect(source.getSnapshot()).toEqual([]);
  });

  it('does not open a room list while there is no session', async () => {
    // Opening one before sync runs is what the port raises
    // MatrixSyncNotStartedError for, and it would arrive as a logged error on a
    // screen that is only waiting for a sign-in.
    const runtime = new FakeRuntime();
    const source = new RoomListSource(runtime);

    source.subscribe(() => {});
    await settle();

    expect(runtime.chatClient.observeRoomsCalls).toBe(0);
  });

  it('opens the room list of a runtime that was already ready', async () => {
    // The runtime notifies on change. A source that only reacted to changes
    // would never open against a runtime that became ready first.
    const runtime = new FakeRuntime();
    runtime.become('ready');
    const source = new RoomListSource(runtime);

    source.subscribe(() => {});
    await settle();

    expect(runtime.chatClient.observeRoomsCalls).toBe(1);
  });

  it('opens the room list when the runtime becomes ready', async () => {
    const runtime = new FakeRuntime();
    const source = new RoomListSource(runtime);
    source.subscribe(() => {});
    await settle();

    runtime.become('ready');
    await settle();

    expect(runtime.chatClient.observeRoomsCalls).toBe(1);
  });

  it('opens one room list however many subscribers arrive', async () => {
    const runtime = new FakeRuntime();
    runtime.become('ready');
    const source = new RoomListSource(runtime);

    source.subscribe(() => {});
    source.subscribe(() => {});
    await settle();

    expect(runtime.chatClient.observeRoomsCalls).toBe(1);
  });

  it('publishes what the port reports, and tells its subscribers', async () => {
    const runtime = new FakeRuntime();
    runtime.become('ready');
    const source = new RoomListSource(runtime);
    let notifications = 0;
    source.subscribe(() => {
      notifications += 1;
    });
    await settle();
    notifications = 0;

    const rooms = [summary('!one:allo.you'), summary('!two:allo.you')];
    runtime.chatClient.lists[0].publish(rooms);

    expect(source.getSnapshot()).toBe(rooms);
    expect(notifications).toBe(1);
  });

  it('keeps the list in the order the port gave it', async () => {
    // The port hands back an ordered list — Rust's ordering on native, the web
    // half's own sort on web. Re-sorting here would be a second, different
    // opinion about which conversation belongs on top.
    const runtime = new FakeRuntime();
    runtime.become('ready');
    const source = new RoomListSource(runtime);
    source.subscribe(() => {});
    await settle();

    runtime.chatClient.lists[0].publish([summary('!z:allo.you'), summary('!a:allo.you')]);

    expect(source.getSnapshot().map((room) => room.roomId)).toEqual([
      '!z:allo.you',
      '!a:allo.you',
    ]);
  });

  it('answers with the same array while nothing changes', async () => {
    // `useSyncExternalStore` throws if the snapshot keeps being a new object.
    const runtime = new FakeRuntime();
    runtime.become('ready');
    const source = new RoomListSource(runtime);
    source.subscribe(() => {});
    await settle();

    expect(source.getSnapshot()).toBe(source.getSnapshot());
  });

  it('closes the room list and empties itself when the session goes away', async () => {
    const runtime = new FakeRuntime();
    runtime.become('ready');
    const source = new RoomListSource(runtime);
    source.subscribe(() => {});
    await settle();
    runtime.chatClient.lists[0].publish([summary('!one:allo.you')]);

    runtime.become('signed-out');

    expect(runtime.chatClient.lists[0].closes).toBe(1);
    // Not the stale list: it belongs to a session that no longer exists, and
    // showing it would tell the user they are still signed in.
    expect(source.getSnapshot()).toEqual([]);
  });

  it('closes a room list that arrives after the session went away', async () => {
    // The race this exists for: `observeRooms` is asynchronous, so a sign-out
    // between the call and its answer leaves a live subscription nobody owns.
    const runtime = new FakeRuntime();
    runtime.chatClient.holdOpen();
    runtime.become('ready');
    const source = new RoomListSource(runtime);
    source.subscribe(() => {});
    await settle();

    runtime.become('signed-out');
    runtime.chatClient.release();
    await settle();

    expect(runtime.chatClient.lists[0].closes).toBe(1);
    expect(source.getSnapshot()).toEqual([]);
  });

  it('ignores a list published by a handle from a session that has ended', async () => {
    const runtime = new FakeRuntime();
    runtime.become('ready');
    const source = new RoomListSource(runtime);
    source.subscribe(() => {});
    await settle();
    const stale = runtime.chatClient.lists[0];

    runtime.become('signed-out');
    stale.publish([summary('!ghost:allo.you')]);

    expect(source.getSnapshot()).toEqual([]);
  });

  it('reopens the room list after signing in again', async () => {
    const runtime = new FakeRuntime();
    runtime.become('ready');
    const source = new RoomListSource(runtime);
    source.subscribe(() => {});
    await settle();

    runtime.become('signed-out');
    runtime.become('ready');
    await settle();

    expect(runtime.chatClient.observeRoomsCalls).toBe(2);
  });

  it('stops telling a subscriber that has unsubscribed', async () => {
    const runtime = new FakeRuntime();
    runtime.become('ready');
    const source = new RoomListSource(runtime);
    let notifications = 0;
    const unsubscribe = source.subscribe(() => {
      notifications += 1;
    });
    await settle();
    unsubscribe();
    notifications = 0;

    runtime.chatClient.lists[0].publish([summary('!one:allo.you')]);

    expect(notifications).toBe(0);
  });
});
