import { MatrixInvitations } from '@/lib/chat/invitations';
import {
  IDLE_RUNTIME_STATE,
  MatrixClientNotStartedError,
  type MatrixRuntimeLike,
  type MatrixRuntimeState,
} from '@/lib/chat/matrixRuntime';
import type {
  AlloChatClient,
  AlloEncryptionState,
  AlloMediaFile,
  AlloOidcLoginRequest,
  AlloRecoveryState,
  AlloRoomDetails,
  AlloRoomListHandle,
  AlloSession,
  AlloTimelineHandle,
  AlloUnsubscribe,
} from '@/lib/matrix/types';

/**
 * Answering an invitation.
 *
 * The other end of creating a group: everybody who did not create it starts
 * with an invitation, and a room they have not joined has no readable timeline.
 * Without this the family group exists and only its creator can use it.
 */

const ROOM = '!familia:allo.you';

/** A client that can answer invitations and nothing else. */
class FakeChatClient implements AlloChatClient {
  readonly accepted: string[] = [];
  readonly declined: string[] = [];
  refuse: Error | undefined;

  async acceptInvitation(roomId: string): Promise<void> {
    if (this.refuse !== undefined) {
      throw this.refuse;
    }
    this.accepted.push(roomId);
  }

  async leaveRoom(roomId: string): Promise<void> {
    if (this.refuse !== undefined) {
      throw this.refuse;
    }
    this.declined.push(roomId);
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

  async beginOidcLogin(): Promise<AlloOidcLoginRequest> {
    throw new Error('not used by these tests');
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

  #ready = true;

  subscribe(): AlloUnsubscribe {
    return () => {};
  }

  getState(): MatrixRuntimeState {
    return this.#ready
      ? { ...IDLE_RUNTIME_STATE, phase: 'ready', userId: '@viewer:allo.you' }
      : IDLE_RUNTIME_STATE;
  }

  signOut(): void {
    this.#ready = false;
  }

  client(operation: string): AlloChatClient {
    if (!this.#ready) {
      throw new MatrixClientNotStartedError(operation);
    }
    return this.chatClient;
  }
}

describe('MatrixInvitations', () => {
  it('joins the room an invitation is to', async () => {
    const runtime = new FakeRuntime();

    await new MatrixInvitations(runtime).accept(ROOM);

    expect(runtime.chatClient.accepted).toEqual([ROOM]);
    expect(runtime.chatClient.declined).toEqual([]);
  });

  it('leaves the room when the invitation is refused', async () => {
    const runtime = new FakeRuntime();

    await new MatrixInvitations(runtime).decline(ROOM);

    expect(runtime.chatClient.declined).toEqual([ROOM]);
    expect(runtime.chatClient.accepted).toEqual([]);
  });

  it('reports a refusal from the homeserver rather than swallowing it', async () => {
    // A join that failed and looked as if it worked is the worst of the three
    // outcomes: the screen would draw a conversation the account is not in and
    // a composer that sends into it.
    const runtime = new FakeRuntime();
    runtime.chatClient.refuse = new Error('M_FORBIDDEN');

    await expect(new MatrixInvitations(runtime).accept(ROOM)).rejects.toThrow('M_FORBIDDEN');
  });

  it('refuses to answer anything without a client', async () => {
    const runtime = new FakeRuntime();
    runtime.signOut();

    await expect(new MatrixInvitations(runtime).accept(ROOM)).rejects.toBeInstanceOf(
      MatrixClientNotStartedError,
    );
  });
});
