// --- Imports ---
import express from "express";
import http from "http";
import { connectToDatabase } from "./src/utils/database";
import { Server as SocketIOServer, Socket } from "socket.io";
import dotenv from "dotenv";
import { oxyClient } from "@oxyhq/core";

// Routers
import profileSettingsRoutes from "./src/routes/profileSettings";
import conversationsRoutes from "./src/routes/conversations";
import messagesRoutes from "./src/routes/messages";
import devicesRoutes from "./src/routes/devices";
import statusRoutes from "./src/routes/status";
import callsRoutes from "./src/routes/calls";
import presenceRoutes from "./src/routes/presence";
import bridgeRoutes from "./src/routes/bridge";
import internalBridgeRouter from "./src/routes/internalBridge";

// Utils
import { registerCallSignaling } from "./src/utils/callSignaling";
import { registerP2PSignaling } from "./src/utils/p2pSignaling";
import Device from "./src/models/Device";
import Conversation from "./src/models/Conversation";
import UserSettings from "./src/models/UserSettings";
import { verifyDeviceHandshake } from "./src/utils/deviceHandshake";
import { DEVICE_LAST_SEEN_THROTTLE_MS } from "./src/config/multiDevice";
import { UPLOAD_DIR } from "./src/config/uploads";
import { logger } from "./src/utils/logger";
import {
  presenceRegistry,
  buildPresencePayload,
  computeAudience,
  resolveHiddenUserIds,
  MAX_PRESENCE_AUDIENCE,
} from "./src/utils/presence";

// Middleware
import { rateLimiter, bruteForceProtection } from "./src/middleware/security";
import type { AuthRequest } from "./src/middleware/auth";
import { bridgeAuth, captureRawBody } from "./src/middleware/bridgeAuth";
import { isBridgeEnabled } from "./src/config/bridge";
import { startOutboxSweeper } from "./src/services/BridgeService";

// Typed global handle for the Socket.IO server. Routes and utilities read
// `global.io` to fan out events without importing this module (which would
// create an import cycle). Declaring it here gives every consumer a real type
// instead of an `as any` cast.
declare global {
  // eslint-disable-next-line no-var
  var io: SocketIOServer | undefined;
}

// --- Config ---
dotenv.config();

const app = express();

// Initialize Oxy client for authentication
export const oxy = oxyClient;

// --- Interop bridge raw-body capture (F3.0, flag-gated) ---
// The internal bridge route authenticates by HMAC over the EXACT request bytes,
// so its body must be captured BEFORE the global `express.json()` consumes it.
// We mount a path-scoped json parser with a `verify` hook for `/internal/bridge`
// here; the global parser below then no-ops for that path (body already parsed).
// The router itself (with `bridgeAuth`) is mounted later, after DB-connect.
if (isBridgeEnabled()) {
  app.use("/internal/bridge", express.json({ verify: captureRawBody }));
}

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection middleware
app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (error) {
    logger.error("MongoDB connection unavailable", error);
    if (res.headersSent) {
      return;
    }
    res.status(503).json({ message: "Database temporarily unavailable" });
  }
});

// CORS and security headers
app.use((req, res, next) => {
  const allowedOrigins = [
    process.env.FRONTEND_URL || "https://allo.earth",
    "http://localhost:8081",
    "http://localhost:8082",
    "http://192.168.86.44:8081",
  ];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_URL || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// --- Sockets ---
const server = http.createServer(app);

interface AuthenticatedSocket extends Socket {
  user?: { id: string; [key: string]: unknown };
  /** Resolved Signal device id for this connection (set at handshake). */
  signalDeviceId?: number;
  /**
   * Users who share a conversation with this socket's user — the audience a
   * presence change fans out to. Resolved once per connection and cached so the
   * disconnect handler can emit "offline" without re-querying. Undefined until
   * the async resolution completes (a very short-lived connection may disconnect
   * before it does, in which case no offline event is emitted).
   */
  presenceAudience?: string[];
  /**
   * This user's resolved presence privacy: false when they have opted out
   * (`privacy.showOnlineStatus === false`), in which case no presence events are
   * emitted for them. Defaults to true (visible) when unset.
   */
  presenceShowOnline?: boolean;
}

type DisconnectReason =
  | "server disconnect"
  | "client disconnect"
  | "transport close"
  | "transport error"
  | "ping timeout"
  | "parse error"
  | "forced close"
  | "forced server close"
  | "server shutting down"
  | "client namespace disconnect"
  | "server namespace disconnect"
  | "unknown transport";

const SOCKET_CONFIG = {
  PING_TIMEOUT: 60000,
  PING_INTERVAL: 25000,
  UPGRADE_TIMEOUT: 30000,
  CONNECT_TIMEOUT: 45000,
  MAX_BUFFER_SIZE: 1e8,
  COMPRESSION_THRESHOLD: 1024,
  CHUNK_SIZE: 10 * 1024,
  WINDOW_BITS: 14,
  COMPRESSION_LEVEL: 6,
} as const;

const io = new SocketIOServer(server, {
  transports: ["websocket", "polling"],
  path: "/socket.io",
  pingTimeout: SOCKET_CONFIG.PING_TIMEOUT,
  pingInterval: SOCKET_CONFIG.PING_INTERVAL,
  upgradeTimeout: SOCKET_CONFIG.UPGRADE_TIMEOUT,
  maxHttpBufferSize: SOCKET_CONFIG.MAX_BUFFER_SIZE,
  connectTimeout: SOCKET_CONFIG.CONNECT_TIMEOUT,
  cors: {
    origin: [
      process.env.FRONTEND_URL || "https://allo.earth",
      "http://localhost:8081",
      "http://localhost:8082",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-CSRF-Token",
      "X-Requested-With",
      "Accept",
      "Accept-Version",
      "Content-Length",
      "Content-MD5",
      "Date",
      "X-Api-Version",
    ],
  },
  perMessageDeflate: {
    threshold: SOCKET_CONFIG.COMPRESSION_THRESHOLD,
    zlibInflateOptions: {
      chunkSize: SOCKET_CONFIG.CHUNK_SIZE,
      windowBits: SOCKET_CONFIG.WINDOW_BITS,
    },
    zlibDeflateOptions: {
      chunkSize: SOCKET_CONFIG.CHUNK_SIZE,
      windowBits: SOCKET_CONFIG.WINDOW_BITS,
      level: SOCKET_CONFIG.COMPRESSION_LEVEL,
    },
  },
});

// Messaging namespace for real-time chat
const messagingNamespace = io.of("/messaging");

// --- Socket Auth Middleware ---
// Verifies the Oxy access token from the handshake (socket.handshake.auth.token).
// On success, oxy.authSocket() attaches socket.user = { id, userId, sessionId }.
const socketAuthDebug = process.env.NODE_ENV !== "production";
io.use(oxy.authSocket({ debug: socketAuthDebug }));
messagingNamespace.use(oxy.authSocket({ debug: socketAuthDebug }));

/**
 * Device-handshake hardening for the messaging namespace.
 *
 * A client that claims a Signal device id in its handshake (`auth.deviceId`)
 * MUST present one that is registered to the authenticated user. A claimed but
 * unregistered/revoked device is rejected with `unregistered_device` so a
 * revoked client cannot keep a live connection after its Device row is gone
 * (revocation deletes the row). Clients that claim NO device id are still
 * allowed (legacy / pre-key-init connects); they only ever join the user room.
 *
 * Runs AFTER `authSocket` so `socket.user` is populated. The resolved device id
 * is cached on the socket so the connection handler can join the device room
 * without re-querying.
 */
messagingNamespace.use((socket, next) => {
  const authed = socket as AuthenticatedSocket;
  void verifyDeviceHandshake(
    authed.user?.id,
    socket.handshake.auth?.deviceId,
    async (userId, deviceId) => {
      const device = await Device.findOne({ userId, deviceId }, { _id: 1 }).lean();
      return device !== null;
    }
  ).then((result) => {
    if (!result.ok) {
      if (result.error === "unregistered_device") {
        logger.warn(
          `Rejecting messaging connection: unregistered device for user ${authed.user?.id}`
        );
      } else if (result.error === "device_verification_failed") {
        logger.error("Failed to verify device for handshake");
      }
      next(new Error(result.error ?? "unregistered_device"));
      return;
    }
    if (result.deviceId !== undefined) {
      authed.signalDeviceId = result.deviceId;
    }
    next();
  });
});

// Throttle guard for per-device `lastSeen` writes. In-memory and therefore
// per-process: with a single Fargate task this is sufficient. If/when the
// backend is horizontally scaled this should move to a shared store (e.g.
// Redis) so the throttle is global rather than per-instance.
const lastSeenWrites = new Map<string, number>();

async function touchDeviceLastSeen(userId: string, deviceId: number): Promise<void> {
  const key = `${userId}:${deviceId}`;
  const now = Date.now();
  const previous = lastSeenWrites.get(key);
  if (previous !== undefined && now - previous < DEVICE_LAST_SEEN_THROTTLE_MS) {
    return;
  }
  lastSeenWrites.set(key, now);
  try {
    await Device.updateOne({ userId, deviceId }, { $set: { lastSeen: new Date() } });
  } catch (error) {
    logger.error("Failed to update device lastSeen", error);
  }
}

/** Socket event carrying a single user's online/last-seen presence update. */
const PRESENCE_EVENT = "presence:update" as const;

/**
 * Resolve the presence audience and privacy for a freshly-connected user, cache
 * both on the socket, and (when the user just came online and is visible) emit
 * an online `presence:update` to each watcher's user room. Best-effort: a
 * failure here must never break the connection, so it is caught and logged.
 *
 * The registry's `addConnection` is called synchronously by the connection
 * handler (so live state is correct immediately); this async step only resolves
 * the fan-out audience + privacy, which require database reads.
 */
async function resolvePresenceAudienceAndEmit(
  socket: AuthenticatedSocket,
  userId: string,
  becameOnline: boolean
): Promise<void> {
  try {
    const conversations = await Conversation.find(
      { "participants.userId": userId },
      { "participants.userId": 1 }
    )
      .limit(MAX_PRESENCE_AUDIENCE)
      .lean();
    const audience = computeAudience(conversations, userId, MAX_PRESENCE_AUDIENCE);
    socket.presenceAudience = audience;

    const settings = await UserSettings.findOne(
      { oxyUserId: userId },
      { "privacy.showOnlineStatus": 1 }
    ).lean();
    const showOnline = !resolveHiddenUserIds(
      settings ? [{ oxyUserId: userId, privacy: settings.privacy }] : []
    ).has(userId);
    socket.presenceShowOnline = showOnline;

    if (becameOnline && showOnline) {
      const payload = buildPresencePayload(userId, presenceRegistry.getEntry(userId));
      for (const otherId of audience) {
        messagingNamespace.to(`user:${otherId}`).emit(PRESENCE_EVENT, payload);
      }
    }
  } catch (error) {
    logger.error("Failed to resolve presence audience on connect", error);
  }
}

// Configure messaging namespace
messagingNamespace.on("connection", (socket: AuthenticatedSocket) => {
  logger.info("Client connected to messaging namespace from ip:", socket.handshake.address);

  if (!socket.user?.id) {
    logger.info("Unauthenticated client attempted to connect to messaging namespace");
    socket.disconnect(true);
    return;
  }

  const userId = socket.user.id;
  const userRoom = `user:${userId}`;
  socket.join(userRoom);
  logger.info(`Client ${socket.id} joined messaging room:`, userRoom);

  // Multi-device: the handshake middleware has already verified that any claimed
  // device id is registered to this user (rejecting the connection otherwise)
  // and cached it on `socket.signalDeviceId`. Join its device room so it can
  // receive its own per-device envelopes. A socket with no device id is a legacy
  // client and only gets the user room for activity events.
  const deviceId = socket.signalDeviceId;
  if (deviceId !== undefined) {
    const room = `device:${userId}:${deviceId}`;
    socket.join(room);
    logger.info(`Client ${socket.id} joined device room:`, room);
    void touchDeviceLastSeen(userId, deviceId);
  }

  // Online presence. Register this connection synchronously so the user's live
  // state is correct immediately; resolving the fan-out audience + privacy needs
  // database reads and runs asynchronously. The connection key is the socket id
  // (each socket is one connection — N sockets per user = N keys), which is
  // unique even for a legacy client that claims no device id.
  const deviceKey = socket.id;
  const { becameOnline } = presenceRegistry.addConnection(userId, deviceKey);
  void resolvePresenceAudienceAndEmit(socket, userId, becameOnline);

  socket.on("error", (error: Error) => {
    logger.error("Messaging socket error", error.message);
  });

  // Join conversation room
  socket.on("joinConversation", (conversationId: string) => {
    const room = `conversation:${conversationId}`;
    socket.join(room);
    logger.info(`Client ${socket.id} joined conversation room:`, room);
  });

  // Leave conversation room
  socket.on("leaveConversation", (conversationId: string) => {
    const room = `conversation:${conversationId}`;
    socket.leave(room);
    logger.info(`Client ${socket.id} left conversation room:`, room);
  });

  // Handle typing indicators
  socket.on("typing", (data: { conversationId: string; userId: string; isTyping: boolean }) => {
    const { conversationId, isTyping } = data;
    const room = `conversation:${conversationId}`;

    // Broadcast typing indicator to all participants except the sender
    socket.to(room).emit("typing", {
      conversationId,
      userId: userId,
      isTyping,
    });
  });

  socket.on("disconnect", (reason: DisconnectReason) => {
    logger.info(`Client ${socket.id} disconnected from messaging namespace:`, reason);
    socket.leave(userRoom);

    // Online presence: drop this connection. On the >=1 -> 0 transition the user
    // is now offline, so emit an offline update to the cached audience (resolved
    // at connect). Wrapped so a presence error can't skip the throttle cleanup
    // below. If the audience hasn't resolved yet (very short-lived connection),
    // it's undefined and we emit to no one.
    try {
      const { becameOffline, lastSeenAt } = presenceRegistry.removeConnection(userId, socket.id);
      if (becameOffline && socket.presenceShowOnline !== false) {
        const payload = buildPresencePayload(userId, { online: false, lastSeenAt });
        for (const otherId of socket.presenceAudience ?? []) {
          messagingNamespace.to(`user:${otherId}`).emit(PRESENCE_EVENT, payload);
        }
      }
    } catch (error) {
      logger.error("Failed to emit presence on disconnect", error);
    }

    // Evict this device's throttle entry so `lastSeenWrites` doesn't grow without
    // bound as devices connect and disconnect over the process lifetime.
    if (socket.signalDeviceId !== undefined) {
      lastSeenWrites.delete(`${userId}:${socket.signalDeviceId}`);
    }
  });
});

// Register WebRTC call signaling handlers on the messaging namespace.
registerCallSignaling(messagingNamespace);
registerP2PSignaling(messagingNamespace);

// Configure main namespace
io.on("connection", (socket: AuthenticatedSocket) => {
  logger.info("Client connected from ip:", socket.handshake.address);

  socket.on("error", (error: Error) => {
    logger.error("Socket error", error.message);
    if (socket.connected) {
      socket.disconnect();
    }
  });

  socket.on("disconnect", (reason: DisconnectReason) => {
    logger.info("Client disconnected:", reason);
  });
});

// --- Expose namespaces for use in routes ---
app.set("io", io);
app.set("messagingNamespace", messagingNamespace);
// Typed via the `declare global` above — no cast needed.
global.io = io;

// --- Optional Auth Middleware ---
// Tries to authenticate but doesn't fail if no token is provided
const optionalAuth = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return next();
  }

  const authMiddleware = oxy.auth();
  authMiddleware(req, res, (err?: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      logger.info(
        "Optional auth: Authentication failed, continuing as unauthenticated:",
        message
      );
      (req as AuthRequest).user = undefined;
    }
    next();
  });
};

// --- API ROUTES ---
// Public API routes (no authentication required)
const publicApiRouter = express.Router();

// Health check
publicApiRouter.get("/health", (req, res) => {
  res.json({ status: "ok", service: "allo-backend" });
});

// Authenticated API routes (require authentication)
const authenticatedApiRouter = express.Router();
authenticatedApiRouter.use("/profile", profileSettingsRoutes);
authenticatedApiRouter.use("/conversations", conversationsRoutes);
authenticatedApiRouter.use("/messages", messagesRoutes);
authenticatedApiRouter.use("/devices", devicesRoutes);
authenticatedApiRouter.use("/status", statusRoutes);
authenticatedApiRouter.use("/calls", callsRoutes);
authenticatedApiRouter.use("/presence", presenceRoutes);
// Interop bridge user-facing routes (F3.0, flag-gated).
if (isBridgeEnabled()) {
  authenticatedApiRouter.use("/bridge", bridgeRoutes);
}

// Interop bridge INTERNAL routes (F3.0, flag-gated). Mounted here — after the
// DB-connect middleware (so handlers have DB access) and with the raw body
// already captured by the scoped parser above — behind the HMAC `bridgeAuth`.
// NOT under Oxy auth (the connector authenticates by signature, not a user JWT).
if (isBridgeEnabled()) {
  app.use("/internal/bridge", bridgeAuth, internalBridgeRouter);
}

// Mount public and authenticated API routers
app.use("/api", publicApiRouter);
app.use("/api", oxy.auth(), authenticatedApiRouter);

// --- Root API Welcome Route ---
app.get("/", async (req, res) => {
  res.json({ message: "Welcome to Allo API", version: "1.0.0" });
});

// --- MongoDB Connection ---
const db = require("mongoose").connection;
db.on("error", (error: Error) => {
  logger.error("MongoDB connection error", error);
});
db.once("open", () => {
  logger.info("Connected to MongoDB successfully");
  // Load models
  require("./src/models/Conversation");
  require("./src/models/Message");
  require("./src/models/UserSettings");
  require("./src/models/PushToken");
  require("./src/models/Block");
  require("./src/models/Restrict");
  require("./src/models/UserBehavior");
  require("./src/models/Device");
  require("./src/models/Status");
  require("./src/models/Call");
  // Interop bridge (F3.0). Registering a schema is behavior-neutral — nothing
  // queries these unless the bridge flag is on — so they register unconditionally.
  require("./src/models/LinkedAccount");
  require("./src/models/ExternalContact");
  require("./src/models/BridgeOutbox");
});

// --- Server Listen ---
const PORT = process.env.PORT || 3000;
const bootServer = async () => {
  try {
    await connectToDatabase();
    server.listen(PORT, () => {
      logger.info(`Allo backend server running on port ${PORT}`);
    });
    // Interop bridge (F3.0): start the outbound outbox sweeper ONLY when the
    // flag is on and ONLY here (never at module import, so tests that import
    // services don't spawn timers).
    if (isBridgeEnabled()) {
      startOutboxSweeper();
      logger.info("Bridge outbox sweeper started");
    }
  } catch (error) {
    logger.error("Failed to start server: unable to connect to MongoDB", error);
    process.exit(1);
  }
};

if (require.main === module) {
  void bootServer();
}

// Serve uploaded files defensively: force download, disable MIME sniffing, and
// apply a locked-down CSP so an uploaded .html/.svg can never execute in the app
// origin (stored-XSS hardening). Upload validation also lives in the upload route.
app.use(
  "/uploads",
  (_req, res, next) => {
    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    next();
  },
  express.static(UPLOAD_DIR)
);

export { app, io, messagingNamespace };
export default server;

