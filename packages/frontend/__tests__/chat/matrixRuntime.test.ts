import {
  MatrixRuntime,
  type AuthorizationOutcome,
  type MatrixRuntimeDependencies,
} from '@/lib/chat/matrixRuntime';
import type {
  AlloChatClient,
  AlloChatClientConfig,
  AlloEncryptionState,
  AlloOidcLoginRequest,
  AlloRoomListHandle,
  AlloSession,
  AlloSyncState,
  AlloTimelineHandle,
  AlloUnsubscribe,
} from '@/lib/matrix/types';

/**
 * The client's lifecycle: building it, signing in through a browser, and what
 * happens when any of that fails.
 *
 * Everything the runtime touches that is not its own logic is injected, so all
 * of this runs without a homeserver, without a browser and without either Matrix
 * SDK.
 */

const CONFIG: AlloChatClientConfig = {
  homeserverUrl: 'https://matrix.example',
  store: { kind: 'in-memory' },
  oidc: {
    clientName: 'Allo',
    redirectUri: 'allo://matrix/oidc',
    clientUri: 'https://allo.you',
  },
};

const SESSION: AlloSession = {
  userId: '@nate:matrix.example',
  deviceId: 'DEVICE',
  homeserverUrl: 'https://matrix.example',
  accessToken: 'secret-access-token',
  refreshToken: 'secret-refresh-token',
  authData: undefined,
};

class FakeLoginRequest implements AlloOidcLoginRequest {
  readonly authorizationUrl = 'https://auth.example/authorize?state=xyz';
  completedWith: string | undefined;
  aborts = 0;
  completion: () => Promise<AlloSession> = async () => SESSION;

  async complete(callbackUrl: string): Promise<AlloSession> {
    this.completedWith = callbackUrl;
    return this.completion();
  }

  async abort(): Promise<void> {
    this.aborts += 1;
  }
}

class FakeChatClient implements AlloChatClient {
  readonly request = new FakeLoginRequest();
  beginOidcLoginCalls = 0;
  startSyncCalls = 0;
  closes = 0;
  beginOidcLoginFails: Error | undefined;
  startSyncFails: Error | undefined;

  #syncListeners = new Set<(state: AlloSyncState) => void>();
  #syncState: AlloSyncState = 'idle';

  async beginOidcLogin(): Promise<AlloOidcLoginRequest> {
    this.beginOidcLoginCalls += 1;
    if (this.beginOidcLoginFails !== undefined) {
      throw this.beginOidcLoginFails;
    }
    return this.request;
  }

  async restoreSession(): Promise<void> {}

  session(): AlloSession {
    return SESSION;
  }

  async startSync(): Promise<void> {
    this.startSyncCalls += 1;
    if (this.startSyncFails !== undefined) {
      throw this.startSyncFails;
    }
  }

  async stopSync(): Promise<void> {}

  observeSyncState(onChange: (state: AlloSyncState) => void): AlloUnsubscribe {
    this.#syncListeners.add(onChange);
    onChange(this.#syncState);
    return () => {
      this.#syncListeners.delete(onChange);
    };
  }

  /** Drives the sync loop from a test. */
  emitSyncState(state: AlloSyncState): void {
    this.#syncState = state;
    for (const listener of this.#syncListeners) {
      listener(state);
    }
  }

  async observeRooms(): Promise<AlloRoomListHandle> {
    throw new Error('not used by these tests');
  }

  async roomEncryption(): Promise<AlloEncryptionState> {
    return 'encrypted';
  }

  async openTimeline(): Promise<AlloTimelineHandle> {
    throw new Error('not used by these tests');
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

interface Harness {
  readonly runtime: MatrixRuntime;
  readonly client: FakeChatClient;
  /** What the browser step was asked to open, in order. */
  readonly opened: string[];
  createClientCalls: number;
}

function harness(
  overrides: Partial<MatrixRuntimeDependencies> & {
    outcome?: () => Promise<AuthorizationOutcome>;
    createClientFails?: () => Error | undefined;
  } = {},
): Harness {
  const client = new FakeChatClient();
  const opened: string[] = [];
  const result: Harness = {
    client,
    opened,
    createClientCalls: 0,
    runtime: new MatrixRuntime({
      config: () => CONFIG,
      createClient: async () => {
        result.createClientCalls += 1;
        const failure = overrides.createClientFails?.();
        if (failure !== undefined) {
          throw failure;
        }
        return client;
      },
      authorize: async (url) => {
        opened.push(url);
        return (await overrides.outcome?.()) ?? { kind: 'returned', callbackUrl: 'allo://matrix/oidc?code=abc' };
      },
      ...overrides,
    }),
  };
  return result;
}

/** Lets every already-queued promise settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('MatrixRuntime lifecycle', () => {
  it('reports nothing until something subscribes', () => {
    const { runtime, createClientCalls } = harness();

    expect(runtime.getState().phase).toBe('idle');
    expect(createClientCalls).toBe(0);
  });

  it('builds the client when the first subscriber arrives', async () => {
    const context = harness();

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.createClientCalls).toBe(1);
    expect(context.runtime.getState().phase).toBe('signed-out');
  });

  it('builds one client however many subscribers arrive', async () => {
    // Every screen that reads the state subscribes. Building per subscriber
    // would mean several clients on one crypto store, which is the corruption
    // the port warns about.
    const context = harness();

    context.runtime.subscribe(() => {});
    context.runtime.subscribe(() => {});
    context.runtime.subscribe(() => {});
    await settle();

    expect(context.createClientCalls).toBe(1);
  });

  it('refuses to hand out a client before there is one', () => {
    const { runtime } = harness();

    expect(() => runtime.client('Observing the conversation list')).toThrow(
      /Observing the conversation list/,
    );
  });

  it('reports a build failure in the state instead of throwing at the subscriber', async () => {
    const context = harness({
      createClientFails: () => new Error('the homeserver does not serve sliding sync'),
    });

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.runtime.getState().phase).toBe('failed');
    expect(context.runtime.getState().error).toContain('does not serve sliding sync');
  });

  it('rebuilds after a failure rather than repeating it forever', async () => {
    let failures = 1;
    const context = harness({
      createClientFails: () => (failures-- > 0 ? new Error('no network') : undefined),
    });

    context.runtime.subscribe(() => {});
    await settle();
    expect(context.runtime.getState().phase).toBe('failed');

    await context.runtime.signIn();
    await settle();

    expect(context.createClientCalls).toBe(2);
    expect(context.runtime.getState().phase).toBe('ready');
  });
});

describe('MatrixRuntime sign-in', () => {
  it('opens the authorization page, finishes it and starts sync', async () => {
    const context = harness();

    await context.runtime.signIn();
    await settle();

    expect(context.opened).toEqual(['https://auth.example/authorize?state=xyz']);
    expect(context.client.request.completedWith).toBe('allo://matrix/oidc?code=abc');
    expect(context.client.startSyncCalls).toBe(1);
    expect(context.runtime.getState()).toMatchObject({
      phase: 'ready',
      userId: '@nate:matrix.example',
    });
  });

  it('abandons the authorization when the user closes the browser', async () => {
    // The authorization server holds state for an attempt until it is abandoned.
    // A user who backs out has not failed at anything, so this goes back to
    // signed out rather than to an error.
    const context = harness({ outcome: async () => ({ kind: 'dismissed' }) });

    await context.runtime.signIn();
    await settle();

    expect(context.client.request.aborts).toBe(1);
    expect(context.runtime.getState().phase).toBe('signed-out');
    expect(context.runtime.getState().error).toBeUndefined();
  });

  it('shares one authorization between simultaneous sign-ins', async () => {
    // Two authorizations would each hold server-side state and only one could be
    // completed; the other would leave the server holding an attempt forever.
    let release = (): void => {};
    const context = harness({
      outcome: () =>
        new Promise<AuthorizationOutcome>((resolve) => {
          release = () => resolve({ kind: 'returned', callbackUrl: 'allo://matrix/oidc?code=abc' });
        }),
    });

    const first = context.runtime.signIn();
    const second = context.runtime.signIn();
    await settle();
    release();
    await Promise.all([first, second]);

    expect(context.client.beginOidcLoginCalls).toBe(1);
    expect(context.opened).toHaveLength(1);
  });

  it('does nothing when a sign-in is asked for on a signed-in runtime', async () => {
    const context = harness();

    await context.runtime.signIn();
    await context.runtime.signIn();

    expect(context.client.beginOidcLoginCalls).toBe(1);
  });

  it('reports a completion the homeserver rejected', async () => {
    const context = harness();
    context.client.request.completion = async () => {
      throw new Error('M_UNKNOWN_TOKEN');
    };

    await context.runtime.signIn();

    expect(context.runtime.getState().phase).toBe('failed');
    expect(context.runtime.getState().error).toContain('M_UNKNOWN_TOKEN');
  });

  it('never passes through ready when sync could not be started', async () => {
    // Every phase, not just the last one. `ready` is what the room list and the
    // timelines wait for, and they open against the port the moment they see it
    // — so a runtime that says `ready` for even one notification before sync is
    // up hands them a client that raises MatrixSyncNotStartedError. Asserting
    // only the final state would not notice: the failure lands a moment later
    // and the end state is the same either way.
    const context = harness();
    context.client.startSyncFails = new Error('sliding sync is not available');
    const phases: string[] = [];
    context.runtime.subscribe(() => {
      phases.push(context.runtime.getState().phase);
    });

    await context.runtime.signIn();
    await settle();

    expect(phases).not.toContain('ready');
    expect(context.runtime.getState().phase).toBe('failed');
  });

  it('starts sync before it reports itself ready', async () => {
    const context = harness();
    const phases: string[] = [];
    context.runtime.subscribe(() => {
      phases.push(context.runtime.getState().phase);
    });

    await context.runtime.signIn();
    await settle();

    expect(context.client.startSyncCalls).toBe(1);
    expect(phases).toContain('ready');
  });

  it('never puts the callback URL in the state it publishes', async () => {
    // The callback carries the authorization code. It is a credential, and the
    // state is read by components and shown on screen.
    const context = harness();

    await context.runtime.signIn();

    expect(JSON.stringify(context.runtime.getState())).not.toContain('code=abc');
  });
});

describe('MatrixRuntime notifications', () => {
  it('tells subscribers when the phase changes', async () => {
    const context = harness();
    let notifications = 0;
    context.runtime.subscribe(() => {
      notifications += 1;
    });
    await settle();

    expect(notifications).toBeGreaterThan(0);
  });

  it('stays quiet when the sync loop repeats a state it already reported', async () => {
    // `useSyncExternalStore` re-renders on every notification whose snapshot is a
    // new object. A sync heartbeat that republished `running` would re-render the
    // whole conversation list for nothing.
    const context = harness();
    await context.runtime.signIn();
    context.client.emitSyncState('running');

    let notifications = 0;
    context.runtime.subscribe(() => {
      notifications += 1;
    });
    await settle();
    notifications = 0;

    context.client.emitSyncState('running');
    context.client.emitSyncState('running');

    expect(notifications).toBe(0);

    context.client.emitSyncState('offline');
    expect(notifications).toBe(1);
  });

  it('answers with the same snapshot object while nothing changes', async () => {
    const context = harness();
    await context.runtime.signIn();

    const first = context.runtime.getState();
    context.client.emitSyncState(first.sync);

    expect(context.runtime.getState()).toBe(first);
  });

  it('stops telling a subscriber that has unsubscribed', async () => {
    const context = harness();
    await context.runtime.signIn();

    let notifications = 0;
    const unsubscribe = context.runtime.subscribe(() => {
      notifications += 1;
    });
    await settle();
    unsubscribe();

    context.client.emitSyncState('offline');

    expect(notifications).toBe(0);
  });
});
