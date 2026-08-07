import { MatrixIdentityError } from '@/lib/chat/matrixIdentity';
import {
  IDLE_RUNTIME_STATE,
  MatrixClientNotStartedError,
  type MatrixRuntimeLike,
  type MatrixRuntimeState,
} from '@/lib/chat/matrixRuntime';
import { RoomAdminSource, roomAdminSource } from '@/lib/chat/roomAdmin';
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
 * Administering a room from the screen that draws it.
 *
 * What has to be right here is the thing an administration screen cannot get
 * wrong: **the UI must never say something the homeserver disagrees with**. So
 * nothing is optimistic, every action waits and re-reads, and an action that
 * failed leaves the screen showing what the server still says.
 */

const ROOM = '!familia:allo.you';
const VIEWER = '@507f191e810c19729de860ea:allo.you';
const OXY_ALBA = '507f1f77bcf86cd799439011';
const OXY_BRUNO = '507f1f77bcf86cd799439012';

function details(overrides: Partial<AlloRoomDetails> = {}): AlloRoomDetails {
  return {
    roomId: ROOM,
    name: 'Familia',
    isDirect: false,
    members: [{ userId: VIEWER, displayName: 'Me', membership: 'joined' }],
    rights: { canInvite: true, canRename: true },
    ...overrides,
  };
}

/** A client that can administer a room and nothing else. */
class FakeChatClient implements AlloChatClient {
  readonly invited: string[] = [];
  readonly renamed: string[] = [];
  readonly left: string[] = [];
  reads = 0;
  /** What the next read answers with. */
  next: AlloRoomDetails = details();
  /** When set, the next read fails with it. */
  readFailure: Error | undefined;
  /** User ids the homeserver refuses to invite. */
  readonly refuseInvitesTo = new Set<string>();
  renameFailure: Error | undefined;
  leaveFailure: Error | undefined;

  async roomDetails(roomId: string): Promise<AlloRoomDetails> {
    this.reads += 1;
    if (this.readFailure !== undefined) {
      throw this.readFailure;
    }
    return { ...this.next, roomId };
  }

  async inviteToRoom(_roomId: string, userId: string): Promise<void> {
    if (this.refuseInvitesTo.has(userId)) {
      throw new Error(`M_FORBIDDEN: ${userId}`);
    }
    this.invited.push(userId);
  }

  async renameRoom(_roomId: string, name: string): Promise<void> {
    if (this.renameFailure !== undefined) {
      throw this.renameFailure;
    }
    this.renamed.push(name);
  }

  async leaveRoom(roomId: string): Promise<void> {
    if (this.leaveFailure !== undefined) {
      throw this.leaveFailure;
    }
    this.left.push(roomId);
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

  async createRoom(): Promise<string> {
    throw new Error('not used by these tests');
  }

  async acceptInvitation(): Promise<void> {
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
  readonly chatClient = new FakeChatClient();

  #state: MatrixRuntimeState = { ...IDLE_RUNTIME_STATE, phase: 'ready', userId: VIEWER };
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

  get watchers(): number {
    return this.#listeners.size;
  }

  become(state: Partial<MatrixRuntimeState>): void {
    this.#state = { ...this.#state, ...state };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  client(operation: string): AlloChatClient {
    if (this.#state.phase !== 'ready') {
      throw new MatrixClientNotStartedError(operation);
    }
    return this.chatClient;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function watched(runtime: FakeRuntime): { source: RoomAdminSource; stop: () => void } {
  const source = new RoomAdminSource(runtime, ROOM, () => {});
  const stop = source.subscribe(() => {});
  return { source, stop };
}

describe('RoomAdminSource reading', () => {
  it('reads nothing until something watches it', async () => {
    const runtime = new FakeRuntime();
    // eslint-disable-next-line no-new -- the point is that constructing reads nothing
    new RoomAdminSource(runtime, ROOM, () => {});
    await settle();

    expect(runtime.chatClient.reads).toBe(0);
  });

  it('reads the room when something starts watching', async () => {
    const runtime = new FakeRuntime();
    const { source } = watched(runtime);
    await settle();

    expect(runtime.chatClient.reads).toBe(1);
    expect(source.getSnapshot().details?.name).toBe('Familia');
    expect(source.getSnapshot().isLoading).toBe(false);
  });

  it('says it is loading before the first answer arrives', async () => {
    const runtime = new FakeRuntime();
    const { source } = watched(runtime);

    expect(source.getSnapshot().isLoading).toBe(true);
    expect(source.getSnapshot().details).toBe(undefined);
    await settle();
  });

  it('reads nothing while there is no session', async () => {
    const runtime = new FakeRuntime();
    runtime.become({ phase: 'signed-out', userId: undefined });
    watched(runtime);
    await settle();

    expect(runtime.chatClient.reads).toBe(0);
  });

  it('reports why a read failed, and keeps saying so', async () => {
    const runtime = new FakeRuntime();
    runtime.chatClient.readFailure = new Error('M_FORBIDDEN');
    const { source } = watched(runtime);
    await settle();

    expect(source.getSnapshot().error).toBe('M_FORBIDDEN');
    expect(source.getSnapshot().isLoading).toBe(false);
    expect(source.getSnapshot().details).toBe(undefined);
  });

  it('keeps the answer it had when a later read fails', async () => {
    // Older and true beats blank: the screen goes on showing the members it
    // knows about, with the reason the refresh did not work beside them.
    const runtime = new FakeRuntime();
    const { source } = watched(runtime);
    await settle();

    runtime.chatClient.readFailure = new Error('the network went away');
    await source.refresh();

    expect(source.getSnapshot().details?.name).toBe('Familia');
    expect(source.getSnapshot().error).toBe('the network went away');
  });

  it('forgets what it read when the session ends', async () => {
    // What was read belonged to that session. A details screen showing the
    // members of a room nobody is signed in to is a lie with a spinner on it.
    const runtime = new FakeRuntime();
    const { source } = watched(runtime);
    await settle();

    runtime.become({ phase: 'signed-out', userId: undefined });

    expect(source.getSnapshot().details).toBe(undefined);
  });

  it('stops watching the runtime when the last reader goes away', async () => {
    const runtime = new FakeRuntime();
    const { stop } = watched(runtime);
    await settle();

    stop();

    expect(runtime.watchers).toBe(0);
  });
});

describe('RoomAdminSource inviting', () => {
  it('invites the MXIDs of the Oxy accounts it was given', async () => {
    const runtime = new FakeRuntime();
    const { source } = watched(runtime);
    await settle();

    const outcome = await source.invite([OXY_ALBA, OXY_BRUNO]);

    expect(runtime.chatClient.invited).toEqual([
      `@${OXY_ALBA}:allo.you`,
      `@${OXY_BRUNO}:allo.you`,
    ]);
    expect(outcome).toEqual({ invited: [OXY_ALBA, OXY_BRUNO], failed: [] });
  });

  it('reads the room again once somebody has been invited', async () => {
    // The new member is `invited`, and the list on screen has to say so rather
    // than wait for the next time the screen is opened.
    const runtime = new FakeRuntime();
    const { source } = watched(runtime);
    await settle();
    const before = runtime.chatClient.reads;

    await source.invite([OXY_ALBA]);

    expect(runtime.chatClient.reads).toBe(before + 1);
  });

  it('reports the ones that failed and keeps the ones that did not', async () => {
    // Three invitations are three requests. A caller told only about the
    // failure would report a group as unchanged when two people are in it.
    const runtime = new FakeRuntime();
    runtime.chatClient.refuseInvitesTo.add(`@${OXY_BRUNO}:allo.you`);
    const { source } = watched(runtime);
    await settle();

    const outcome = await source.invite([OXY_ALBA, OXY_BRUNO]);

    expect(outcome.invited).toEqual([OXY_ALBA]);
    expect(outcome.failed).toEqual([
      { userId: OXY_BRUNO, reason: `M_FORBIDDEN: @${OXY_BRUNO}:allo.you` },
    ]);
  });

  it('does not re-read when nobody was invited at all', async () => {
    const runtime = new FakeRuntime();
    runtime.chatClient.refuseInvitesTo.add(`@${OXY_ALBA}:allo.you`);
    const { source } = watched(runtime);
    await settle();
    const before = runtime.chatClient.reads;

    const outcome = await source.invite([OXY_ALBA]);

    expect(outcome.invited).toEqual([]);
    expect(runtime.chatClient.reads).toBe(before);
  });

  it('fails an Oxy id that cannot be a Matrix localpart without abandoning the rest', async () => {
    // One account nobody can name must not stop a family group being completed,
    // so the unusable id is a failure of its own rather than an exception that
    // takes the batch with it.
    const runtime = new FakeRuntime();
    const { source } = watched(runtime);
    await settle();

    const outcome = await source.invite(['Not A Localpart', OXY_ALBA]);

    expect(outcome.invited).toEqual([OXY_ALBA]);
    expect(outcome.failed.map((entry) => entry.userId)).toEqual(['Not A Localpart']);
    expect(outcome.failed[0].reason).toContain('not a usable Matrix localpart');
    expect(runtime.chatClient.invited).toEqual([`@${OXY_ALBA}:allo.you`]);
  });

  it('refuses the whole batch when there is no session to name anybody on', async () => {
    // The server name comes from the viewer's own MXID. Without one there is no
    // homeserver to invite anybody on, and inviting nobody quietly would look
    // like a group that simply refused to grow.
    const runtime = new FakeRuntime();
    const { source } = watched(runtime);
    await settle();
    runtime.become({ userId: undefined });

    await expect(source.invite([OXY_ALBA])).rejects.toBeInstanceOf(MatrixClientNotStartedError);
    expect(runtime.chatClient.invited).toEqual([]);
  });
});

describe('RoomAdminSource renaming', () => {
  it('renames the room and reads it again', async () => {
    const runtime = new FakeRuntime();
    const { source } = watched(runtime);
    await settle();
    const before = runtime.chatClient.reads;

    await source.rename('Familia grande');

    expect(runtime.chatClient.renamed).toEqual(['Familia grande']);
    expect(runtime.chatClient.reads).toBe(before + 1);
  });

  it('reports a rename the homeserver refused, and reads nothing', async () => {
    // The screen has to go on showing the name the room still has. A re-read
    // after a failure would be a spinner over an unchanged answer, and a
    // swallowed error would leave the new name on screen.
    const runtime = new FakeRuntime();
    runtime.chatClient.renameFailure = new Error('M_FORBIDDEN');
    const { source } = watched(runtime);
    await settle();
    const before = runtime.chatClient.reads;

    await expect(source.rename('Familia grande')).rejects.toThrow('M_FORBIDDEN');
    expect(runtime.chatClient.reads).toBe(before);
    expect(source.getSnapshot().details?.name).toBe('Familia');
  });
});

describe('RoomAdminSource leaving', () => {
  it('leaves the room', async () => {
    const runtime = new FakeRuntime();
    const { source } = watched(runtime);
    await settle();

    await source.leave();

    expect(runtime.chatClient.left).toEqual([ROOM]);
  });

  it('does not read the room it has just left', async () => {
    // There is nothing there this account is still allowed to read, and asking
    // would answer with an error the user cannot act on.
    const runtime = new FakeRuntime();
    const { source } = watched(runtime);
    await settle();
    const before = runtime.chatClient.reads;

    await source.leave();

    expect(runtime.chatClient.reads).toBe(before);
  });

  it('reports a refusal rather than pretending the room is gone', async () => {
    const runtime = new FakeRuntime();
    runtime.chatClient.leaveFailure = new Error('M_LIMIT_EXCEEDED');
    const { source } = watched(runtime);
    await settle();

    await expect(source.leave()).rejects.toThrow('M_LIMIT_EXCEEDED');
  });
});

describe('roomAdminSource registry', () => {
  it('hands the same source to everything drawing one room', () => {
    expect(roomAdminSource(ROOM)).toBe(roomAdminSource(ROOM));
  });

  it('keeps separate rooms separate', () => {
    expect(roomAdminSource(ROOM)).not.toBe(roomAdminSource('!other:allo.you'));
  });

  it('forgets a room once nothing is watching it', () => {
    const first = roomAdminSource('!transient:allo.you');
    const stop = first.subscribe(() => {});
    stop();

    expect(roomAdminSource('!transient:allo.you')).not.toBe(first);
  });
});
