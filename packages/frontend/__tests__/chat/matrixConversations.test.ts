import { MatrixConversationCreator } from '@/lib/chat/matrixConversations';
import { MatrixIdentityError } from '@/lib/chat/matrixIdentity';
import {
  IDLE_RUNTIME_STATE,
  MatrixClientNotStartedError,
  type MatrixRuntimeLike,
  type MatrixRuntimeState,
} from '@/lib/chat/matrixRuntime';
import { NoParticipantsError } from '@/lib/chat/newConversation';
import type { RoomListLike } from '@/lib/chat/roomListSource';
import type {
  AlloChatClient,
  AlloCreateRoomRequest,
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
 * Starting a conversation on the homeserver, from a screen that knows people by
 * their Oxy id.
 *
 * Three things are being checked, and each is a way the room would exist and the
 * app would not be able to show it: the people are named in the homeserver's
 * vocabulary, the room is waited for rather than opened before sync delivers it,
 * and nothing is written to the conversations store — the room list is fed by
 * sync and by nothing else.
 */

const OXY_ALICE = '507f1f77bcf86cd799439011';
const OXY_BOB = '507f1f77bcf86cd799439012';
const VIEWER = '@507f191e810c19729de860ea:allo.you';

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

/**
 * A client that can create a room and nothing else.
 *
 * Everything the creator never calls throws rather than answering plausibly, so
 * a change that started calling one fails here instead of quietly working
 * against a stub.
 */
class FakeChatClient implements AlloChatClient {
  readonly requests: AlloCreateRoomRequest[] = [];
  roomId = '!created:allo.you';

  async createRoom(request: AlloCreateRoomRequest): Promise<string> {
    this.requests.push(request);
    return this.roomId;
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

  observeSyncState(): AlloUnsubscribe {
    throw new Error('not used by these tests');
  }

  async observeRooms(): Promise<AlloRoomListHandle> {
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

  #state: MatrixRuntimeState = { ...IDLE_RUNTIME_STATE, phase: 'ready', userId: VIEWER };

  subscribe(): AlloUnsubscribe {
    return () => {};
  }

  getState(): MatrixRuntimeState {
    return this.#state;
  }

  signOut(): void {
    this.#state = IDLE_RUNTIME_STATE;
  }

  client(): AlloChatClient {
    return this.chatClient;
  }
}

/** The conversation list, as the creator reads it while it waits. */
class FakeRoomList implements RoomListLike {
  #rooms: readonly AlloRoomSummary[] = [];
  readonly #listeners = new Set<() => void>();

  subscribe(listener: () => void): AlloUnsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getSnapshot(): readonly AlloRoomSummary[] {
    return this.#rooms;
  }

  get watchers(): number {
    return this.#listeners.size;
  }

  /** What sync delivering the room looks like from here. */
  deliver(roomId: string): void {
    this.#rooms = [...this.#rooms, summary(roomId)];
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Long enough that no test reaches it by accident. */
const NEVER_IN_THIS_TEST_MS = 60_000;

describe('MatrixConversationCreator', () => {
  it('invites the people it was given, on the homeserver this account lives on', async () => {
    const runtime = new FakeRuntime();
    const rooms = new FakeRoomList();
    const creator = new MatrixConversationCreator(runtime, rooms, NEVER_IN_THIS_TEST_MS);

    const created = creator.create({ participantIds: [OXY_ALICE, OXY_BOB], name: 'Familia' });
    await settle();
    rooms.deliver('!created:allo.you');
    await created;

    expect(runtime.chatClient.requests).toEqual([
      {
        invite: [`@${OXY_ALICE}:allo.you`, `@${OXY_BOB}:allo.you`],
        name: 'Familia',
        isDirect: false,
      },
    ]);
  });

  it('creates a direct message for one person, with no name', async () => {
    const runtime = new FakeRuntime();
    const rooms = new FakeRoomList();
    const creator = new MatrixConversationCreator(runtime, rooms, NEVER_IN_THIS_TEST_MS);

    const created = creator.create({ participantIds: [OXY_ALICE], name: 'Familia' });
    await settle();
    rooms.deliver('!created:allo.you');
    await created;

    expect(runtime.chatClient.requests[0]).toEqual({
      invite: [`@${OXY_ALICE}:allo.you`],
      name: undefined,
      isDirect: true,
    });
  });

  it('answers with the room to open', async () => {
    const runtime = new FakeRuntime();
    const rooms = new FakeRoomList();
    runtime.chatClient.roomId = '!familia:allo.you';
    const creator = new MatrixConversationCreator(runtime, rooms, NEVER_IN_THIS_TEST_MS);

    const created = creator.create({ participantIds: [OXY_ALICE], name: undefined });
    await settle();
    rooms.deliver('!familia:allo.you');

    await expect(created).resolves.toBe('!familia:allo.you');
  });

  it('waits for sync to deliver the room before opening it', async () => {
    // `createRoom` answers before the client knows the room: opening it then
    // draws a conversation with a room id for a name, no members and no
    // timeline — and on the web that state does not repair itself.
    const runtime = new FakeRuntime();
    const rooms = new FakeRoomList();
    const creator = new MatrixConversationCreator(runtime, rooms, NEVER_IN_THIS_TEST_MS);

    let opened = false;
    const created = creator.create({ participantIds: [OXY_ALICE], name: undefined }).then((id) => {
      opened = true;
      return id;
    });
    await settle();

    expect(opened).toBe(false);

    rooms.deliver('!created:allo.you');
    await created;

    expect(opened).toBe(true);
  });

  it('does not wait for a room the list already holds', async () => {
    const runtime = new FakeRuntime();
    const rooms = new FakeRoomList();
    rooms.deliver('!created:allo.you');
    const creator = new MatrixConversationCreator(runtime, rooms, NEVER_IN_THIS_TEST_MS);

    await expect(
      creator.create({ participantIds: [OXY_ALICE], name: undefined }),
    ).resolves.toBe('!created:allo.you');
  });

  it('opens the room anyway when sync takes too long, and says so', async () => {
    // The room exists: the invitations have gone out and everyone else can see
    // it. Refusing to open it because this device's sync is slow would report a
    // failure that did not happen and leave no way back to the conversation.
    // The warning is what tells an operator why the conversation opened empty.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const runtime = new FakeRuntime();
      const rooms = new FakeRoomList();
      const creator = new MatrixConversationCreator(runtime, rooms, 5);

      await expect(
        creator.create({ participantIds: [OXY_ALICE], name: undefined }),
      ).resolves.toBe('!created:allo.you');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('!created:allo.you'));
    } finally {
      warn.mockRestore();
    }
  });

  it('stops watching the room list once it has what it waited for', async () => {
    const runtime = new FakeRuntime();
    const rooms = new FakeRoomList();
    const creator = new MatrixConversationCreator(runtime, rooms, NEVER_IN_THIS_TEST_MS);

    const created = creator.create({ participantIds: [OXY_ALICE], name: undefined });
    await settle();
    rooms.deliver('!created:allo.you');
    await created;

    expect(rooms.watchers).toBe(0);
  });

  it('stops watching the room list when it gives up waiting', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const runtime = new FakeRuntime();
      const rooms = new FakeRoomList();
      const creator = new MatrixConversationCreator(runtime, rooms, 5);

      await creator.create({ participantIds: [OXY_ALICE], name: undefined });

      expect(rooms.watchers).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to create anything without a session', async () => {
    // There is no homeserver to invite anybody on: the server name is read from
    // the viewer's own user id, and there is not one yet.
    const runtime = new FakeRuntime();
    runtime.signOut();
    const creator = new MatrixConversationCreator(runtime, new FakeRoomList(), 5);

    await expect(
      creator.create({ participantIds: [OXY_ALICE], name: undefined }),
    ).rejects.toBeInstanceOf(MatrixClientNotStartedError);
    expect(runtime.chatClient.requests).toEqual([]);
  });

  it('refuses an Oxy id that is not a usable Matrix localpart, before creating anything', async () => {
    const runtime = new FakeRuntime();
    const creator = new MatrixConversationCreator(runtime, new FakeRoomList(), 5);

    await expect(
      creator.create({ participantIds: ['Not A Localpart'], name: undefined }),
    ).rejects.toBeInstanceOf(MatrixIdentityError);
    expect(runtime.chatClient.requests).toEqual([]);
  });

  it('refuses a conversation with nobody in it, before creating anything', async () => {
    const runtime = new FakeRuntime();
    const creator = new MatrixConversationCreator(runtime, new FakeRoomList(), 5);

    await expect(creator.create({ participantIds: [], name: 'Familia' })).rejects.toBeInstanceOf(
      NoParticipantsError,
    );
    expect(runtime.chatClient.requests).toEqual([]);
  });
});
