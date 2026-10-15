import { MessagingDelivery } from './messagingDelivery';
import {
  conversationParticipants,
  requireMessageAccess,
} from '../services/platform/messagingPolicy';
/**
 * The Socket.IO server on namespace `/v1` (`SOCKET_NAMESPACE`).
 *
 * Auth is two middlewares in order: `oxy.middleware.socket()` (the Oxy bearer, sets
 * `socket.data.userId`), then the instance signature over `handshake.auth`
 * (`socketAuthSchema`) with the path fixed to `SOCKET_SIGNING_PATH` and an
 * empty body — the same check `requireInstance` makes, through the same
 * function, with ONE difference: a `pending` instance is admitted, because
 * `instance.approved` is delivered to its room and socket.io-client never
 * reconnects after a refused handshake. A connected socket joins
 * `instance:<id>` and `account:<accountId>`; rooms are derived from the
 * verified instance, never from client input.
 *
 * Inbound `typing` is relayed to the other ACTIVE leaves of the conversation
 * and stored nowhere.
 *
 * Presence is a `PresenceHub` (`presenceHub.ts`): a connected instance beats,
 * a client says which accounts it is SHOWING, and it hears about those and
 * nothing else. The old shape — announce to every account sharing any
 * conversation, on connect and on the last disconnect — is gone; it told
 * screens about accounts they were not drawing and made an online dot cheap
 * to scrape.
 */

import type http from 'node:http';
import { Server as SocketIOServer, type Namespace, type Socket } from 'socket.io';
import {
  EMPTY_BODY_SHA256_HEX,
  SOCKET_NAMESPACE,
  SOCKET_SIGNING_PATH,
  socketAuthSchema,
  typingEventSchema,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@allo/shared-types';
import { findActiveLeaf, listLeaves } from '../db/platform/conversationRepository';
import {
  authenticateInstance,
  type AuthenticatedInstance,
  type InstanceAuthDeps,
} from '../middleware/instanceAuth';
import { logger } from '../utils/logger';
import { APP_ORIGINS } from '../app';
import { PresenceHub } from './presenceHub';
import type { Realtime } from './realtime';

export interface SocketAuthProvider {
  readonly middleware: {
    socket(options?: {
      supervisedAction?: 'messaging';
    }): (socket: unknown, next: (err?: Error) => void) => Promise<void>;
  };
}

interface SocketData {
  userId?: string;
  instance?: AuthenticatedInstance;
}

type V1Socket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type V1Namespace = Namespace<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export const instanceRoom = (instanceId: string) => `instance:${instanceId}`;
export const accountRoom = (accountId: string) => `account:${accountId}`;

/** Where `oxy.middleware.socket()` leaves the account id. */
function oxyUserIdOf(socket: V1Socket): string | null {
  const user = Reflect.get(socket, 'user') as { id?: unknown } | undefined;
  if (typeof user?.id === 'string' && user.id) return user.id;
  const fromData = socket.data.userId;
  return typeof fromData === 'string' && fromData ? fromData : null;
}

export interface SocketServerDeps {
  oxy: SocketAuthProvider;
  instanceAuth?: InstanceAuthDeps;
  /** Origins beside the Oxy apex family; defaults to `APP_ORIGINS`. */
  appOrigins?: readonly string[];
}

export interface SocketRuntime {
  io: SocketIOServer;
  namespace: V1Namespace;
  realtime: Realtime;
  presence: PresenceHub;
}

export function createSocketServer(server: http.Server, deps: SocketServerDeps): SocketRuntime {
  const origins = new Set(deps.appOrigins ?? APP_ORIGINS);
  const io = new SocketIOServer(server, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 64 * 1024,
    cors: {
      origin: (origin, callback) => {
        callback(
          null,
          !origin || origins.has(origin) || /^https:\/\/([a-z0-9-]+\.)*oxy\.so$/i.test(origin),
        );
      },
      credentials: true,
    },
  });

  const namespace: V1Namespace = io.of(SOCKET_NAMESPACE);
  const oxyAuth = deps.oxy.middleware.socket({ supervisedAction: 'messaging' });
  namespace.use((socket, next) => {
    void oxyAuth(socket, next);
  });
  namespace.use((socket, next) => {
    void (async () => {
      const accountId = oxyUserIdOf(socket);
      if (!accountId) throw new Error('unauthorized');
      const auth = socketAuthSchema.safeParse(socket.handshake.auth);
      if (!auth.success) throw new Error('unauthorized');
      socket.data.instance = await authenticateInstance(
        {
          accountId,
          instanceId: auth.data.instanceId,
          timestamp: auth.data.timestamp,
          signature: auth.data.signature,
          method: 'GET',
          pathWithQuery: SOCKET_SIGNING_PATH,
          bodySha256Hex: EMPTY_BODY_SHA256_HEX,
          // A pending instance is admitted so it can hear `instance.approved`;
          // it holds no leaf, so typing relays nothing for it, and it is not
          // announced as present. A revoked one is still refused.
          allowPending: true,
        },
        deps.instanceAuth,
      );
    })().then(
      () => next(),
      (error: unknown) => {
        // The code, never the reason: a handshake error reaches the client.
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'unauthorized';
        next(new Error(code));
      },
    );
  });

  const delivery = new MessagingDelivery((rooms) => namespace.in(rooms).fetchSockets());
  const realtime: Realtime = {
    nudge(instanceIds, event) {
      delivery.enqueue('sync.nudge', event, instanceIds.map(instanceRoom));
    },
    instanceApproved(instanceId, event) {
      delivery.enqueue('instance.approved', event, [instanceRoom(instanceId)]);
    },
    instanceRevoked(accountId, event) {
      delivery.enqueue('instance.revoked', event, [accountRoom(accountId)]);
    },
    keyPackagesLow(instanceId, event) {
      delivery.enqueue('keypackages.low', event, [instanceRoom(instanceId)]);
    },
    historyOffer(instanceId, event) {
      delivery.enqueue('history.offer', event, [instanceRoom(instanceId)]);
    },
    statusPosted(instanceId, event) {
      delivery.enqueue('status.posted', event, [instanceRoom(instanceId)]);
    },
    callIncoming(instanceId, event) {
      delivery.enqueue('call.incoming', event, [instanceRoom(instanceId)]);
    },
    callUpdated(instanceId, event) {
      delivery.enqueue('call.updated', event, [instanceRoom(instanceId)]);
    },
    typing(instanceIds, event) {
      delivery.enqueue('typing', event, instanceIds.map(instanceRoom));
    },
    async isInstanceConnected(instanceId) {
      const sockets = await namespace.in(instanceRoom(instanceId)).fetchSockets();
      return sockets.length > 0;
    },
    async disconnectInstance(instanceId) {
      namespace.in(instanceRoom(instanceId)).disconnectSockets(true);
    },
  };

  const presence = new PresenceHub();
  presence.start();

  namespace.on('connection', (socket) => {
    const instance = socket.data.instance;
    if (!instance) {
      socket.disconnect(true);
      return;
    }
    const accessToken = socket.handshake.auth.token;
    if (typeof accessToken !== 'string') {
      socket.disconnect(true);
      return;
    }
    const requester = { accountId: instance.accountId, accessToken };
    const alive = () =>
      requireMessageAccess(requester, `socket:${socket.id}`, [instance.accountId]);
    void socket.join([instanceRoom(instance.id), accountRoom(instance.accountId)]);
    void presence
      .attach(socket, instance, accessToken)
      .catch((error: unknown) => logger.debug('presence attach failed', error));

    socket.on('typing', (payload) => {
      void relayTyping(instance, payload, realtime, accessToken).catch((error: unknown) => {
        socket.disconnect(true);
        logger.debug('typing relay failed', error);
      });
    });

    socket.on('presence.watch', (payload) => {
      void alive()
        .then(() => presence.watch(socket, payload))
        .catch(() => socket.disconnect(true));
    });

    socket.on('presence.heartbeat', () => {
      void alive()
        .then(() => presence.heartbeat(instance))
        .catch(() => socket.disconnect(true));
    });

    socket.on('disconnect', () => {
      void presence
        .detach(socket, instance)
        .catch((error: unknown) => logger.debug('presence detach failed', error));
    });
  });

  return { io, namespace, realtime, presence };
}

/** Verify the sender holds an active leaf, then re-emit to the other active leaves. Never stored. */
export async function relayTyping(
  sender: AuthenticatedInstance,
  payload: unknown,
  realtime: Realtime,
  accessToken: string,
): Promise<void> {
  const parsed = typingEventSchema.safeParse(payload);
  if (!parsed.success) return;
  const mine = await findActiveLeaf(parsed.data.conversationId, sender.id);
  if (!mine) return;
  const participants =
    (await conversationParticipants([parsed.data.conversationId])).get(
      parsed.data.conversationId,
    ) ?? [];
  await requireMessageAccess(
    { accountId: sender.accountId, accessToken },
    parsed.data.conversationId,
    participants,
  );
  const others = (await listLeaves(parsed.data.conversationId))
    .filter((leaf) => leaf.state === 'active' && leaf.instanceId !== sender.id)
    .map((leaf) => leaf.instanceId);
  realtime.typing(others, parsed.data);
}
