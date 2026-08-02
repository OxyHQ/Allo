import Constants from 'expo-constants';
import i18next, { t } from 'i18next';
import { Platform } from 'react-native';

import type {
  AlloPusher,
  AlloPusherFallbackNotification,
  AlloPusherIdentity,
} from '@/lib/matrix/types';
import { api } from '@/utils/api';
import { getDevicePushToken } from '@/utils/notifications';
import { getData } from '@/utils/storage';
import { logger } from '@/utils/logger';

/**
 * Telling the homeserver to notify this phone, and telling it to stop.
 *
 * ## Where the pieces live
 *
 * Three parties, and none of them is Allo's message backend:
 *
 * 1. **The operating system** issues a device token — APNs on iOS, FCM on
 *    Android. It is reissued without warning, which is why registration happens
 *    on every launch rather than once.
 * 2. **Allo's backend** mints the URL that token's notifications should be sent
 *    to. It is per device and carries a capability bound to the token, so that
 *    the gateway is not an open relay; it stores nothing.
 * 3. **The homeserver** keeps the pusher and does the deciding. Allo has no
 *    table of device tokens at all any more — see `docs/matrix/push.md`.
 *
 * ## Why this is not a hook
 *
 * Registering a pusher is synchronisation with an external system, which is the
 * one thing an Effect is genuinely for — but the system is the *homeserver*, and
 * the lifetime it belongs to is the session's, not a screen's. An Effect would
 * tie it to whichever component mounted first: unmount that screen and the
 * registration would be undone, remount it and a second one would run, and under
 * StrictMode both happen on the first render anyway. So it is owned by
 * `matrixRuntime.ts` alongside the client itself and runs on a transition — a
 * session becoming ready, a preference being changed — and never on a render.
 *
 * ## Why it is safe to run on every launch
 *
 * A pusher is identified by `(app_id, pushkey)`, so registering the same pair
 * again replaces the record instead of adding one. Idempotence is a property of
 * the protocol here, not something this file has to arrange.
 */

/** What Allo's backend answers when asked where this device's notifications go. */
export interface PushGatewayEndpoint {
  readonly url: string;
  readonly appId: string;
}

/** The platforms that have a device push token. Web has none; see {@link pushCapablePlatform}. */
export type PushCapablePlatform = 'ios' | 'android';

/**
 * The part of the port a pusher needs.
 *
 * Named separately from `AlloChatClient`, which satisfies it structurally, for
 * the same reason `MatrixRuntimeLike` exists: it is the whole of what this file
 * touches, so a test can stand in for it without building a client — and a
 * reader can see at a glance that registering a pusher reaches nothing else.
 */
export interface PusherRegistry {
  registerPusher(pusher: AlloPusher): Promise<void>;
  unregisterPusher(identity: AlloPusherIdentity): Promise<void>;
}

export interface MatrixPushRegistration {
  /**
   * Brings the homeserver in line with what the user has asked for: a pusher if
   * they want notifications and this build can produce one, and no pusher
   * otherwise.
   *
   * Never throws. A pusher that could not be registered is a gap in
   * notifications, not a broken session, and a caller that had to handle it
   * would have nothing useful to do about it.
   */
  apply(client: PusherRegistry): Promise<void>;
  /**
   * Removes the pusher this run registered, if it registered one.
   *
   * Called before signing out, while the access token that the call needs still
   * works. Never throws, for the same reason: a sign-out must not fail because
   * the homeserver could not be reached.
   */
  remove(client: PusherRegistry): Promise<void>;
}

/** Everything the registrar does that is not its own logic, injected for tests. */
export interface PushRegistrationDependencies {
  /** The platform's device token, or `undefined` when this build has none. */
  readonly deviceToken: () => Promise<string | undefined>;
  /** Whether the user wants notifications on this device. */
  readonly isEnabled: () => Promise<boolean>;
  /** Asks Allo's backend where this device's notifications should be sent. */
  readonly mintGateway: (
    platform: PushCapablePlatform,
    pushkey: string,
  ) => Promise<PushGatewayEndpoint>;
  /** The words the lock screen shows, in the reader's language. */
  readonly fallbackNotification: () => AlloPusherFallbackNotification;
  /** The reader's language, as a BCP-47 tag. */
  readonly lang: () => string;
  readonly appDisplayName: () => string;
  readonly deviceDisplayName: () => string;
  /** `undefined` on a platform or a build that cannot receive a push at all. */
  readonly platform: () => PushCapablePlatform | undefined;
}

export class MatrixPushRegistrar implements MatrixPushRegistration {
  readonly #dependencies: PushRegistrationDependencies;

  /**
   * What was registered, so it can be withdrawn.
   *
   * In memory and not persisted, deliberately. The only caller that needs it is
   * a sign-out or a toggle in the same run as the registration, and a pusher
   * left behind by a run that ended some other way does not linger: Synapse
   * deletes a device's pushers along with the access token that created them,
   * and a token that outlives its device is reported dead by the provider and
   * ends up in the gateway's `rejected` list. Persisting it would be a second
   * record of something the homeserver already holds — the exact mistake this
   * whole change exists to undo.
   */
  #registered: AlloPusherIdentity | undefined;

  constructor(dependencies: PushRegistrationDependencies) {
    this.#dependencies = dependencies;
  }

  async apply(client: PusherRegistry): Promise<void> {
    const platform = this.#dependencies.platform();
    if (platform === undefined) {
      return;
    }

    let enabled: boolean;
    try {
      enabled = await this.#dependencies.isEnabled();
    } catch (error) {
      logger.warn('[chat] the notification preference could not be read', error);
      return;
    }

    if (!enabled) {
      await this.remove(client);
      return;
    }

    try {
      const pushkey = await this.#dependencies.deviceToken();
      if (pushkey === undefined) {
        // No token: permission was refused, or this is a build that cannot get
        // one. Not an error, and not something to retry.
        return;
      }

      const endpoint = await this.#dependencies.mintGateway(platform, pushkey);
      await client.registerPusher({
        appId: endpoint.appId,
        pushkey,
        gatewayUrl: endpoint.url,
        appDisplayName: this.#dependencies.appDisplayName(),
        deviceDisplayName: this.#dependencies.deviceDisplayName(),
        lang: this.#dependencies.lang(),
        fallbackNotification: this.#dependencies.fallbackNotification(),
      });
      // Recorded only after the homeserver has taken it, so that `remove` never
      // asks it to delete something it does not have.
      this.#registered = { appId: endpoint.appId, pushkey };
    } catch (error) {
      // Neither the token nor the URL is ever in the message: one addresses a
      // phone and the other is the capability over it.
      logger.warn('[chat] this device could not register for notifications', error);
    }
  }

  async remove(client: PusherRegistry): Promise<void> {
    const registered = this.#registered;
    if (registered === undefined) {
      return;
    }
    try {
      await client.unregisterPusher(registered);
      this.#registered = undefined;
    } catch (error) {
      logger.warn('[chat] this device could not stop its notifications', error);
    }
  }
}

/**
 * Where the answer to "do you want notifications on this phone" is kept.
 *
 * Per **device**, not per account, and that is a correction rather than a
 * simplification. There is one device token on this phone and therefore one
 * pusher at a time; a preference stored per Oxy account could say yes for one
 * account and no for another while the phone can only be in one of those two
 * states. It also had a concrete bug: the settings screen wrote the key under the
 * Oxy user id and nothing that reads it downstream knows that id.
 *
 * The keys written by older builds are not read. The cost is a user who had
 * turned notifications off getting them back once, which is the safe direction to
 * be wrong in for a messenger, and one they can undo in the same screen.
 */
export const NOTIFICATION_PREFERENCE_KEY = 'pref:notificationsEnabled';

/**
 * The preference, with "never answered" meaning yes.
 *
 * A messenger that has to be switched on before it will tell you about a message
 * is one whose first missed message is nobody's fault but ours. Turning it off is
 * a decision the user makes; leaving it on is not a decision at all.
 */
export async function isPushEnabled(): Promise<boolean> {
  return (await getData<boolean>(NOTIFICATION_PREFERENCE_KEY)) !== false;
}

/**
 * Which platform this build can receive a push on.
 *
 * `undefined` on web, which has no APNs or FCM token; and `undefined` in Expo Go,
 * which has had no remote push since SDK 53 — a development build is required,
 * and pretending otherwise produces an error at the first call instead of a clear
 * skip here.
 */
export function pushCapablePlatform(): PushCapablePlatform | undefined {
  if (Platform.OS === 'ios') return Constants.appOwnership === 'expo' ? undefined : 'ios';
  if (Platform.OS === 'android') return Constants.appOwnership === 'expo' ? undefined : 'android';
  return undefined;
}

const APP_NAME = 'Allo';

/** Asks Allo's backend for this device's gateway URL. Nothing is stored there. */
async function mintGateway(
  platform: PushCapablePlatform,
  pushkey: string,
): Promise<PushGatewayEndpoint> {
  const { data } = await api.post<PushGatewayEndpoint>('/push/gateway', { platform, pushkey });
  if (typeof data?.url !== 'string' || typeof data?.appId !== 'string') {
    throw new Error('Allo\'s backend did not answer with a push gateway URL');
  }
  return { url: data.url, appId: data.appId };
}

/** How the registrar reaches the world when it is not under test. */
export function defaultPushRegistrationDependencies(): PushRegistrationDependencies {
  return {
    platform: pushCapablePlatform,
    isEnabled: isPushEnabled,
    deviceToken: async () => (await getDevicePushToken())?.token,
    mintGateway,
    fallbackNotification: () => ({
      title: t('notification.push.title'),
      body: t('notification.push.body'),
    }),
    lang: () => i18next.language,
    appDisplayName: () => APP_NAME,
    deviceDisplayName: () => `${APP_NAME} (${Platform.OS})`,
  };
}
