/**
 * The Socket.IO connection to the `/v1` namespace. The handshake `auth` is
 * recomputed on every (re)connect because the request signature carries a
 * timestamp; socket.io-client accepts `auth` as a function for exactly that.
 * Tests inject a `SocketFactory` returning a fake.
 */
import { EMPTY_BODY_SHA256_HEX, SOCKET_NAMESPACE, SOCKET_SIGNING_PATH } from "@allo/shared-types";
import { io } from "socket.io-client";
import type { SocketAuthPayload, SocketFactory, SocketLike } from "../types";
import { signRequest, type SigningKeyPair } from "../crypto/signing";

export const defaultSocketFactory: SocketFactory = (url, auth) => {
  const socket = io(url, {
    autoConnect: false,
    // WebSocket only, no polling and no upgrade dance. The API runs on several
    // ECS tasks behind one ALB with no sticky sessions; Socket.IO's polling
    // transport binds a `sid` to the task that answered the handshake, so the
    // next poll landing on the other task is answered 400 "Session ID
    // unknown" and the client loops. Measured on allo.you on 2026-09-18. A
    // single WebSocket connection stays on one task by construction.
    transports: ["websocket"],
    upgrade: false,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 60_000,
    randomizationFactor: 0.5,
    auth: (cb) => {
      auth().then(
        (payload) => cb(payload as unknown as Record<string, unknown>),
        () => cb({}),
      );
    },
  });
  return socket as unknown as SocketLike;
};

export function socketUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + SOCKET_NAMESPACE;
}

export function buildSocketAuth(input: { token: string; instanceId: string; key: SigningKeyPair; now: number }): SocketAuthPayload {
  const timestamp = Math.floor(input.now);
  return {
    token: input.token,
    instanceId: input.instanceId,
    timestamp,
    signature: signRequest(input.key, { method: "GET", pathWithQuery: SOCKET_SIGNING_PATH, timestampMs: timestamp, bodySha256Hex: EMPTY_BODY_SHA256_HEX }),
  };
}
