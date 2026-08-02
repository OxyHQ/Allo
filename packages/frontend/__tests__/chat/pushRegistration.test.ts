import {
  MatrixPushRegistrar,
  type PusherRegistry,
  type PushGatewayEndpoint,
  type PushRegistrationDependencies,
} from '@/lib/chat/pushRegistration';
import type { AlloPusher, AlloPusherIdentity } from '@/lib/matrix/types';

/**
 * Registering this device with the homeserver, and withdrawing it.
 *
 * Every dependency is injected, so none of this needs a phone, a push provider,
 * Allo's backend or a homeserver. What is being protected is the sequence — the
 * device token, then the gateway URL Allo's backend mints for it, then the
 * pusher — and the two ways it is allowed to end early.
 */

const ENDPOINT: PushGatewayEndpoint = {
  url: 'https://api.allo.you/_matrix/push/v1/notify?t=a-capability-token',
  appId: 'so.oxy.allo.android',
};

class RecordingClient implements PusherRegistry {
  registered: AlloPusher | undefined;
  unregistered: AlloPusherIdentity | undefined;
  registerFails: Error | undefined;
  unregisterFails: Error | undefined;

  async registerPusher(pusher: AlloPusher): Promise<void> {
    if (this.registerFails !== undefined) throw this.registerFails;
    this.registered = pusher;
  }

  async unregisterPusher(identity: AlloPusherIdentity): Promise<void> {
    if (this.unregisterFails !== undefined) throw this.unregisterFails;
    this.unregistered = identity;
  }
}

function dependencies(
  overrides: Partial<PushRegistrationDependencies> = {},
): PushRegistrationDependencies & { mintCalls: { platform: string; pushkey: string }[] } {
  const mintCalls: { platform: string; pushkey: string }[] = [];
  return {
    mintCalls,
    platform: () => 'android',
    isEnabled: async () => true,
    deviceToken: async () => 'device-token-aaa',
    mintGateway: async (platform, pushkey) => {
      mintCalls.push({ platform, pushkey });
      return ENDPOINT;
    },
    fallbackNotification: () => ({ title: 'Allo', body: 'Nuevo mensaje' }),
    lang: () => 'es',
    appDisplayName: () => 'Allo',
    deviceDisplayName: () => 'Allo (android)',
    ...overrides,
  };
}

describe('registering for notifications', () => {
  it('mints a gateway URL for this device and hands the homeserver a pusher', async () => {
    const deps = dependencies();
    const client = new RecordingClient();

    await new MatrixPushRegistrar(deps).apply(client);

    expect(deps.mintCalls).toEqual([{ platform: 'android', pushkey: 'device-token-aaa' }]);
    expect(client.registered).toEqual({
      appId: 'so.oxy.allo.android',
      pushkey: 'device-token-aaa',
      gatewayUrl: ENDPOINT.url,
      appDisplayName: 'Allo',
      deviceDisplayName: 'Allo (android)',
      lang: 'es',
      fallbackNotification: { title: 'Allo', body: 'Nuevo mensaje' },
    });
  });

  it('carries the words the lock screen will show, in the reader\'s language', async () => {
    // The gateway has never seen the message and does not know what language to
    // write in. This is the only place either fact is known.
    const client = new RecordingClient();

    await new MatrixPushRegistrar(dependencies()).apply(client);

    expect(client.registered?.fallbackNotification.body).toBe('Nuevo mensaje');
  });

  it('does nothing at all on a platform that has no device token', async () => {
    const deps = dependencies({ platform: () => undefined });
    const client = new RecordingClient();

    await new MatrixPushRegistrar(deps).apply(client);

    // Web, and Expo Go. Not an error and not something to report: there is no
    // token to register, so the preference is not even worth reading.
    expect(deps.mintCalls).toEqual([]);
    expect(client.registered).toBeUndefined();
  });

  it('does not ask Allo\'s backend for anything when the platform has no token', async () => {
    const deps = dependencies({ deviceToken: async () => undefined });
    const client = new RecordingClient();

    await new MatrixPushRegistrar(deps).apply(client);

    expect(deps.mintCalls).toEqual([]);
    expect(client.registered).toBeUndefined();
  });

  it('survives a backend that cannot mint a URL', async () => {
    const deps = dependencies({
      mintGateway: async () => {
        throw new Error('the backend is down');
      },
    });
    const client = new RecordingClient();

    // Documented never to throw: a phone that could not be registered is a gap
    // in notifications, and a caller has nothing useful to do about it.
    const registrar = new MatrixPushRegistrar(deps);
    await expect(registrar.apply(client)).resolves.toBeUndefined();
    expect(client.registered).toBeUndefined();

    // And it must not believe it registered something. A registrar that records
    // a pusher it never created goes on to ask the homeserver to delete one that
    // is not there — a request that can only fail, logged as if something were
    // wrong, on every sign-out from then on.
    await registrar.remove(client);
    expect(client.unregistered).toBeUndefined();
  });

  it('survives a homeserver that refuses the pusher', async () => {
    const client = new RecordingClient();
    client.registerFails = new Error('the homeserver said no');

    await expect(
      new MatrixPushRegistrar(dependencies()).apply(client),
    ).resolves.toBeUndefined();
  });
});

describe('the notification preference', () => {
  it('withdraws the pusher when the switch is turned off', async () => {
    let enabled = true;
    const deps = dependencies({ isEnabled: async () => enabled });
    const registrar = new MatrixPushRegistrar(deps);
    const client = new RecordingClient();
    await registrar.apply(client);

    enabled = false;
    await registrar.apply(client);

    // What the settings switch produces. "Off" on Matrix is a pusher deleted on
    // the homeserver, because that is the only place one exists.
    expect(client.unregistered).toEqual({
      appId: 'so.oxy.allo.android',
      pushkey: 'device-token-aaa',
    });
    expect(deps.mintCalls).toHaveLength(1);
  });

  it('asks Allo\'s backend for nothing while the switch is off', async () => {
    const deps = dependencies({ isEnabled: async () => false });
    const client = new RecordingClient();

    await new MatrixPushRegistrar(deps).apply(client);

    // The device token is never read and never leaves the phone.
    expect(deps.mintCalls).toEqual([]);
    expect(client.registered).toBeUndefined();
  });

  it('registers nothing when the preference cannot even be read', async () => {
    const deps = dependencies({
      isEnabled: async () => {
        throw new Error('storage is unavailable');
      },
    });
    const client = new RecordingClient();

    await expect(new MatrixPushRegistrar(deps).apply(client)).resolves.toBeUndefined();
    expect(client.registered).toBeUndefined();
  });
});

describe('withdrawing', () => {
  it('asks the homeserver for nothing when this run registered nothing', async () => {
    const client = new RecordingClient();

    await new MatrixPushRegistrar(dependencies()).remove(client);

    // Asking a homeserver to delete a pusher it does not have is a request that
    // can only fail, and its failure would be logged as if something were wrong.
    expect(client.unregistered).toBeUndefined();
  });

  it('survives a homeserver that cannot be reached, because a sign-out must not fail', async () => {
    const registrar = new MatrixPushRegistrar(dependencies());
    const client = new RecordingClient();
    await registrar.apply(client);
    client.unregisterFails = new Error('no network');

    await expect(registrar.remove(client)).resolves.toBeUndefined();
  });

  it('keeps what it registered when the withdrawal failed, so a later attempt can retry', async () => {
    const registrar = new MatrixPushRegistrar(dependencies());
    const client = new RecordingClient();
    await registrar.apply(client);
    client.unregisterFails = new Error('no network');
    await registrar.remove(client);

    client.unregisterFails = undefined;
    await registrar.remove(client);

    expect(client.unregistered).toEqual({
      appId: 'so.oxy.allo.android',
      pushkey: 'device-token-aaa',
    });
  });
});

describe('registering again', () => {
  it('is what a relaunch does, because a device token is reissued without warning', async () => {
    const registrar = new MatrixPushRegistrar(
      dependencies({ deviceToken: async () => 'a-reissued-token' }),
    );
    const client = new RecordingClient();

    await registrar.apply(client);
    await registrar.apply(client);

    // A pusher is keyed on (app_id, pushkey), so the homeserver replaces rather
    // than accumulating. Nothing here has to deduplicate.
    expect(client.registered?.pushkey).toBe('a-reissued-token');
    expect(client.unregistered).toBeUndefined();
  });
});
