/**
 * The Socket.IO server on namespace `/v1` (`SOCKET_NAMESPACE`).
 *
 * Auth is two middlewares in order: `oxy.authSocket()` (the Oxy bearer, sets
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
 * and stored nowhere. Presence is best effort: on connect and disconnect the
 * accounts sharing a conversation with this one hear `presence`.
 */

import type http from "node:http";
import { Server as SocketIOServer, type Namespace, type Socket } from "socket.io";
import {
  EMPTY_BODY_SHA256_HEX,
  SOCKET_NAMESPACE,
  SOCKET_SIGNING_PATH,
  socketAuthSchema,
  typingEventSchema,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@allo/shared-types";
import { findActiveLeaf, listAccountsSharingConversations, listLeaves } from "../db/platform/conversationRepository";
import { authenticateInstance, type AuthenticatedInstance, type InstanceAuthDeps } from "../middleware/instanceAuth";
import { logger } from "../utils/logger";
import { APP_ORIGINS } from "../app";
import type { Realtime } from "./realtime";

export interface SocketAuthProvider {
  authSocket(): (socket: unknown, next: (err?: Error) => void) => Promise<void>;
}

interface SocketData {
  userId?: string;
  instance?: AuthenticatedInstance;
}

type V1Socket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type V1Namespace = Namespace<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export const instanceRoom = (instanceId: string) => `instance:${instanceId}`;
export const accountRoom = (accountId: string) => `account:${accountId}`;

/** Where `oxy.authSocket()` leaves the account id. */
function oxyUserIdOf(socket: V1Socket): string | null {
  const fromData = socket.data.userId;
  if (typeof fromData === "string" && fromData) return fromData;
  const user = Reflect.get(socket, "user") as { id?: unknown } | undefined;
  return typeof user?.id === "string" && user.id ? user.id : null;
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
}

export function createSocketServer(server: http.Server, deps: SocketServerDeps): SocketRuntime {
  const origins = new Set(deps.appOrigins ?? APP_ORIGINS);
  const io = new SocketIOServer(server, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    maxHttpBufferSize: 64 * 1024,
    cors: {
      origin: (origin, callback) => {
        callback(null, !origin || origins.has(origin) || /^https:\/\/([a-z0-9-]+\.)*oxy\.so$/i.test(origin));
      },
      credentials: true,
    },
  });

  const namespace: V1Namespace = io.of(SOCKET_NAMESPACE);
  const oxyAuth = deps.oxy.authSocket();
  namespace.use((socket, next) => {
    void oxyAuth(socket, next);
  });
  namespace.use((socket, next) => {
    void (async () => {
      const accountId = oxyUserIdOf(socket);
      if (!accountId) throw new Error("unauthorized");
      const auth = socketAuthSchema.safeParse(socket.handshake.auth);
      if (!auth.success) throw new Error("unauthorized");
      socket.data.instance = await authenticateInstance(
        {
          accountId,
          instanceId: auth.data.instanceId,
          timestamp: auth.data.timestamp,
          signature: auth.data.signature,
          method: "GET",
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
        const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unauthorized";
        next(new Error(code));
      },
    );
  });

  const realtime: Realtime = {
    nudge(instanceIds, event) {
      for (const id of instanceIds) namespace.to(instanceRoom(id)).emit("sync.nudge", event);
    },
    instanceApproved(instanceId, event) {
      namespace.to(instanceRoom(instanceId)).emit("instance.approved", event);
    },
    instanceRevoked(accountId, event) {
      namespace.to(accountRoom(accountId)).emit("instance.revoked", event);
    },
    keyPackagesLow(instanceId, event) {
      namespace.to(instanceRoom(instanceId)).emit("keypackages.low", event);
    },
    historyOffer(instanceId, event) {
      namespace.to(instanceRoom(instanceId)).emit("history.offer", event);
    },
    typing(instanceIds, event) {
      for (const id of instanceIds) namespace.to(instanceRoom(id)).emit("typing", event);
    },
    presence(accountIds, event) {
      for (const id of accountIds) namespace.to(accountRoom(id)).emit("presence", event);
    },
    async isInstanceConnected(instanceId) {
      const sockets = await namespace.in(instanceRoom(instanceId)).fetchSockets();
      return sockets.length > 0;
    },
    async disconnectInstance(instanceId) {
      namespace.in(instanceRoom(instanceId)).disconnectSockets(true);
    },
  };

  namespace.on("connection", (socket) => {
    const instance = socket.data.instance;
    if (!instance) {
      socket.disconnect(true);
      return;
    }
    void socket.join([instanceRoom(instance.id), accountRoom(instance.accountId)]);
    if (instance.status === "active") void announcePresence(instance.accountId, true, realtime);

    socket.on("typing", (payload) => {
      void relayTyping(instance, payload, realtime).catch((error: unknown) => {
        logger.debug("typing relay failed", error);
      });
    });

    socket.on("disconnect", () => {
      void (async () => {
        const remaining = await namespace.in(accountRoom(instance.accountId)).fetchSockets();
        if (remaining.length === 0) await announcePresence(instance.accountId, false, realtime);
      })().catch(() => undefined);
    });
  });

  return { io, namespace, realtime };
}

/** Verify the sender holds an active leaf, then re-emit to the other active leaves. Never stored. */
export async function relayTyping(sender: AuthenticatedInstance, payload: unknown, realtime: Realtime): Promise<void> {
  const parsed = typingEventSchema.safeParse(payload);
  if (!parsed.success) return;
  const mine = await findActiveLeaf(parsed.data.conversationId, sender.id);
  if (!mine) return;
  const others = (await listLeaves(parsed.data.conversationId))
    .filter((leaf) => leaf.state === "active" && leaf.instanceId !== sender.id)
    .map((leaf) => leaf.instanceId);
  realtime.typing(others, parsed.data);
}

async function announcePresence(accountId: string, online: boolean, realtime: Realtime): Promise<void> {
  try {
    const audience = await listAccountsSharingConversations(accountId);
    realtime.presence(audience, { accountId, online });
  } catch (error: unknown) {
    logger.debug("presence announcement failed", error);
  }
}
