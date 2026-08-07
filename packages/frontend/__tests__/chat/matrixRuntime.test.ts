import type {
  AuthorizationOutcome,
  MatrixPendingAuthorization,
} from '@/lib/chat/matrixAuthorization';
import { MatrixRuntime, type MatrixRuntimeDependencies } from '@/lib/chat/matrixRuntime';
import { encodeStoredSession } from '@/lib/chat/matrixSession';
import type { MatrixSessionStorage } from '@/lib/chat/matrixSessionStorage';
import type { MatrixPushRegistration } from '@/lib/chat/pushRegistration';
import type {
  AlloChatClient,
  AlloChatClientConfig,
  AlloClientStore,
  AlloEncryptionState,
  AlloEphemeralPolicy,
  AlloMediaFile,
  AlloOidcLoginRequest,
  AlloRecoveryState,
  AlloRoomDetails,
  AlloRoomListHandle,
  AlloRoomTrust,
  AlloSession,
  AlloSyncState,
  AlloTimelineHandle,
  AlloUnsubscribe,
} from '@/lib/matrix/types';

/**
 * The client's lifecycle: building it, reinstating the session of a previous
 * launch, signing in through a browser, signing out, and what happens when any
 * of that fails.
 *
 * Everything the runtime touches that is not its own logic is injected, so all
 * of this runs without a homeserver, without a browser, without a keychain and
 * without either Matrix SDK.
 */

const STORE: AlloClientStore = {
  kind: 'filesystem',
  dataPath: '/allo/matrix',
  cachePath: '/allo/matrix-cache',
};

const CONFIG: AlloChatClientConfig = {
  homeserverUrl: 'https://matrix.example',
  store: STORE,
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

/** The same session after the SDK has rotated its tokens. */
const REFRESHED_SESSION: AlloSession = {
  ...SESSION,
  accessToken: 'secret-access-token-2',
  refreshToken: 'secret-refresh-token-2',
};

/**
 * The keychain, or `localStorage`, as one string and a log of what was done to
 * it.
 *
 * The log is what most of these tests assert on. Persisting a session is a
 * sequence — read, erase, write, clear — and almost everything that can go wrong
 * with it is an ordering mistake that leaves the right values in the wrong order.
 */
class FakeSessionStorage implements MatrixSessionStorage {
  /** Every operation asked of it, in the order it was asked. */
  readonly calls: string[] = [];
  /** The same, in the harness's log of everything the runtime did. */
  readonly events: string[];

  value: string | undefined;
  writeFails: Error | undefined;
  clearFails: Error | undefined;
  /** While true, a write does not finish until {@link releaseWrites}. */
  holdWrites = false;

  #held: (() => void)[] = [];

  constructor(events: string[] = []) {
    this.events = events;
  }

  async read(): Promise<string | undefined> {
    this.#record('read');
    return this.value;
  }

  async write(value: string): Promise<void> {
    this.#record('write');
    if (this.holdWrites) {
      await new Promise<void>((resolve) => {
        this.#held.push(resolve);
      });
    }
    if (this.writeFails !== undefined) {
      throw this.writeFails;
    }
    this.value = value;
  }

  async clear(): Promise<void> {
    this.#record('clear');
    if (this.clearFails !== undefined) {
      throw this.clearFails;
    }
    this.value = undefined;
  }

  #record(call: string): void {
    this.calls.push(call);
    this.events.push(call);
  }

  releaseWrites(): void {
    for (const release of this.#held.splice(0)) {
      release();
    }
  }

  /** What is stored, as the session it holds. */
  storedSession(): AlloSession | undefined {
    return this.value === undefined
      ? undefined
      : (JSON.parse(this.value) as { session: AlloSession }).session;
  }
}

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

/**
 * The URL the browser is sent back to, as the app finds it on the way in.
 *
 * Web only: on a phone the authorization never outlives the app. The `state` in
 * it is not checked here — that is `WebOidcLoginRequest`'s job and it has its own
 * tests — so what these cases are about is which of the runtime's paths runs.
 */
const CALLBACK_URL = 'https://allo.you/#code=abc&state=xyz';

class FakeChatClient implements AlloChatClient {
  readonly request = new FakeLoginRequest();
  /** The request a login picked up after a redirect completes through. */
  readonly resumedRequest = new FakeLoginRequest();
  /** Whether this client has a login written down to pick up. */
  canResume = false;
  resumeOidcLoginCalls = 0;
  resumeOidcLoginFails: Error | undefined;
  /** Every call the runtime made, shared with the rest of the harness. */
  readonly events: string[];
  beginOidcLoginCalls = 0;
  startSyncCalls = 0;
  closes = 0;
  logouts = 0;
  restoredWith: AlloSession | undefined;
  beginOidcLoginFails: Error | undefined;
  startSyncFails: Error | undefined;
  restoreSessionFails: Error | undefined;
  logoutFails: Error | undefined;

  #syncListeners = new Set<(state: AlloSyncState) => void>();
  #sessionListeners = new Set<(session: AlloSession) => void>();
  #syncState: AlloSyncState = 'idle';

  constructor(events: string[]) {
    this.events = events;
  }

  async beginOidcLogin(): Promise<AlloOidcLoginRequest> {
    this.beginOidcLoginCalls += 1;
    if (this.beginOidcLoginFails !== undefined) {
      throw this.beginOidcLoginFails;
    }
    return this.request;
  }

  async resumeOidcLogin(): Promise<AlloOidcLoginRequest | undefined> {
    this.resumeOidcLoginCalls += 1;
    this.events.push('resumeOidcLogin');
    if (this.resumeOidcLoginFails !== undefined) {
      throw this.resumeOidcLoginFails;
    }
    return this.canResume ? this.resumedRequest : undefined;
  }

  async restoreSession(session: AlloSession): Promise<void> {
    this.events.push('restoreSession');
    this.restoredWith = session;
    if (this.restoreSessionFails !== undefined) {
      throw this.restoreSessionFails;
    }
  }

  session(): AlloSession {
    return SESSION;
  }

  observeSession(onChange: (session: AlloSession) => void): AlloUnsubscribe {
    this.#sessionListeners.add(onChange);
    return () => {
      this.#sessionListeners.delete(onChange);
    };
  }

  /** Stands in for the SDK rotating the session's tokens on its own. */
  rotateSession(session: AlloSession): void {
    for (const listener of this.#sessionListeners) {
      listener(session);
    }
  }

  /** How many listeners the runtime currently has on the session. */
  sessionListenerCount(): number {
    return this.#sessionListeners.size;
  }

  async logout(): Promise<void> {
    this.events.push('logout');
    this.logouts += 1;
    if (this.logoutFails !== undefined) {
      throw this.logoutFails;
    }
  }

  async startSync(): Promise<void> {
    this.events.push('startSync');
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
    return 'encrypted';
  }

  async openTimeline(): Promise<AlloTimelineHandle> {
    throw new Error('not used by these tests');
  }

  async downloadMedia(): Promise<AlloMediaFile> {
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

  /**
   * The runtime never calls these: it goes through the injected
   * `pushRegistration`, and the fake registrar below is what records the calls.
   * Reaching them means the runtime has grown a second path to the homeserver's
   * pusher registry, which the ordering tests would no longer be watching.
   */
  async registerPusher(): Promise<void> {
    throw new Error('the runtime must register pushers through pushRegistration');
  }

  async unregisterPusher(): Promise<void> {
    throw new Error('the runtime must remove pushers through pushRegistration');
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

/**
 * The runtime's one route to the homeserver's pusher registry.
 *
 * Records into the shared event log rather than counting calls, because what
 * these tests are about is ORDER: a pusher has to be removed while the access
 * token still works, which means before `logout` and not after.
 */
class FakePushRegistration implements MatrixPushRegistration {
  applies = 0;
  removes = 0;

  constructor(readonly events: string[]) {}

  async apply(): Promise<void> {
    this.applies += 1;
    this.events.push('registerPusher');
  }

  async remove(): Promise<void> {
    this.removes += 1;
    this.events.push('unregisterPusher');
  }
}

/**
 * The address bar of a browser that has just come back from the authorization
 * server, or of one that has not.
 *
 * `take` empties itself, because the real one does: it removes the response from
 * the URL as it reads it, so that a reload cannot resubmit an authorization code
 * that has already been spent.
 */
class FakePendingAuthorization implements MatrixPendingAuthorization {
  takes = 0;

  #callbackUrl: string | undefined;

  constructor(callbackUrl?: string) {
    this.#callbackUrl = callbackUrl;
  }

  take(): string | undefined {
    this.takes += 1;
    const url = this.#callbackUrl;
    this.#callbackUrl = undefined;
    return url;
  }
}

interface Harness {
  readonly runtime: MatrixRuntime;
  readonly pushRegistration: FakePushRegistration;
  /** What this launch of the app arrived holding, if anything. */
  readonly pendingAuthorization: FakePendingAuthorization;
  /**
   * The client this launch is on.
   *
   * A getter and not a field: signing out builds a new one, and a test that held
   * on to the first would be asserting about a client the runtime has already
   * thrown away.
   */
  client(): FakeChatClient;
  /** Every client ever built, oldest first. */
  readonly clients: FakeChatClient[];
  readonly storage: FakeSessionStorage;
  /**
   * Everything the runtime did, in order, across storage, the store and the
   * client. What most of these tests are actually about is this sequence.
   */
  readonly events: string[];
  /** What the browser step was asked to open, in order. */
  readonly opened: string[];
  /** The stores the runtime asked to have erased, in order. */
  readonly erased: AlloClientStore[];
  createClientCalls: number;
}

function harness(
  overrides: Partial<MatrixRuntimeDependencies> & {
    outcome?: () => Promise<AuthorizationOutcome>;
    createClientFails?: () => Error | undefined;
    storage?: FakeSessionStorage;
    eraseStoreFails?: Error;
    /** The authorization response this launch arrives with. Web only. */
    callbackUrl?: string;
  } = {},
): Harness {
  const storage = overrides.storage ?? new FakeSessionStorage();
  const events = storage.events;
  // One client up front, so a test can arm its failures before the runtime asks
  // for it. Every rebuild after that gets a new one.
  const clients: FakeChatClient[] = [new FakeChatClient(events)];
  const opened: string[] = [];
  const erased: AlloClientStore[] = [];
  const pushRegistration = new FakePushRegistration(events);
  const pendingAuthorization = new FakePendingAuthorization(overrides.callbackUrl);
  let builds = 0;
  const result: Harness = {
    pushRegistration,
    pendingAuthorization,
    client: () => {
      const client = clients[Math.max(builds - 1, 0)];
      if (client === undefined) {
        throw new Error('the harness lost track of its clients');
      }
      return client;
    },
    clients,
    storage,
    events,
    opened,
    erased,
    createClientCalls: 0,
    runtime: new MatrixRuntime({
      config: () => CONFIG,
      createClient: async () => {
        result.createClientCalls += 1;
        events.push('createClient');
        const failure = overrides.createClientFails?.();
        if (failure !== undefined) {
          throw failure;
        }
        builds += 1;
        if (clients.length < builds) {
          clients.push(new FakeChatClient(events));
        }
        return result.client();
      },
      eraseStore: async (store) => {
        events.push('eraseStore');
        erased.push(store);
        if (overrides.eraseStoreFails !== undefined) {
          throw overrides.eraseStoreFails;
        }
      },
      sessionStorage: storage,
      pushRegistration,
      pendingAuthorization,
      authorize: async (url) => {
        opened.push(url);
        return (await overrides.outcome?.()) ?? { kind: 'returned', callbackUrl: 'allo://matrix/oidc?code=abc' };
      },
      ...overrides,
    }),
  };
  return result;
}

/** A session already written down, as a previous launch would have left it. */
function stored(session: AlloSession = SESSION): FakeSessionStorage {
  const storage = new FakeSessionStorage();
  storage.value = encodeStoredSession(session);
  return storage;
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
    expect(context.client().request.completedWith).toBe('allo://matrix/oidc?code=abc');
    expect(context.client().startSyncCalls).toBe(1);
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

    expect(context.client().request.aborts).toBe(1);
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

    expect(context.client().beginOidcLoginCalls).toBe(1);
    expect(context.opened).toHaveLength(1);
  });

  it('does nothing when a sign-in is asked for on a signed-in runtime', async () => {
    const context = harness();

    await context.runtime.signIn();
    await context.runtime.signIn();

    expect(context.client().beginOidcLoginCalls).toBe(1);
  });

  it('reports a completion the homeserver rejected', async () => {
    const context = harness();
    context.client().request.completion = async () => {
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
    context.client().startSyncFails = new Error('sliding sync is not available');
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

    expect(context.client().startSyncCalls).toBe(1);
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

describe('MatrixRuntime sign-in that leaves the page', () => {
  /** What the web authorizer answers: the browser is being navigated away. */
  const leaves = async (): Promise<AuthorizationOutcome> => ({ kind: 'left' });

  it('says it is leaving instead of waiting for a page that will not come back', async () => {
    // The bug this whole path exists for was a popup, and a popup is blocked
    // without a gesture. A top-level redirect needs none — but it also never
    // resolves anything, so a runtime that kept waiting would sit on
    // `authorizing` forever, telling the screen to draw a spinner for an answer
    // that cannot arrive.
    const context = harness({ outcome: leaves });

    await context.runtime.signIn();
    await settle();

    expect(context.opened).toEqual(['https://auth.example/authorize?state=xyz']);
    expect(context.runtime.getState().phase).toBe('leaving');
    expect(context.runtime.getState().error).toBeUndefined();
  });

  it('leaves the authorization intact for the page that comes back', async () => {
    // Aborting would be the same as abandoning a login that is about to be
    // finished by the next launch. There is nothing local to release either: what
    // completes it is the context the port wrote down, not this object.
    const context = harness({ outcome: leaves });

    await context.runtime.signIn();
    await settle();

    expect(context.client().request.aborts).toBe(0);
    expect(context.client().request.completedWith).toBeUndefined();
  });

  it('finishes the login the next launch arrives holding', async () => {
    // The other half. A fresh page, a fresh client, an empty store, and an
    // authorization code in the URL that belongs to a request the port wrote
    // down before the page went away.
    const context = harness({ callbackUrl: CALLBACK_URL });
    context.client().canResume = true;

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.client().resumeOidcLoginCalls).toBe(1);
    expect(context.client().resumedRequest.completedWith).toBe(CALLBACK_URL);
    expect(context.client().beginOidcLoginCalls).toBe(0);
    expect(context.opened).toEqual([]);
    expect(context.runtime.getState()).toMatchObject({
      phase: 'ready',
      userId: '@nate:matrix.example',
    });
  });

  it('says it is finishing, not that it is waiting for a browser', async () => {
    // The screen for `authorizing` tells the person to go and finish signing in
    // in their browser. On the way back they have already done that, and it is
    // Allo that is busy — with the token exchange, the crypto stack and the
    // first sync.
    const context = harness({ callbackUrl: CALLBACK_URL });
    context.client().canResume = true;
    const phases: string[] = [];
    context.runtime.subscribe(() => {
      phases.push(context.runtime.getState().phase);
    });

    await settle();

    expect(phases).toContain('finishing');
    expect(phases).not.toContain('authorizing');
  });

  it('remembers a session it finished on the way in', async () => {
    // Same guarantee as any other sign-in: the Matrix device exists on the
    // homeserver the moment the exchange returns, and a launch that did not write
    // it down would mint another one next time.
    const context = harness({ callbackUrl: CALLBACK_URL });
    context.client().canResume = true;

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.storage.storedSession()).toEqual(SESSION);
    expect(context.events.indexOf('write')).toBeLessThan(context.events.indexOf('startSync'));
  });

  it('takes the response out of the address bar exactly once', async () => {
    // Taking is removing. A code left in the URL is resubmitted by a reload, and
    // the second submission always fails — which would report a failed sign-in
    // for a code that worked.
    const context = harness({ callbackUrl: CALLBACK_URL });
    context.client().canResume = true;

    context.runtime.subscribe(() => {});
    context.runtime.subscribe(() => {});
    await settle();

    expect(context.pendingAuthorization.takes).toBe(1);
    expect(context.pendingAuthorization.take()).toBeUndefined();
  });

  it('clears the address bar even on a launch that has a session already', async () => {
    // A bookmarked callback, or a tab restored days later. The session wins — it
    // is the only one of the two that can work — but the spent code still has no
    // business staying in the URL.
    const context = harness({ callbackUrl: CALLBACK_URL, storage: stored() });

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.pendingAuthorization.takes).toBe(1);
    expect(context.client().resumeOidcLoginCalls).toBe(0);
    expect(context.client().restoredWith).toEqual(SESSION);
    expect(context.runtime.getState().phase).toBe('ready');
  });

  it('refuses a callback it has no record of starting', async () => {
    // A callback URL opened in a different tab, or a second load of one whose
    // context the first load used up. There is no code verifier for it here and
    // no `state` to check it against, so it is not this browser's login.
    const context = harness({ callbackUrl: CALLBACK_URL });
    context.client().canResume = false;

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.runtime.getState().phase).toBe('failed');
    expect(context.storage.storedSession()).toBeUndefined();
  });

  it('ends a failed completion at the explanation, never at another redirect', async () => {
    // The dangerous one. Coming back from the authorization server and failing
    // must not put the runtime back in the state the automatic sign-in acts on,
    // because the page would leave again immediately and keep doing it.
    const context = harness({ callbackUrl: CALLBACK_URL });
    context.client().canResume = true;
    context.client().resumedRequest.completion = async () => {
      throw new Error('the authorization server rejected the code');
    };
    const phases: string[] = [];
    context.runtime.subscribe(() => {
      phases.push(context.runtime.getState().phase);
    });

    await settle();

    expect(context.runtime.getState().phase).toBe('failed');
    expect(phases).not.toContain('signed-out');
    expect(context.opened).toEqual([]);
    expect(context.client().beginOidcLoginCalls).toBe(0);
  });

  it('reports a client that could not even look for the login', async () => {
    const context = harness({ callbackUrl: CALLBACK_URL });
    context.client().resumeOidcLoginFails = new Error('sessionStorage is not available');

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.runtime.getState().phase).toBe('failed');
    expect(context.runtime.getState().error).toContain('sessionStorage is not available');
  });

  it('starts an ordinary launch signed out, having asked', async () => {
    // The common case on every platform: nothing in the URL, nothing stored. The
    // question is still asked, which is what keeps the boot path the same
    // everywhere.
    const context = harness();

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.pendingAuthorization.takes).toBe(1);
    expect(context.client().resumeOidcLoginCalls).toBe(0);
    expect(context.runtime.getState().phase).toBe('signed-out');
  });

  it('registers for notifications after a login it finished on the way in', async () => {
    const context = harness({ callbackUrl: CALLBACK_URL });
    context.client().canResume = true;

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.pushRegistration.applies).toBe(1);
    expect(context.events.indexOf('startSync')).toBeLessThan(
      context.events.indexOf('registerPusher'),
    );
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
    context.client().emitSyncState('running');

    let notifications = 0;
    context.runtime.subscribe(() => {
      notifications += 1;
    });
    await settle();
    notifications = 0;

    context.client().emitSyncState('running');
    context.client().emitSyncState('running');

    expect(notifications).toBe(0);

    context.client().emitSyncState('offline');
    expect(notifications).toBe(1);
  });

  it('answers with the same snapshot object while nothing changes', async () => {
    const context = harness();
    await context.runtime.signIn();

    const first = context.runtime.getState();
    context.client().emitSyncState(first.sync);

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

    context.client().emitSyncState('offline');

    expect(notifications).toBe(0);
  });
});

describe('MatrixRuntime session persistence', () => {
  it('reinstates a stored session without opening a browser', async () => {
    // The whole point. A launch that finds a session does not sign in again, so
    // the homeserver is not asked to mint a second Matrix device.
    const context = harness({ storage: stored() });

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.opened).toEqual([]);
    expect(context.client().beginOidcLoginCalls).toBe(0);
    expect(context.client().restoredWith).toEqual(SESSION);
    expect(context.runtime.getState()).toMatchObject({
      phase: 'ready',
      userId: '@nate:matrix.example',
    });
  });

  it('erases the store before it opens one it has no session for', async () => {
    // Order, not just the fact. What may be on disk is the store of a session
    // that is gone — a sign-out the app did not live to finish — and the SDKs'
    // stores hold one user each. Erasing after the client has opened it is the
    // same as not erasing at all.
    const context = harness();

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.erased).toEqual([STORE]);
    expect(context.events.indexOf('eraseStore')).toBeLessThan(
      context.events.indexOf('createClient'),
    );
  });

  it('leaves the store alone when it has a session to put back into it', async () => {
    // The store belongs to the session being restored. Erasing here would throw
    // away the device's encryption keys and every message it could still read.
    const context = harness({ storage: stored() });

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.erased).toEqual([]);
  });

  it('refuses a session stored for a different homeserver, and forgets it', async () => {
    // A build repointed at another homeserver. The device id in this session was
    // never issued there, and restoring it would ask that server about a device
    // it has never heard of.
    const context = harness({
      storage: stored({ ...SESSION, homeserverUrl: 'https://elsewhere.example' }),
    });

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.client().restoredWith).toBeUndefined();
    expect(context.storage.value).toBeUndefined();
    expect(context.erased).toEqual([STORE]);
    expect(context.runtime.getState().phase).toBe('signed-out');
  });

  it('writes the session down before it starts syncing', async () => {
    // The Matrix device exists on the homeserver the moment the login completes.
    // Everything between that and the write is a window in which the app can die
    // and leave a device nothing will ever recognise.
    const context = harness();

    await context.runtime.signIn();
    await settle();

    expect(context.storage.storedSession()).toEqual(SESSION);
    expect(context.events.indexOf('write')).toBeLessThan(
      context.events.indexOf('startSync'),
    );
  });

  it('writes down every session the SDK rotates to', async () => {
    // Under OIDC the tokens are short-lived and the SDK refreshes them on its
    // own. A session written once at login is correct for minutes and stale for
    // good, which is a session that looks persisted and stops restoring.
    const context = harness();
    await context.runtime.signIn();
    await settle();

    context.client().rotateSession(REFRESHED_SESSION);
    await settle();

    expect(context.storage.storedSession()).toEqual(REFRESHED_SESSION);
  });

  it('writes rotations one at a time, in the order they arrived', async () => {
    // Two writes that overlap can finish in either order, and the loser leaves
    // the older tokens on disk. Rotations arrive from the SDK, which does not
    // wait for anything.
    const context = harness();
    await context.runtime.signIn();
    await settle();
    const last: AlloSession = { ...SESSION, accessToken: 'secret-access-token-3' };

    context.storage.holdWrites = true;
    context.client().rotateSession(REFRESHED_SESSION);
    await settle();
    context.client().rotateSession(last);
    await settle();

    // Three rotations' worth of writes have been asked for; two have started.
    expect(context.storage.calls.filter((call) => call === 'write')).toHaveLength(2);

    context.storage.holdWrites = false;
    context.storage.releaseWrites();
    await settle();

    expect(context.storage.calls.filter((call) => call === 'write')).toHaveLength(3);
    expect(context.storage.storedSession()).toEqual(last);
  });

  it('keeps the stored session when a restore fails', async () => {
    // A homeserver that is down, or a phone opened with no network. Discarding
    // on the first failure would cost the user the device this whole mechanism
    // exists to keep.
    const context = harness({ storage: stored() });
    context.client().restoreSessionFails = new Error('the homeserver is unreachable');

    context.runtime.subscribe(() => {});
    await settle();

    expect(context.runtime.getState().phase).toBe('failed');
    expect(context.storage.storedSession()).toEqual(SESSION);
  });

  it('starts over on an erased store when the user signs in after a failed restore', async () => {
    // The client has had a session put into it, so it cannot be given another —
    // and the store under it belongs to the session that could not be reopened.
    const context = harness({ storage: stored() });
    context.client().restoreSessionFails = new Error('this session is not valid');
    context.runtime.subscribe(() => {});
    await settle();
    const spent = context.clients[0];

    await context.runtime.signIn();
    await settle();

    expect(context.createClientCalls).toBe(2);
    expect(spent?.beginOidcLoginCalls).toBe(0);
    expect(context.erased).toEqual([STORE]);
    expect(context.runtime.getState()).toMatchObject({
      phase: 'ready',
      userId: '@nate:matrix.example',
    });
  });

  it('gives the device back when a sign-in cannot be remembered', async () => {
    // A session that cannot be written down mints a Matrix device for one run of
    // the app, and the next launch mints another. Handing it back is the only
    // ending that does not accumulate them.
    const context = harness();
    context.storage.writeFails = new Error('the keychain refused the write');

    await context.runtime.signIn();
    await settle();

    expect(context.clients[0]?.logouts).toBe(1);
    expect(context.runtime.getState().phase).toBe('failed');
    expect(context.runtime.getState().error).toContain('could not remember');
  });

  it('signs in once across two launches', async () => {
    // One Matrix device per installation, stated as the thing a user would
    // notice: the second launch never reaches the browser.
    const storage = new FakeSessionStorage();

    const first = harness({ storage });
    await first.runtime.signIn();
    await settle();
    await first.runtime.close();

    const second = harness({ storage });
    second.runtime.subscribe(() => {});
    await settle();

    expect(first.opened).toHaveLength(1);
    expect(second.opened).toEqual([]);
    expect(second.client().restoredWith?.deviceId).toBe('DEVICE');
    expect(second.runtime.getState().phase).toBe('ready');
  });

  it('never puts the session in the state it publishes', async () => {
    // The state is read by components and drawn on screen. The tokens in a
    // session are credentials.
    const context = harness();

    await context.runtime.signIn();
    await settle();

    expect(JSON.stringify(context.runtime.getState())).not.toContain('secret-');
  });
});

describe('MatrixRuntime sign-out', () => {
  /** A runtime that has restored a session and is syncing. */
  async function signedIn(): Promise<Harness> {
    const context = harness({ storage: stored() });
    context.runtime.subscribe(() => {});
    await settle();
    return context;
  }

  it('clears the session, tells the homeserver, and comes back signed out', async () => {
    const context = await signedIn();

    await context.runtime.signOut();
    await settle();

    expect(context.clients[0]?.logouts).toBe(1);
    expect(context.storage.value).toBeUndefined();
    expect(context.runtime.getState()).toMatchObject({
      phase: 'signed-out',
      userId: undefined,
      error: undefined,
    });
  });

  it('clears the stored session before it tells the homeserver', async () => {
    // Interrupted after the clear, the next launch finds no session and erases
    // the store: clean. Interrupted the other way round it finds a session for a
    // device the homeserver has already forgotten, and fails to restore it on
    // every launch from then on.
    const context = await signedIn();

    await context.runtime.signOut();
    await settle();

    expect(context.events.indexOf('clear')).toBeLessThan(context.events.indexOf('logout'));
  });

  it('builds the next client on an erased store', async () => {
    const context = await signedIn();

    await context.runtime.signOut();
    await settle();

    expect(context.createClientCalls).toBe(2);
    expect(context.erased).toEqual([STORE]);
    expect(context.events.lastIndexOf('eraseStore')).toBeLessThan(
      context.events.lastIndexOf('createClient'),
    );
  });

  it('stops listening to a session it has signed out of', async () => {
    // A subscription left on the old client would write a dead session back into
    // storage the next time its SDK rotated the tokens, and the launch after
    // that would try to restore it.
    const context = await signedIn();
    const previous = context.clients[0];

    await context.runtime.signOut();
    await settle();
    previous?.rotateSession(REFRESHED_SESSION);
    await settle();

    expect(previous?.sessionListenerCount()).toBe(0);
    expect(context.storage.value).toBeUndefined();
  });

  it('finishes the sign-out when the local teardown fails', async () => {
    // The store did not go. The rebuild erases it anyway, because there is no
    // session left for it to belong to.
    const context = await signedIn();
    if (context.clients[0] !== undefined) {
      context.clients[0].logoutFails = new Error('the crypto store would not close');
    }

    await context.runtime.signOut();
    await settle();

    expect(context.storage.value).toBeUndefined();
    expect(context.erased).toEqual([STORE]);
    expect(context.runtime.getState().phase).toBe('signed-out');
  });

  it('refuses to sign out when the stored session cannot be cleared', async () => {
    // Reporting a sign-out while leaving an access token on the device is the
    // one outcome worse than not signing out.
    const context = await signedIn();
    context.storage.clearFails = new Error('the keychain refused');

    await context.runtime.signOut();
    await settle();

    expect(context.clients[0]?.logouts).toBe(0);
    expect(context.runtime.getState().phase).toBe('failed');
    expect(context.runtime.getState().error).toContain('could not forget');
  });

  it('shares one attempt between simultaneous sign-outs', async () => {
    // The second would be working on a client the first has already taken apart.
    const context = await signedIn();

    await Promise.all([context.runtime.signOut(), context.runtime.signOut()]);
    await settle();

    expect(context.clients[0]?.logouts).toBe(1);
    expect(context.createClientCalls).toBe(2);
  });

  it('does nothing when nobody has signed in', async () => {
    const context = harness();

    await context.runtime.signOut();

    expect(context.storage.calls).toEqual([]);
    expect(context.runtime.getState().phase).toBe('idle');
  });
});

describe('MatrixRuntime push registration', () => {
  /** A runtime that has restored a session and is syncing. */
  async function signedIn(): Promise<Harness> {
    const context = harness({ storage: stored() });
    context.runtime.subscribe(() => {});
    await settle();
    return context;
  }

  it('registers this device once the session is ready, after a sign-in', async () => {
    const context = harness();
    context.runtime.subscribe(() => {});
    await settle();

    await context.runtime.signIn();
    await settle();

    expect(context.pushRegistration.applies).toBe(1);
    // After the session is usable, never before: a pusher on a session that
    // failed to start syncing would be one nothing can withdraw.
    expect(context.events.indexOf('startSync')).toBeLessThan(
      context.events.indexOf('registerPusher'),
    );
  });

  it('registers this device on a launch that reinstates a stored session', async () => {
    const context = await signedIn();

    // The common case by far: a launch that does not go through a browser is
    // still a launch whose device token may have been reissued overnight.
    expect(context.pushRegistration.applies).toBe(1);
  });

  it('does not register when the sign-in never reached a working session', async () => {
    const context = harness();
    context.runtime.subscribe(() => {});
    await settle();
    context.client().startSyncFails = new Error('the homeserver is down');

    await context.runtime.signIn();
    await settle();

    expect(context.pushRegistration.applies).toBe(0);
  });

  it('does not let a failed registration fail the sign-in', async () => {
    // `apply` is documented never to throw, and the runtime does not await it
    // either: a phone that could not be registered is a gap in notifications and
    // not a session that has to be thrown away.
    const context = harness({
      pushRegistration: {
        apply: async () => {
          throw new Error('the push gateway is unreachable');
        },
        remove: async () => {},
      },
    });
    context.runtime.subscribe(() => {});
    await settle();

    await context.runtime.signIn();
    await settle();

    expect(context.runtime.getState().phase).toBe('ready');
  });

  it('withdraws the pusher before the token that authorises it is destroyed', async () => {
    const context = await signedIn();

    await context.runtime.signOut();
    await settle();

    expect(context.pushRegistration.removes).toBe(1);
    // `logout` invalidates the access token. Afterwards there is nothing left to
    // authenticate the call that removes the pusher, and the homeserver would go
    // on holding a device token belonging to a phone that has signed out.
    expect(context.events.indexOf('unregisterPusher')).toBeLessThan(
      context.events.indexOf('logout'),
    );
  });

  it('brings the homeserver in line when the preference changes', async () => {
    const context = await signedIn();

    await context.runtime.syncPushRegistration();

    // Called from the settings switch. Without it the app and the homeserver
    // would disagree until the next launch.
    expect(context.pushRegistration.applies).toBe(2);
  });

  it('has nothing to say about notifications before there is a session', async () => {
    const context = harness();

    await context.runtime.syncPushRegistration();

    expect(context.pushRegistration.applies).toBe(0);
  });
});
