import * as WebBrowser from 'expo-web-browser';

import type {
  AlloChatClient,
  AlloChatClientConfig,
  AlloChatClientFactory,
  AlloOidcLoginRequest,
  AlloSyncState,
  AlloUnsubscribe,
} from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { readMatrixClientConfig } from './matrixConfig';

/**
 * The one Matrix client the app has, and its lifecycle.
 *
 * This lives outside React on purpose. A Matrix client with a sync loop is a
 * long-running connection to an external system — the one thing an Effect is
 * genuinely for — but it belongs to the *app*, not to whichever screen happened
 * to mount first, and an Effect would tie it to a component's lifetime: unmount
 * the conversation list and the sync loop would stop, remount it and a second one
 * would start. Under StrictMode that happens on the first render anyway.
 *
 * So the client is owned here, at module scope, and React reads it through
 * {@link MatrixRuntime.subscribe} and {@link MatrixRuntime.getState} — the shape
 * `useSyncExternalStore` wants. No Effect anywhere in the chain.
 */

/** How far along the runtime is. */
export type MatrixPhase =
  /** Nothing has asked for a client yet. */
  | 'idle'
  /** Building the client: loading the SDK, opening its stores. */
  | 'starting'
  /** There is a client, and nobody has signed in. */
  | 'signed-out'
  /** An authorization is in flight in the browser. */
  | 'authorizing'
  /** Signed in, sync running: the room list and timelines can be opened. */
  | 'ready'
  /** Something failed. {@link MatrixRuntimeState.error} says what. */
  | 'failed';

export interface MatrixRuntimeState {
  readonly phase: MatrixPhase;
  /** The signed-in user's Matrix id, once there is one. */
  readonly userId: string | undefined;
  /**
   * The sync loop's own state, which is not the same question as the phase: a
   * `ready` runtime whose sync is `offline` still has a room list to draw, from
   * the last sync that worked.
   */
  readonly sync: AlloSyncState;
  /** Why the runtime failed, in words a user could be shown. */
  readonly error: string | undefined;
}

/** What the browser came back with, if it came back. */
export type AuthorizationOutcome =
  | { readonly kind: 'returned'; readonly callbackUrl: string }
  | { readonly kind: 'dismissed' };

/**
 * Everything the runtime does that is not its own logic.
 *
 * Injected so that a test can drive the whole state machine without a homeserver,
 * a browser, or either Matrix SDK.
 */
export interface MatrixRuntimeDependencies {
  readonly config: () => AlloChatClientConfig;
  readonly createClient: AlloChatClientFactory;
  /**
   * Opens the authorization page and reports the URL the browser was redirected
   * back to. The middle of OIDC's three steps, which the port deliberately does
   * not own.
   */
  readonly authorize: (
    authorizationUrl: string,
    redirectUri: string,
  ) => Promise<AuthorizationOutcome>;
}

/**
 * What the room list and the timelines need of the runtime.
 *
 * Named separately from the class because {@link MatrixRuntime} has private
 * fields, which makes it a nominal type nothing else can stand in for — and the
 * two sources want a runtime they can drive from a test. The same shape the port
 * itself uses for `OidcLoginClient` and `TimelineRow`.
 */
export interface MatrixRuntimeLike {
  subscribe(listener: () => void): AlloUnsubscribe;
  getState(): MatrixRuntimeState;
  client(operation: string): AlloChatClient;
}

/** The client was asked for before there was one. */
export class MatrixClientNotStartedError extends Error {
  constructor(operation: string) {
    super(
      `${operation} needs a signed-in Matrix client. Wait for the runtime to ` +
        'reach the "ready" phase.',
    );
    this.name = 'MatrixClientNotStartedError';
  }
}

/** Nothing has happened yet. Also what a build with the flag off always reports. */
export const IDLE_RUNTIME_STATE: MatrixRuntimeState = {
  phase: 'idle',
  userId: undefined,
  sync: 'idle',
  error: undefined,
};

export class MatrixRuntime implements MatrixRuntimeLike {
  readonly #dependencies: MatrixRuntimeDependencies;
  readonly #listeners = new Set<() => void>();

  #state: MatrixRuntimeState = IDLE_RUNTIME_STATE;
  #client: AlloChatClient | undefined;
  #config: AlloChatClientConfig | undefined;
  #starting: Promise<AlloChatClient | undefined> | undefined;
  #signingIn: Promise<void> | undefined;
  #syncSubscription: AlloUnsubscribe | undefined;

  constructor(dependencies: MatrixRuntimeDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Watches the runtime, and starts it.
   *
   * Subscribing is what brings the client up, rather than a separate call some
   * screen has to remember to make: the first thing that wants to know the state
   * is by definition the first thing that needs a client. Building is guarded, so
   * a hundred subscribers still build one.
   */
  readonly subscribe = (listener: () => void): AlloUnsubscribe => {
    this.#listeners.add(listener);
    // Not awaited, and its failure is not rethrown: a build that fails reports
    // itself through the state every subscriber is already reading.
    void this.#ensureClient();
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getState = (): MatrixRuntimeState => this.#state;

  /**
   * The client, for the code that drives it.
   *
   * Throws rather than returning `undefined` because every caller wants it in the
   * `ready` phase, and a caller that asks earlier has a bug an optional type would
   * let it carry around.
   */
  client(operation: string): AlloChatClient {
    if (this.#client === undefined) {
      throw new MatrixClientNotStartedError(operation);
    }
    return this.#client;
  }

  /**
   * Signs in, in OIDC's three steps: ask the port for a URL, hand it to a browser,
   * come back with whatever the browser was redirected to.
   *
   * Concurrent calls share one attempt. Two authorizations would each hold state
   * on the authorization server and only one could be completed.
   */
  signIn(): Promise<void> {
    if (this.#signingIn === undefined) {
      this.#signingIn = this.#signIn().finally(() => {
        this.#signingIn = undefined;
      });
    }
    return this.#signingIn;
  }

  async #signIn(): Promise<void> {
    const client = await this.#ensureClient();
    if (client === undefined || this.#state.phase === 'ready') {
      return;
    }
    const config = this.#config;
    if (config === undefined) {
      throw new MatrixClientNotStartedError('Signing in');
    }

    this.#publish({ phase: 'authorizing', error: undefined });

    let request: AlloOidcLoginRequest;
    try {
      request = await client.beginOidcLogin();
    } catch (error) {
      this.#fail('Allo could not start a sign-in with the homeserver', error);
      return;
    }

    let outcome: AuthorizationOutcome;
    try {
      outcome = await this.#dependencies.authorize(
        request.authorizationUrl,
        config.oidc.redirectUri,
      );
    } catch (error) {
      await this.#abort(request);
      this.#fail('Allo could not open the sign-in page', error);
      return;
    }

    if (outcome.kind === 'dismissed') {
      // Releases what the authorization server is holding for the attempt. A
      // user who closes the browser has not failed at anything.
      await this.#abort(request);
      this.#publish({ phase: 'signed-out', error: undefined });
      return;
    }

    try {
      // The callback URL carries the authorization code, so it is never logged.
      const session = await request.complete(outcome.callbackUrl);
      await client.startSync();
      this.#publish({ phase: 'ready', userId: session.userId, error: undefined });
    } catch (error) {
      this.#fail('Allo could not finish the sign-in', error);
    }
  }

  async #ensureClient(): Promise<AlloChatClient | undefined> {
    if (this.#client !== undefined) {
      return this.#client;
    }
    if (this.#starting === undefined) {
      this.#publish({ phase: 'starting', error: undefined });
      this.#starting = this.#build();
    }
    return this.#starting;
  }

  async #build(): Promise<AlloChatClient | undefined> {
    try {
      const config = this.#dependencies.config();
      const client = await this.#dependencies.createClient(config);
      this.#config = config;
      this.#client = client;
      this.#syncSubscription = client.observeSyncState((sync) => {
        this.#publish({ sync });
      });
      this.#publish({ phase: 'signed-out', error: undefined });
      return client;
    } catch (error) {
      // Cleared so that the next attempt — a user pressing sign in again —
      // rebuilds instead of handing back this failure forever.
      this.#starting = undefined;
      this.#fail('Allo could not start its Matrix client', error);
      return undefined;
    }
  }

  async #abort(request: AlloOidcLoginRequest): Promise<void> {
    try {
      await request.abort();
    } catch (error) {
      // Abandoning an authorization that the server has already forgotten is not
      // a problem the user can do anything about, and it must not replace the
      // reason the sign-in is being abandoned in the first place.
      logger.warn('[chat] a Matrix sign-in could not be abandoned cleanly', error);
    }
  }

  #fail(summary: string, error: unknown): void {
    logger.error(`[chat] ${summary}`, error);
    const detail = error instanceof Error ? error.message : String(error);
    this.#publish({ phase: 'failed', error: `${summary}: ${detail}` });
  }

  /**
   * Replaces the state and tells everyone, unless nothing changed.
   *
   * The equality check is not an optimisation: `useSyncExternalStore` re-renders
   * whenever the snapshot is a different object, so a runtime that published a new
   * object for every repeated sync heartbeat would re-render the conversation list
   * for nothing.
   */
  #publish(patch: Partial<MatrixRuntimeState>): void {
    const next: MatrixRuntimeState = { ...this.#state, ...patch };
    if (
      next.phase === this.#state.phase &&
      next.userId === this.#state.userId &&
      next.sync === this.#state.sync &&
      next.error === this.#state.error
    ) {
      return;
    }
    this.#state = next;
    for (const listener of this.#listeners) {
      listener();
    }
  }

  /**
   * Tears everything down. Tests use it; the app has no sign-out yet, which is
   * the same missing piece as session persistence — see `matrixConfig.ts`.
   */
  async close(): Promise<void> {
    this.#syncSubscription?.();
    this.#syncSubscription = undefined;
    const client = this.#client;
    this.#client = undefined;
    this.#config = undefined;
    this.#starting = undefined;
    this.#publish(IDLE_RUNTIME_STATE);
    await client?.close();
  }
}

/**
 * How the runtime reaches the world when it is not under test.
 *
 * The port is loaded with a dynamic import so that nothing in a Matrix SDK is
 * *executed* in a build whose flag says `allo-api`. That matters more than bundle
 * size: the native SDK sets up process-global Rust logging the moment its module
 * is evaluated, and the web one reaches for IndexedDB. Neither should happen in a
 * configuration that is supposed to be the app as it was.
 */
const defaultDependencies: MatrixRuntimeDependencies = {
  config: readMatrixClientConfig,
  createClient: async (config) => {
    const { createAlloChatClient } = await import('@/lib/matrix/client');
    return createAlloChatClient(config);
  },
  authorize: async (authorizationUrl, redirectUri) => {
    const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri);
    return result.type === 'success'
      ? { kind: 'returned', callbackUrl: result.url }
      : { kind: 'dismissed' };
  },
};

/** The app's runtime. Built here and nowhere else. */
export const matrixRuntime = new MatrixRuntime(defaultDependencies);
