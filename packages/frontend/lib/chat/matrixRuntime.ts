import { MatrixStoreEraseBlockedError } from '@/lib/matrix/errors';
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
import { matrixSignInAttempt, type MatrixSignInAttempt } from './matrixSignInAttempt';
import {
  matrixStoreOwnerStorage,
  sameStoreOwner,
  storeOwnerOf,
  type MatrixStoreOwnerStorage,
} from './matrixStoreOwner';
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
 *
 * ## One identity per store, proven rather than assumed
 *
 * The two facts above were both true and together they were still not enough,
 * because "a launch that finds no session erases the store" says nothing about
 * the launch that finds one. A session in storage and a store on disk are two
 * separate things written at two separate moments, and the app used to open them
 * together on the strength of their both being there. Switch the account signed
 * in on the device and that is a client authenticating as one identity while
 * reading the last identity's synced state and holding its decryption keys.
 *
 * So the store now records whose it is, outside itself, in `matrixStoreOwner.ts`,
 * and this class enforces one rule at the top of every build:
 *
 * > **A stored session may only be reinstated when the store on disk is recorded
 * > as belonging to exactly that session. Otherwise both are erased.**
 *
 * One branch, and every case falls into it: a store nobody claimed, which is
 * every store written before this rule existed; a store claimed by a different
 * account; a session with no store; a store with no session; a sign-out that was
 * interrupted halfway. Erasing both rather than keeping the session is
 * deliberate — a Matrix device whose keys have gone cannot decrypt anything and
 * cannot be re-verified, so reinstating it would only produce a broken device
 * instead of a new one.
 *
 * **An erase that fails stops the launch.** It is raised by the store modules, it
 * is not caught here, and {@link MatrixRuntime} ends at {@link
 * MatrixPhase.failed} with no client. A store that could not be emptied must not
 * be opened by the identity that comes next; that is the whole point of emptying
 * it.
 *
 * ## An erase that is waiting says so
 *
 * The one case where stopping the launch was right and saying nothing was not.
 * On web a second window of Allo holding the database open makes the deletion
 * wait, and waiting is correct — it completes the moment that window closes. But
 * the wait used to happen inside a phase called `starting`, so the screen drew
 * "Connecting…" and kept drawing it, for as long as a tab nobody remembered
 * opening stayed open. There was no way to learn that from inside the app and no
 * way out but closing windows at random.
 *
 * So the erase reports itself (`AlloStoreEraseObserver`) and the two states it
 * can be in are two phases here: `blocked` while it waits, which leaves by
 * itself in either direction, and `blocked-timed-out` when the wait has been
 * given up on. Neither builds a client. The second one especially: a bound that
 * fell through into `createClient` would be this class opening a store it has
 * just admitted it could not empty.
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
  /**
   * The data this launch has to erase is open somewhere else, and the erase is
   * waiting for it to be let go of.
   *
   * Web only, and always somebody else's browsing context: it is what IndexedDB
   * reports when a second window of Allo still has the database open. Nothing is
   * wrong and nothing has failed — the deletion completes on its own the moment
   * that window closes, and this phase goes back to `starting` by itself when it
   * does. It exists so the screen can say which window to close, which is the
   * only thing anybody can do about it and the one thing the app used to keep to
   * itself.
   */
  | 'blocked'
  /**
   * The wait above was given up on.
   *
   * Terminal, and distinct from `failed` in what it can honestly ask for: this
   * is not something that went wrong, it is a window that is still open, so the
   * screen asks again and offers to retry rather than apologising. **No client
   * is built and no store is opened** — the store this launch could not empty is
   * exactly the store the next identity must not inherit.
   */
  | 'blocked-timed-out'
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
   * Where the answer to "whose is the store on disk" is kept.
   *
   * Separate from {@link sessionStorage} because it has to be readable when the
   * session is not, and writable when there is no session to attach it to. See
   * `matrixStoreOwner.ts`.
   */
  readonly storeOwner: MatrixStoreOwnerStorage;
  /**
   * Whether this run has already started an automatic sign-in.
   *
   * The runtime does not read it — the gate does — but it is the one place that
   * knows when the attempt stopped describing the person using the app, which is
   * the moment a session belonging to somebody else is refused.
   */
  readonly signInAttempt: MatrixSignInAttempt;
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

/**
 * Work that started on a session the runtime has since stopped keeping.
 *
 * Raised rather than allowed to finish, and the case it is really for is the
 * quiet one: a token rotation queued for storage while the app was signing out,
 * landing after the sign-out cleared the session and putting it back. On disk
 * that is indistinguishable from the defect this class was reworked to remove —
 * a session belonging to somebody who is no longer using the app, waiting to be
 * reinstated on the next launch.
 */
export class MatrixRuntimeSupersededError extends Error {
  constructor(operation: string) {
    super(
      `${operation} was abandoned: it belongs to a Matrix session this runtime ` +
        'has already stopped keeping.',
    );
    this.name = 'MatrixRuntimeSupersededError';
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
   * Which session the runtime is currently keeping, or `undefined` for none.
   *
   * A number that is never reused, opened when a session is installed in the
   * client and closed the moment the runtime stops intending to keep it — the
   * top of a sign-out, the top of a start-over, and every detach. Everything
   * that awaits and then writes reads it first and checks it again afterwards.
   *
   * It is checked rather than assumed because the gap between an await and the
   * write after it is not short, and the client stays subscribed across it. A
   * sign-out is two awaits and a round trip to the homeserver, and the SDK is
   * free to rotate its tokens the whole way through: a rotation landing in that
   * gap wrote the session back AFTER the sign-out had cleared it, and the next
   * launch reinstated a session the user had ended. A `#startOver` has the same
   * shape against the sign-in that asked for it.
   *
   * Closing it — rather than counting client rebuilds — is what makes the check
   * work at all. During a sign-out the client has not been let go of yet, so
   * anything that asked "is this still the current client" would be told yes.
   */
  #sessionEpoch: number | undefined;
  /** Source of {@link #sessionEpoch}. Only ever moves forward. */
  #nextSessionEpoch = 0;
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
    // There is a session, and from here the runtime intends to keep it.
    const epoch = this.#openSessionEpoch();

    try {
      // The store is claimed first and the session written second, and an
      // interruption between them is why. Stopping after the claim leaves a store
      // belonging to a session nobody wrote down, which the next launch erases;
      // stopping after the reverse would leave a session whose store the next
      // launch erases underneath it, which is a device with no keys rather than
      // no device.
      //
      // Both happen before sync starts and before anything is drawn. The Matrix
      // device exists on the homeserver the moment `complete` returned; from here
      // until these two lines are done there is a device this installation would
      // not recognise on its next launch, and the way to make that window not
      // matter is to make it as short as the code allows.
      await this.#dependencies.storeOwner.write(storeOwnerOf(session));
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
    } catch (error) {
      this.#fail('Allo could not finish the sign-in', error);
      return;
    }

    if (epoch !== this.#sessionEpoch) {
      // Signed out, or started over, while this login was finishing. The session
      // it produced is already gone from storage and the client it produced is
      // not this runtime's any more, so announcing it ready would put a phase on
      // screen that nothing behind it can serve.
      return;
    }

    this.#publish({ phase: 'ready', userId: session.userId, error: undefined });
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

    // Before anything else, and this line is a fix rather than bookkeeping. The
    // client is not let go of until the end of this method, so between clearing
    // the session below and `#detach` at the bottom the runtime is still
    // subscribed to the SDK's token rotations and the SDK is still free to
    // rotate — two awaits' worth of window, one of them a round trip to the
    // homeserver. A rotation landing in there used to write the session back
    // AFTER the sign-out had cleared it, leaving the next launch to reinstate a
    // session the user had ended.
    this.#sessionEpoch = undefined;

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
    // Same window as {@link #signOut}: the old client is still subscribed until
    // `#detach` below, and what is being discarded is a session.
    this.#sessionEpoch = undefined;
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
      const stored = await this.#reinstatable(
        await this.#readStoredSession(config.homeserverUrl),
        config,
      );

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
      if (error instanceof MatrixStoreEraseBlockedError) {
        // Not a defect and not the app's fault, so it is neither logged as an
        // error nor drawn as one. The store was not erased, which is why this
        // returns without a client like every other failure here: the phase is
        // different, the guarantee is the same.
        logger.warn(
          '[chat] the chat data on this device is still open in another window, so ' +
            'this one stopped rather than open it',
          error,
        );
        this.#publish({ phase: 'blocked-timed-out', error: undefined });
        return undefined;
      }
      this.#fail('Allo could not start its Matrix client', error);
      return undefined;
    }
  }

  /**
   * Decides whether the stored session may be reinstated, and makes the answer
   * true on disk.
   *
   * The one place the store is erased, and the one place that decides it. It
   * answers the session when the store on disk is recorded as that session's, and
   * `undefined` in every other case — having first emptied the store and thrown
   * the session away, so that the client built next opens something that is
   * nobody's rather than somebody else's.
   *
   * The order inside is the part worth reading. The marker is cleared BEFORE the
   * erase, never after: a launch killed midway through deleting a database then
   * comes back to a store recorded as nobody's, which is a state this method
   * erases again. Recording first and erasing second would leave a half-deleted
   * store carrying a marker that says it is intact.
   *
   * A failure at any step propagates to {@link #build}, which is what stops the
   * launch. That is deliberate for all three: a marker that cannot be cleared
   * cannot be trusted, a store that cannot be emptied must not be reopened, and a
   * session that cannot be forgotten would be reinstated by the next launch
   * against the store this one just erased.
   *
   * The erase is watched rather than only awaited, and what comes out of it is a
   * phase. A deletion another window of Allo is holding up completes when that
   * window closes, so the wait is kept — but it is announced, and it is announced
   * from here because this is where the app is between two states and can say
   * which. Coming back from `blocked` is the same publish in reverse: the store
   * modules report the end of the wait as well as its start, so a person who
   * closes the other window sees the app carry on rather than a screen that has
   * to be reloaded.
   */
  async #reinstatable(
    stored: AlloSession | undefined,
    config: AlloChatClientConfig,
  ): Promise<AlloSession | undefined> {
    const recorded = await this.#dependencies.storeOwner.read();
    if (sameStoreOwner(recorded, stored === undefined ? undefined : storeOwnerOf(stored))) {
      return stored;
    }

    await this.#dependencies.storeOwner.clear();
    await this.#dependencies.eraseStore(config.store, (blocked) => {
      this.#publish({ phase: blocked ? 'blocked' : 'starting', error: undefined });
    });

    if (stored === undefined) {
      // The ordinary signed-out launch, and the tail of a sign-out. Nothing was
      // refused, so the run's sign-in attempt still describes the person here and
      // is left alone: forgetting it is what would drag somebody who has just
      // deliberately signed out straight back into a sign-in.
      return undefined;
    }

    // A usable session, refused, because the data on this device is not its own.
    // The log line names no account: a Matrix user id is not a secret, but
    // nothing is gained by writing one into a log a support ticket may carry.
    logger.warn(
      '[chat] the stored Matrix session was not reinstated: the chat data on this ' +
        'device was not written by it, so both have been erased',
    );
    await this.#forget();
    this.#dependencies.signInAttempt.forget();
    return undefined;
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
    const epoch = this.#openSessionEpoch();
    try {
      await client.restoreSession(session);
      await client.startSync();
    } catch (error) {
      this.#fail('Allo could not reopen your last session', error);
      return;
    }
    if (epoch !== this.#sessionEpoch) {
      // Let go of while it was coming up. Whatever replaced it publishes its own
      // phase; this one would only overwrite it with a session that is no longer
      // the runtime's.
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

  /** Starts keeping a session, and says which one this is. */
  #openSessionEpoch(): number {
    this.#sessionEpoch = this.#nextSessionEpoch;
    this.#nextSessionEpoch += 1;
    return this.#sessionEpoch;
  }

  /**
   * Writes a session down, unless the runtime has stopped keeping it.
   *
   * The epoch is read here and checked again *inside* the queued operation, not
   * only before queueing: a write waits behind whatever is already in the queue,
   * and a sign-out is exactly the kind of thing that can be that "whatever".
   * Asking the question once, on the way in, would ask it at the one moment the
   * answer is still the old one.
   */
  #remember(session: AlloSession): Promise<void> {
    const epoch = this.#sessionEpoch;
    return this.#sequence(async () => {
      if (epoch === undefined || epoch !== this.#sessionEpoch) {
        throw new MatrixRuntimeSupersededError('Storing a Matrix session');
      }
      await this.#dependencies.sessionStorage.write(encodeStoredSession(session));
    });
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
    // Everything still in flight for the client being let go is now stale.
    this.#sessionEpoch = undefined;

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
  storeOwner: matrixStoreOwnerStorage,
  // The same object the sign-in gate reads. It has to be: a marker forgotten in
  // one copy and read from another is a marker that does nothing.
  signInAttempt: matrixSignInAttempt,
  pushRegistration: new MatrixPushRegistrar(defaultPushRegistrationDependencies()),
  // Platform-split, because the two platforms do genuinely different things: an
  // in-app browser tab that returns control on iOS and Android, a top-level
  // redirect that destroys this page on web. See `matrixAuthorization.ts`.
  authorize,
  pendingAuthorization,
};

/** The app's runtime. Built here and nowhere else. */
export const matrixRuntime = new MatrixRuntime(defaultDependencies);
