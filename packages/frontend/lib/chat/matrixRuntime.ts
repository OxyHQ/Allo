import { eraseAlloChatStore } from '@/lib/matrix/store';
import type {
  AlloChatClient,
  AlloChatClientConfig,
  AlloChatClientFactory,
  AlloChatStoreEraser,
  AlloOidcLoginRequest,
  AlloSession,
  AlloSyncState,
  AlloUnsubscribe,
} from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { authorize, pendingAuthorization } from './matrixAuthorizer';
import type {
  AuthorizationOutcome,
  MatrixAuthorizer,
  MatrixPendingAuthorization,
} from './matrixAuthorization';
import { readMatrixClientConfig } from './matrixConfig';
import { decodeStoredSession, encodeStoredSession } from './matrixSession';
import { matrixSessionStorage, type MatrixSessionStorage } from './matrixSessionStorage';
import {
  defaultPushRegistrationDependencies,
  MatrixPushRegistrar,
  type MatrixPushRegistration,
} from './pushRegistration';

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
 *
 * ## One Matrix device per installation
 *
 * The rule this class exists to keep. A Matrix device is minted by a login and
 * is what a set of encryption keys hangs off; an app that logs in on every launch
 * fills the user's account with devices that can never be verified and can never
 * read each other's history. So a session is written down and reinstated, and the
 * two facts that make that work are both here:
 *
 * - **the stored session is the authority.** The client's store on disk belongs
 *   to the session in storage and to no other. A launch that finds no session
 *   erases the store before opening it, which is what makes every way of losing a
 *   session — a sign-out, a crash halfway through one, a record from an older
 *   Allo — end in the same clean state instead of in a client holding one
 *   session's tokens and another one's keys.
 * - **the session is not a snapshot.** The SDK rotates its tokens on its own, so
 *   what was written at login is stale within the hour;
 *   `AlloChatClient.observeSession` is subscribed to for exactly as long as the
 *   client lives, and every version it reports is written down.
 */

/** How far along the runtime is. */
export type MatrixPhase =
  /** Nothing has asked for a client yet. */
  | 'idle'
  /**
   * Building the client: loading the SDK, opening its stores, and reinstating
   * the session of a previous launch if there is one.
   */
  | 'starting'
  /** There is a client, and nobody has signed in. */
  | 'signed-out'
  /** An authorization is in flight in the browser. */
  | 'authorizing'
  /**
   * The browser is being sent to the authorization server, and this page is
   * going away.
   *
   * Web only, and the honest end of a web sign-in: the authorization is a
   * top-level navigation, so there is no returning to this runtime. What
   * finishes the login is the next launch of the app, at the redirect URI. A
   * promise that never resolved would have left the phase on `authorizing`
   * forever, which is a state machine claiming to wait for something that can no
   * longer arrive.
   */
  | 'leaving'
  /**
   * An authorization has been granted and is being turned into a session.
   *
   * Web only, and the other end of `leaving`: the browser is back on Allo with a
   * code in its URL, and what is happening is the token exchange, the crypto
   * stack coming up and the first sync. Distinct from `authorizing` because
   * nothing is waiting on a browser any more — a screen that said so would be
   * telling somebody to go and finish something they have already finished.
   */
  | 'finishing'
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
   * Deletes what a previous session left in the client's store.
   *
   * Separate from the client because it has to run when there is no client: a
   * store that outlived its session has to go *before* the next one opens it.
   */
  readonly eraseStore: AlloChatStoreEraser;
  /** Where the session is kept between launches. */
  readonly sessionStorage: MatrixSessionStorage;
  /**
   * Opens the authorization page and reports what the browser did. The middle of
   * OIDC's three steps, which the port deliberately does not own.
   */
  readonly authorize: MatrixAuthorizer;
  /**
   * The authorization response this launch arrived with, if it arrived with one.
   *
   * Web's half of {@link authorize}: there, the authorization leaves the page and
   * the answer comes back as a fresh launch of the app carrying a code in its
   * URL. Consulted on every build, on every platform, and only web ever answers.
   */
  readonly pendingAuthorization: MatrixPendingAuthorization;
  /**
   * Tells the homeserver whether to notify this device.
   *
   * Owned by the runtime rather than by a screen because a pusher belongs to the
   * session, and the session is what this class holds. See
   * `pushRegistration.ts` for why that is not an Effect.
   */
  readonly pushRegistration: MatrixPushRegistration;
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
  #signingOut: Promise<void> | undefined;
  #syncSubscription: AlloUnsubscribe | undefined;
  #sessionSubscription: AlloUnsubscribe | undefined;
  /**
   * Whether a session has been installed in the current client, or the attempt
   * has been made.
   *
   * "Or the attempt" is the point: a restore that failed halfway leaves a client
   * whose state nobody here can describe, and the port refuses a second session
   * on a client that already has one. Either way this client cannot be the one a
   * new login goes through, so a sign-in from here starts over with a fresh one.
   */
  #clientHoldsSession = false;
  /**
   * The tail of the queue of storage operations.
   *
   * Storage is written from two directions that do not coordinate — a sign-in or
   * sign-out the user asked for, and a token rotation the SDK did on its own —
   * and a write is not one indivisible step. Two that overlap can finish in
   * either order, and the loser leaves the older tokens behind. This is by
   * construction a promise that never rejects, so a failed write cannot break the
   * queue for the next one.
   */
  #storageQueue: Promise<void> = Promise.resolve();

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

  /**
   * Signs out: on the homeserver, from this device, and from storage.
   *
   * Concurrent calls share one attempt, for the same reason sign-ins do — the
   * second would be working on a client the first has already taken apart.
   */
  signOut(): Promise<void> {
    if (this.#signingOut === undefined) {
      this.#signingOut = this.#signOut().finally(() => {
        this.#signingOut = undefined;
      });
    }
    return this.#signingOut;
  }

  async #signIn(): Promise<void> {
    let client = await this.#ensureClient();
    if (client === undefined || this.#state.phase === 'ready') {
      return;
    }
    if (this.#clientHoldsSession) {
      // A client that has already had a session put into it — a restore that
      // failed is the way this happens — cannot be given a second one. Starting
      // over also erases the store, which is right: the session it belongs to is
      // one this launch could not use.
      client = await this.#startOver();
      if (client === undefined) {
        return;
      }
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

    if (outcome.kind === 'left') {
      // Web. The page is being replaced by the authorization server's, so there
      // is nothing left for this runtime to do and nothing to abort: the request
      // is about to be destroyed along with everything else here. What finishes
      // the login is {@link #resume}, on the next launch, from the context the
      // port wrote down before handing over the URL.
      this.#publish({ phase: 'leaving', error: undefined });
      return;
    }

    await this.#finishLogin(client, request, outcome.callbackUrl);
  }

  /**
   * The half of a sign-in that happens after the browser has answered.
   *
   * Shared by the two ways of getting here, which differ only in whether the app
   * survived the authorization: {@link #signIn} on a platform whose browser hands
   * control back, and {@link #resume} on web, where it is a different launch of
   * the app that arrives holding the code.
   */
  async #finishLogin(
    client: AlloChatClient,
    request: AlloOidcLoginRequest,
    callbackUrl: string,
  ): Promise<void> {
    let session: AlloSession;
    try {
      // The callback URL carries the authorization code, so it is never logged.
      session = await request.complete(callbackUrl);
      this.#clientHoldsSession = true;
    } catch (error) {
      this.#fail('Allo could not finish the sign-in', error);
      return;
    }

    try {
      // Written down before sync starts, and before anything is drawn. The
      // Matrix device exists on the homeserver the moment the line above
      // returned; from here until the session is stored there is a device this
      // installation would not recognise on its next launch, and the way to make
      // that window not matter is to make it as short as the code allows.
      await this.#remember(session);
    } catch (error) {
      // A sign-in that cannot be remembered is a device minted for one run of the
      // app, and the next launch would mint another. Better to give the device
      // back and say so than to accumulate them silently.
      await this.#signOut();
      this.#fail('Allo signed you in but could not remember it', error);
      return;
    }

    try {
      await client.startSync();
      this.#publish({ phase: 'ready', userId: session.userId, error: undefined });
    } catch (error) {
      this.#fail('Allo could not finish the sign-in', error);
      return;
    }

    this.#registerForNotifications(client);
  }

  /**
   * Finishes the login this launch of the app arrived holding.
   *
   * The second half of a web sign-in. The first half ended by replacing the
   * page, so what is here is a brand new client, an empty store, and an
   * authorization code in the URL that belongs to a request the port wrote down
   * before it let go.
   *
   * A failure ends at {@link MatrixPhase.failed}, which is what stops this from
   * becoming a loop: the screen explains itself and offers a button, and nothing
   * starts another authorization on its own. The alternative — falling back to
   * `signed-out` — would put the automatic sign-in back in charge of a page that
   * has just come back from a failed one, and the browser would ping-pong
   * between Allo and the authorization server until somebody killed the tab.
   */
  async #resume(client: AlloChatClient, callbackUrl: string): Promise<void> {
    this.#publish({ phase: 'finishing', error: undefined });

    let request: AlloOidcLoginRequest | undefined;
    try {
      request = await client.resumeOidcLogin();
    } catch (error) {
      this.#fail('Allo could not finish the sign-in', error);
      return;
    }

    if (request === undefined) {
      // A code with no request behind it: a callback URL opened in a new tab, a
      // page restored from a bookmark, a second load of a callback whose context
      // the first one used up. None of them can be completed, and none of them is
      // this browser's login.
      this.#fail(
        'Allo could not finish the sign-in',
        new Error('this browser has no record of the sign-in that was started'),
      );
      return;
    }

    await this.#finishLogin(client, request, callbackUrl);
  }

  async #signOut(): Promise<void> {
    const client = this.#client;
    if (client === undefined) {
      return;
    }

    // The stored session goes first, and everything else is allowed to fail
    // afterwards. The worst state this can be interrupted in is a store with no
    // session, which the next launch erases before it opens anything — where the
    // reverse order's worst state is a session pointing at a device the
    // homeserver has already forgotten.
    try {
      await this.#forget();
    } catch (error) {
      // Refusing to go on is the honest answer: carrying on would report a
      // sign-out while leaving the user's access token on the device.
      this.#fail('Allo could not forget your session', error);
      return;
    }
    this.#publish({ phase: 'starting', userId: undefined, error: undefined });

    // Before `logout`, and not after: the call needs the access token that
    // logging out destroys. A pusher left on the homeserver holds a token that
    // now belongs to nobody, and what it produces is a notification on a phone
    // that has signed out.
    //
    // A failure here does not stop the sign-out. A user pressing sign out on a
    // train has signed out, and the pusher they leave behind goes when the
    // homeserver drops the access token it belongs to.
    try {
      await this.#dependencies.pushRegistration.remove(client);
    } catch (error) {
      logger.error('[chat] this device could not withdraw its notifications', error);
    }

    try {
      await client.logout();
    } catch (error) {
      // The port's `logout` reports an unreachable homeserver by logging, so a
      // throw here is local: the store did not go. Not fatal, because rebuilding
      // erases it — there is no session left for it to belong to.
      logger.error('[chat] a Matrix sign-out did not finish cleanly', error);
    }

    // Already closed by `logout`, but detaching is what drops the subscriptions
    // and lets the next `#ensureClient` build rather than hand back this one.
    this.#detach();
    await this.#ensureClient();
  }

  /**
   * Brings this device's pusher in line with the notification preference.
   *
   * Public because the settings screen changes that preference and the homeserver
   * has to hear about it; a runtime that only registered at sign-in would leave
   * the switch in the app disagreeing with the pusher on the server. A no-op
   * before there is a client, which is what makes it safe to call from anywhere.
   */
  async syncPushRegistration(): Promise<void> {
    const client = this.#client;
    if (client === undefined || this.#state.phase !== 'ready') {
      return;
    }
    await this.#applyPushRegistration(client);
  }

  /**
   * Registers for notifications, without making the session wait for it.
   *
   * Not awaited on purpose. It is a round trip to Allo's backend and another to
   * the homeserver, and neither has anything to do with drawing the conversation
   * list — a sign-in that blocked on them would be a sign-in that fails whenever
   * the push provider is having a bad day.
   */
  #registerForNotifications(client: AlloChatClient): void {
    void this.#applyPushRegistration(client);
  }

  /**
   * Asks the registrar to act, and refuses to let its failure escape.
   *
   * `MatrixPushRegistration.apply` is documented never to throw, and this does
   * not rely on that. One of the two callers deliberately does not await, and an
   * unawaited promise that rejects is an unhandled rejection — which on a phone
   * is a crash, in a screen that has nothing to do with notifications, over a
   * push gateway that was briefly unreachable.
   */
  async #applyPushRegistration(client: AlloChatClient): Promise<void> {
    try {
      await this.#dependencies.pushRegistration.apply(client);
    } catch (error) {
      logger.error('[chat] this device could not be registered for notifications', error);
    }
  }

  /**
   * Throws away the current client and everything it was working with, and comes
   * back with a new one on an empty store.
   *
   * The homeserver is not told, which is what separates this from
   * {@link signOut}: it is used when there is no usable session to end, only a
   * client that cannot be reused.
   */
  async #startOver(): Promise<AlloChatClient | undefined> {
    try {
      await this.#forget();
    } catch (error) {
      this.#fail('Allo could not clear the session it could not reopen', error);
      return undefined;
    }
    const previous = this.#detach();
    // Closed before the rebuild, because the rebuild erases the store and the
    // client that was holding it open is this one.
    await previous?.close();
    return this.#ensureClient();
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
      // Taken before anything else can decide this is an ordinary launch, and
      // taken whether or not it turns out to be usable: leaving a spent
      // authorization code in the address bar is what makes a reload resubmit
      // it. On every platform but web this is always `undefined`.
      const callbackUrl = this.#dependencies.pendingAuthorization.take();
      const stored = await this.#readStoredSession(config.homeserverUrl);

      if (stored === undefined) {
        // Nothing is being restored, so nothing on disk belongs to this launch.
        // What may be there is the store of a session that is gone — a sign-out
        // the app did not live long enough to finish, a record written by an
        // Allo that stored them differently — and the SDKs' stores hold one user
        // each. Erasing here is what makes every one of those endings look the
        // same to the client that opens next.
        await this.#dependencies.eraseStore(config.store);
      }

      const client = await this.#dependencies.createClient(config);
      this.#config = config;
      this.#client = client;
      this.#syncSubscription = client.observeSyncState((sync) => {
        this.#publish({ sync });
      });
      // Subscribed before anything can rotate: for as long as this client lives,
      // every version of its session is written down. See the note at the top of
      // this file.
      this.#sessionSubscription = client.observeSession(this.#onSessionRotated);

      if (stored !== undefined) {
        // A session already on this device wins over a callback. The two
        // together mean a login that finished and a stale URL — a bookmarked
        // callback, a restored tab — and reopening the session that exists is
        // both what the user wants and the only one of the two that can work.
        await this.#restore(client, stored);
      } else if (callbackUrl !== undefined) {
        await this.#resume(client, callbackUrl);
      } else {
        this.#publish({ phase: 'signed-out', error: undefined });
      }
      return client;
    } catch (error) {
      // Cleared so that the next attempt — a user pressing sign in again —
      // rebuilds instead of handing back this failure forever.
      this.#starting = undefined;
      this.#fail('Allo could not start its Matrix client', error);
      return undefined;
    }
  }

  /**
   * Puts a stored session back into a fresh client and starts syncing.
   *
   * A failure here is reported and the stored session is **kept**. The reasons a
   * restore fails are not all permanent — a homeserver that is down, a phone with
   * no network at the moment it was opened — and discarding on the first one
   * would cost the user the device this whole mechanism exists to preserve. What
   * discards it is the user asking to sign in again, which is an answer only they
   * can give.
   */
  async #restore(client: AlloChatClient, session: AlloSession): Promise<void> {
    this.#clientHoldsSession = true;
    try {
      await client.restoreSession(session);
      await client.startSync();
    } catch (error) {
      this.#fail('Allo could not reopen your last session', error);
      return;
    }
    this.#publish({ phase: 'ready', userId: session.userId, error: undefined });
    this.#registerForNotifications(client);
  }

  /**
   * The session of a previous launch, if there is one this build can use.
   *
   * A record that cannot be used is removed rather than left to be rediscovered
   * and re-refused on every launch, and the reason is logged once — it names a
   * device whose keys are being abandoned, which is worth knowing about.
   */
  async #readStoredSession(homeserverUrl: string): Promise<AlloSession | undefined> {
    const stored = await this.#dependencies.sessionStorage.read();
    const outcome = decodeStoredSession(stored, homeserverUrl);
    if (outcome.kind === 'session') {
      return outcome.session;
    }
    if (outcome.kind === 'unusable') {
      logger.warn(`[chat] the stored Matrix session was not reinstated: ${outcome.reason}`);
      await this.#forget();
    }
    return undefined;
  }

  /**
   * The SDK has replaced the session's tokens.
   *
   * Not awaited, and that is not laziness: the port reports this from inside the
   * SDK's own refresh, on native synchronously from Rust's thread, and anything
   * that blocked here would block the refresh. A write that fails is logged and
   * costs the next launch one extra refresh, because what is still stored is the
   * previous session and the refresh token in it has not been used yet.
   */
  readonly #onSessionRotated = (session: AlloSession): void => {
    void this.#remember(session).catch((error) => {
      logger.error('[chat] a refreshed Matrix session could not be stored', error);
    });
  };

  #remember(session: AlloSession): Promise<void> {
    return this.#sequence(() =>
      this.#dependencies.sessionStorage.write(encodeStoredSession(session)),
    );
  }

  #forget(): Promise<void> {
    return this.#sequence(() => this.#dependencies.sessionStorage.clear());
  }

  /** Runs one storage operation after the last, and reports its own failure. */
  #sequence(operation: () => Promise<void>): Promise<void> {
    const done = this.#storageQueue.then(operation);
    // The queue itself must never reject: a failure belongs to the caller that
    // asked for it, and the operation queued behind still has to run.
    this.#storageQueue = done.then(ignoreOutcome, ignoreOutcome);
    return done;
  }

  /**
   * Lets go of the current client, and hands it back for the caller to close.
   *
   * Closing is the caller's because the two callers want it at different moments:
   * a sign-out has already closed the client through `logout`, and starting over
   * has to wait for the close before the store underneath can be erased.
   */
  #detach(): AlloChatClient | undefined {
    this.#syncSubscription?.();
    this.#syncSubscription = undefined;
    this.#sessionSubscription?.();
    this.#sessionSubscription = undefined;
    this.#clientHoldsSession = false;

    const client = this.#client;
    this.#client = undefined;
    this.#config = undefined;
    this.#starting = undefined;
    return client;
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
   * Tears everything down, leaving the stored session where it is.
   *
   * Not a sign-out and not a way to reach one: it releases the client and goes
   * back to the state before anything asked for one, which is what a test wants
   * between cases. {@link signOut} is what ends a session.
   */
  async close(): Promise<void> {
    const client = this.#detach();
    this.#publish(IDLE_RUNTIME_STATE);
    await client?.close();
  }
}

/** Turns a settled promise into a settled promise with nothing in it. */
const ignoreOutcome = (): void => {};

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
  // Not behind the dynamic import, and it does not need to be: the store modules
  // name directories and databases, and neither of them loads a Matrix SDK.
  eraseStore: eraseAlloChatStore,
  sessionStorage: matrixSessionStorage,
  pushRegistration: new MatrixPushRegistrar(defaultPushRegistrationDependencies()),
  // Platform-split, because the two platforms do genuinely different things: an
  // in-app browser tab that returns control on iOS and Android, a top-level
  // redirect that destroys this page on web. See `matrixAuthorization.ts`.
  authorize,
  pendingAuthorization,
};

/** The app's runtime. Built here and nowhere else. */
export const matrixRuntime = new MatrixRuntime(defaultDependencies);
