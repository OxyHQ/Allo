import { IDLE_RUNTIME_STATE, type MatrixRuntimeLike, type MatrixRuntimeState } from '@/lib/chat/matrixRuntime';
import { MatrixMediaCache } from '@/lib/chat/mediaCache';
import type {
  AlloChatClient,
  AlloMediaFile,
  AlloOidcLoginRequest,
  AlloRecoveryState,
  AlloRoomListHandle,
  AlloSession,
  AlloTimelineHandle,
  AlloUnsubscribe,
} from '@/lib/matrix/types';

/**
 * The cache that turns an opaque media ref into something a view can point at.
 *
 * Two properties carry it. **A read starts at most one download** — the read
 * happens during render, on every row, on every frame, and a cache that fired a
 * request each time would download a conversation's pictures hundreds of times.
 * And **what it lets go of is released**, because every entry is a decrypted
 * copy of a photograph from an encrypted conversation: on web an object URL
 * pinning bytes in the tab, on a phone a plaintext file in the cache directory.
 * A cache that merely forgot them would leave both behind.
 */

class FakeMediaFile implements AlloMediaFile {
  releases = 0;

  constructor(readonly uri: string) {}

  release(): void {
    this.releases += 1;
  }
}

/** A client that can fetch attachments and refuses everything else. */
class FakeChatClient implements AlloChatClient {
  readonly requested: string[] = [];
  readonly files: FakeMediaFile[] = [];
  /** Refs that should fail, as a homeserver refusing one would. */
  readonly failing = new Set<string>();
  #pending: (() => void)[] = [];
  #hold = false;

  hold(): void {
    this.#hold = true;
  }

  release(): void {
    const pending = this.#pending;
    this.#pending = [];
    this.#hold = false;
    for (const resolve of pending) {
      resolve();
    }
  }

  async downloadMedia(ref: string): Promise<AlloMediaFile> {
    this.requested.push(ref);
    if (this.#hold) {
      await new Promise<void>((resolve) => {
        this.#pending.push(resolve);
      });
    }
    if (this.failing.has(ref)) {
      throw new Error('the homeserver refused it');
    }
    const file = new FakeMediaFile(`file:///cache/${this.requested.length}`);
    this.files.push(file);
    return file;
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

  async acceptInvitation(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async declineInvitation(): Promise<void> {
    throw new Error('not used by these tests');
  }

  async roomEncryption(): Promise<never> {
    throw new Error('not used by these tests');
  }

  async openTimeline(): Promise<AlloTimelineHandle> {
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
  readonly #listeners = new Set<() => void>();

  #state: MatrixRuntimeState = { ...IDLE_RUNTIME_STATE, phase: 'ready', userId: '@alice:allo.you' };

  subscribe(listener: () => void): AlloUnsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getState(): MatrixRuntimeState {
    return this.#state;
  }

  signInAs(userId: string | undefined): void {
    this.#state = { ...this.#state, userId };
    for (const listener of this.#listeners) {
      listener();
    }
  }

  client(): AlloChatClient {
    return this.chatClient;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the media cache', () => {
  it('answers nothing the first time and the URI once it has it', async () => {
    const runtime = new FakeRuntime();
    const cache = new MatrixMediaCache(runtime);
    cache.subscribe(() => {});

    expect(cache.url('ref-1')).toBeUndefined();
    await settle();

    expect(cache.getSnapshot().get('ref-1')).toBe('file:///cache/1');
  });

  it('notifies its readers when a picture arrives', async () => {
    const runtime = new FakeRuntime();
    const cache = new MatrixMediaCache(runtime);
    let notifications = 0;
    cache.subscribe(() => {
      notifications += 1;
    });

    cache.url('ref-1');
    await settle();

    // Without this the row that asked would keep drawing nothing: the read
    // happens during render and nothing else would re-render it.
    expect(notifications).toBeGreaterThan(0);
  });

  it('downloads once however many rows ask', async () => {
    const runtime = new FakeRuntime();
    const cache = new MatrixMediaCache(runtime);
    cache.subscribe(() => {});
    runtime.chatClient.hold();

    for (let index = 0; index < 20; index += 1) {
      cache.url('ref-1');
    }
    runtime.chatClient.release();
    await settle();

    expect(runtime.chatClient.requested).toEqual(['ref-1']);
  });

  it('does not download again once it has the picture', async () => {
    const runtime = new FakeRuntime();
    const cache = new MatrixMediaCache(runtime);
    cache.subscribe(() => {});

    cache.url('ref-1');
    await settle();
    cache.url('ref-1');
    cache.url('ref-1');
    await settle();

    expect(runtime.chatClient.requested).toEqual(['ref-1']);
  });

  it('does not retry one the homeserver refused', async () => {
    const runtime = new FakeRuntime();
    const cache = new MatrixMediaCache(runtime);
    cache.subscribe(() => {});
    runtime.chatClient.failing.add('ref-1');

    cache.url('ref-1');
    await settle();
    // The read that would retry runs on every render. A homeserver that refused
    // once will refuse sixty times a second just as readily.
    cache.url('ref-1');
    cache.url('ref-1');
    await settle();

    expect(runtime.chatClient.requested).toEqual(['ref-1']);
    expect(cache.getSnapshot().has('ref-1')).toBe(false);
  });

  it('releases what it evicts', async () => {
    const runtime = new FakeRuntime();
    const cache = new MatrixMediaCache(runtime);
    cache.subscribe(() => {});

    // One more than the cache holds, so the first one has to go.
    for (let index = 0; index < 61; index += 1) {
      cache.url(`ref-${index}`);
      await settle();
    }

    expect(runtime.chatClient.files[0].releases).toBe(1);
    expect(cache.getSnapshot().has('ref-0')).toBe(false);
    // The newest is still there: eviction takes the oldest, not the latest.
    expect(cache.getSnapshot().has('ref-60')).toBe(true);
  });

  it('lets an evicted picture be fetched again', async () => {
    const runtime = new FakeRuntime();
    const cache = new MatrixMediaCache(runtime);
    cache.subscribe(() => {});

    for (let index = 0; index < 61; index += 1) {
      cache.url(`ref-${index}`);
      await settle();
    }
    cache.url('ref-0');
    await settle();

    expect(runtime.chatClient.requested.filter((ref) => ref === 'ref-0')).toHaveLength(2);
  });

  it('releases everything when the account changes', async () => {
    const runtime = new FakeRuntime();
    const cache = new MatrixMediaCache(runtime);
    cache.subscribe(() => {});

    cache.url('ref-1');
    await settle();
    runtime.signInAs('@bob:allo.you');

    // Every URI in there decrypts something the previous session was allowed to
    // read. Keeping them would show one account another's photographs.
    expect(runtime.chatClient.files[0].releases).toBe(1);
    expect(cache.getSnapshot().size).toBe(0);
  });

  it('releases everything when the session ends', async () => {
    const runtime = new FakeRuntime();
    const cache = new MatrixMediaCache(runtime);
    cache.subscribe(() => {});

    cache.url('ref-1');
    await settle();
    runtime.signInAs(undefined);

    expect(runtime.chatClient.files[0].releases).toBe(1);
  });

  it('releases a download that landed after the session ended', async () => {
    const runtime = new FakeRuntime();
    const cache = new MatrixMediaCache(runtime);
    cache.subscribe(() => {});
    runtime.chatClient.hold();

    cache.url('ref-1');
    runtime.signInAs(undefined);
    runtime.chatClient.release();
    await settle();

    // Nothing is waiting for it and the bytes belong to a client that is gone.
    // Keeping it would leave a decrypted photograph behind a sign-out.
    expect(runtime.chatClient.files[0].releases).toBe(1);
    expect(cache.getSnapshot().size).toBe(0);
  });

  it('gives readers the same snapshot until something changes', () => {
    const runtime = new FakeRuntime();
    const cache = new MatrixMediaCache(runtime);
    cache.subscribe(() => {});

    // `useSyncExternalStore` compares snapshots by identity and throws on one
    // that keeps changing, so "nothing fetched" has to be the same object.
    expect(cache.getSnapshot()).toBe(cache.getSnapshot());
  });
});
