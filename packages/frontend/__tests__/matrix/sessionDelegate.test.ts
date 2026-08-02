import { SlidingSyncVersion } from '@unomed/react-native-matrix-sdk';
import type { Session } from '@unomed/react-native-matrix-sdk';

import { MatrixPortError } from '@/lib/matrix/errors';
import { NativeSessionDelegate } from '@/lib/matrix/native/session';
import type { AlloSession } from '@/lib/matrix/types';

jest.mock('@unomed/react-native-matrix-sdk');

/**
 * The binding's only way of telling the app that the session has changed.
 *
 * It is not shaped like an observer — it is a delegate handed to the builder
 * before the client exists — and everything asserted here is about turning that
 * into something the app can subscribe to without letting the SDK's constraints
 * leak: the callbacks are synchronous, they come from Rust's thread, and one of
 * them is on the path a token refresh takes.
 */

const SESSION: Session = {
  userId: '@alice:allo.you',
  deviceId: 'DEVICE1',
  homeserverUrl: 'https://matrix.allo.you',
  accessToken: 'secret-access-token',
  refreshToken: 'secret-refresh-token',
  oidcData: '{"issuer":"https://account.allo.you/"}',
  slidingSyncVersion: SlidingSyncVersion.Native,
};

const REFRESHED: Session = {
  ...SESSION,
  accessToken: 'secret-access-token-2',
  refreshToken: 'secret-refresh-token-2',
};

/** A client that answers with one session, as the binding's would. */
function reader(session: Session = SESSION): { session(): Session } {
  return { session: () => session };
}

describe('NativeSessionDelegate observing', () => {
  it('reports a saved session to every listener, translated', () => {
    const delegate = new NativeSessionDelegate();
    const seen: AlloSession[] = [];
    delegate.observe((session) => seen.push(session));
    delegate.observe((session) => seen.push(session));

    delegate.saveSessionInKeychain(REFRESHED);

    // Translated, not the SDK's record: `oidcData` has become the port's opaque
    // `authData` and `slidingSyncVersion` has been left behind, because it is a
    // property of how this client was built and not of the session.
    expect(seen).toEqual([
      {
        userId: '@alice:allo.you',
        deviceId: 'DEVICE1',
        homeserverUrl: 'https://matrix.allo.you',
        accessToken: 'secret-access-token-2',
        refreshToken: 'secret-refresh-token-2',
        authData: '{"issuer":"https://account.allo.you/"}',
      },
      expect.anything(),
    ]);
    expect(seen).toHaveLength(2);
  });

  it('stops reporting to a listener that has unsubscribed', () => {
    const delegate = new NativeSessionDelegate();
    let calls = 0;
    const unsubscribe = delegate.observe(() => {
      calls += 1;
    });

    unsubscribe();
    delegate.saveSessionInKeychain(REFRESHED);

    expect(calls).toBe(0);
  });

  it('reports nothing until the SDK saves something', () => {
    // Changes only. The session a login produced is that call's own result, and
    // replaying it here would make a subscriber unable to tell a rotation from
    // its own sign-in.
    const delegate = new NativeSessionDelegate();
    let calls = 0;

    delegate.observe(() => {
      calls += 1;
    });

    expect(calls).toBe(0);
  });

  it('carries on when a listener throws', () => {
    // This is the SDK's token refresh path, called synchronously from Rust. A
    // listener that failed must not become a refresh that failed, and must not
    // stop the listener queued behind it.
    const delegate = new NativeSessionDelegate();
    const seen: string[] = [];
    delegate.observe(() => {
      throw new Error('the keychain refused');
    });
    delegate.observe((session) => seen.push(session.accessToken));

    expect(() => delegate.saveSessionInKeychain(REFRESHED)).not.toThrow();
    expect(seen).toEqual(['secret-access-token-2']);
  });
});

describe('NativeSessionDelegate answering the SDK', () => {
  it('answers with the session the client is holding', () => {
    // Read from the client rather than from storage, which is not what the SDK's
    // name for it suggests: a copy out of the keychain could be older than what
    // the client already has.
    const delegate = new NativeSessionDelegate();
    delegate.bind(reader());

    expect(delegate.retrieveSessionFromKeychain('@alice:allo.you')).toEqual(SESSION);
  });

  it('refuses before it has a client to read', () => {
    const delegate = new NativeSessionDelegate();

    expect(() => delegate.retrieveSessionFromKeychain('@alice:allo.you')).toThrow(
      MatrixPortError,
    );
  });

  it('refuses to answer for a user this client is not', () => {
    // A client holds one user's session. Being asked for another one means the
    // SDK and this delegate disagree about which client this is, and answering
    // anyway would hand the SDK the wrong credentials.
    const delegate = new NativeSessionDelegate();
    delegate.bind(reader());

    expect(() => delegate.retrieveSessionFromKeychain('@bob:allo.you')).toThrow(
      /@bob:allo\.you/,
    );
  });

  it('follows the client rather than remembering an answer', () => {
    // The client is the authority on its own session, so a rotation the delegate
    // was never told about is still answered correctly.
    let current = SESSION;
    const delegate = new NativeSessionDelegate();
    delegate.bind({ session: () => current });

    current = REFRESHED;

    expect(delegate.retrieveSessionFromKeychain('@alice:allo.you')).toEqual(REFRESHED);
  });
});
