// --- Imports ---
import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import type { DisconnectReason, Namespace } from "socket.io";
import dotenv from "dotenv";
import { oxyClient } from "@oxyhq/core";
import { createOxyAuthMiddleware, createOxyCors, createOxyRateLimit } from "@oxyhq/core/server";
import { logger } from "./src/utils/logger";
import type { AlloRealtimeServer, AuthenticatedSocket } from "./src/types/realtime";
import { connectPostgres, ensurePostgresReachable, getDb } from "./src/db";
import { isConversationParticipant } from "./src/db/messaging/conversationRepository";
import { startExpirySweep } from "./src/db/expiry";

// Routers
import profileSettingsRoutes from "./src/routes/profileSettings";
import conversationsRoutes from "./src/routes/conversations";
import messagesRoutes from "./src/routes/messages";
import devicesRoutes from "./src/routes/devices";
import reportsRoutes from "./src/routes/reports";
import bridgesRoutes from "./src/routes/bridges";
import pushRoutes from "./src/routes/push";
import { createCrowdSourceWebhookRoutes } from "./src/routes/crowdSourceWebhook";
import { createBridgeInternalRoutes } from "./src/routes/bridgesInternal";
import { createPushGatewayRoutes } from "./src/routes/pushGateway";
import { createDirectoryRoutes } from "./src/routes/directory";
import { createOxyDirectoryService } from "./src/services/oxy/OxyDirectoryService";
import { configureOxyServiceAuth } from "./src/config/oxyService";
import { createMatrixAuthMiddleware } from "./src/middleware/matrixAuth";
import { PUSH_GATEWAY_MOUNT_PATH } from "./src/config/push";
import { startModerationOutboxDispatcher } from "./src/services/moderation/ModerationOutboxDispatcher";
import { startBridgeStatusSweep } from "./src/services/bridges/BridgeStatusService";

// Middleware

// --- Config ---
dotenv.config();

// Origins that are NOT covered by createOxyCors, which admits the Oxy apex
// family (*.oxy.so) automatically and nothing else.
//
// `https://allo.you` has to be listed explicitly for exactly that reason: it is
// the product's own domain, outside the oxy.so apex, so the automatic rule does
// not reach it. Dropping it from here does not fail at boot — it fails in the
// browser, as a CORS error on every request the web app makes.
//
// Reused for both the Express CORS middleware and the Socket.IO allowlist.
const APP_ORIGINS = [
  "https://allo.you",
  "http://localhost:8140",
  "http://localhost:8141",
];

const app = express();

// Initialize Oxy client for authentication
export const oxy = oxyClient;

/**
 * The same client, additionally configured to call Oxy AS ALLO when a service
 * credential is present.
 *
 * A no-op without one, and the directory still works — every Oxy route it uses
 * is public. See `src/config/oxyService.ts` for what a credential changes and
 * for the human step that mints it.
 */
configureOxyServiceAuth(oxy);

// --- Middleware ---

/**
 * MUST stay ahead of `express.json` below.
 *
 * A CrowdSource webhook signature covers the bytes that arrived, and once a JSON
 * parser has consumed the stream those bytes no longer exist.
 * `@oxyhq/crowdsource-express` reads the raw stream itself and REFUSES if
 * something upstream already consumed it, rather than verifying a signature over a
 * re-serialisation — so mounting this after the parser does not silently verify
 * the wrong bytes, it fails every delivery. The route adds its own assertion on top
 * of that (see `assertRawBody`), which names the mount order as the cause instead
 * of leaving a signature mismatch to be misread as a bad secret.
 *
 * It also sits ahead of the per-user rate limiter further down, deliberately: the
 * HMAC is the authentication (§10.8), and a 429 to CrowdSource would put a
 * moderation decision back on a retry schedule for no reason.
 */
app.use("/webhooks", createCrowdSourceWebhookRoutes());

/**
 * Bridge callbacks, ahead of the JSON parser and of Oxy authentication
 * (docs/matrix/bridges.md §5.4).
 *
 * These are called by the bridge processes and never by the app. Mounting them
 * here means an Oxy session cannot satisfy them and the per-user rate limiter
 * further down cannot throttle them — properties of the ASSEMBLY rather than of
 * a check inside each handler. The router brings its own body parser, so it does
 * not depend on middleware mounted after it.
 *
 * `GET /internal/bridges/proxy` in particular sits on the bridge's connect path:
 * a 429 there is a user who cannot connect.
 */
app.use("/internal/bridges", createBridgeInternalRoutes());

/**
 * The Matrix Push Gateway, ahead of the JSON parser and of Oxy authentication
 * (docs/matrix/push.md §4).
 *
 * Called by Synapse and by nothing else. A homeserver has no Oxy session and can
 * never be given one, so a route behind `createOxyAuthMiddleware` could only ever
 * answer 401 to the one caller it exists for; and the per-user rate limiter
 * further down has no user to key on here, so it would throttle every user's
 * notifications together. Both are properties of this placement rather than of a
 * check inside the handler.
 *
 * Its own authentication is a per-device capability token in the pusher's URL —
 * see `services/push/gatewayToken.ts`. The router brings its own body parser and
 * is not mounted at all when no push platform is configured.
 */
app.use(PUSH_GATEWAY_MOUNT_PATH, createPushGatewayRoutes());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Database availability, at cold start only.
 *
 * The same guard this replaced, one store over: `ensurePostgresReachable()`
 * probes ONCE and caches the result, so this costs a round trip on the first
 * request after boot and nothing on every request after it. A database that
 * dies mid-life is NOT covered here and never was — that is a 500 from whichever
 * handler touches it. See `src/db/index.ts` for why it is deliberately not a
 * per-request check.
 */
app.use(async (req, res, next) => {
  try {
    await ensurePostgresReachable();
    next();
  } catch (error) {
    logger.error("Postgres connection unavailable", error);
    if (res.headersSent) {
      return;
    }
    res.status(503).json({ message: "Database temporarily unavailable" });
  }
});

// Strict CORS allowlist (Oxy apex family + explicit dev origins). Echoes back
// the exact matched origin, never a credentialed wildcard, and answers OPTIONS
// preflight with 204.
app.use(createOxyCors({ appOrigins: APP_ORIGINS }));

// No-store cache headers for all API responses (not CORS-related).
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

const server = http.createServer(app);

/**
 * Longest conversation id worth taking from a socket client.
 *
 * Generous against both shapes this schema stores — a uuid v7 is 36 characters
 * and an ObjectId hex is 24 — so it bounds the input without encoding either
 * format as a rule.
 */
const MAX_CONVERSATION_ID_LENGTH = 64;

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
    origin: APP_ORIGINS,
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
const authenticateSocket = oxy.authSocket();
[messagingNamespace, io].forEach((namespaceOrServer: Namespace | SocketIOServer) => {
  namespaceOrServer.use((socket: AuthenticatedSocket, next: (err?: Error) => void) => {
    void authenticateSocket(socket, next);
  });
});

// Configure messaging namespace
messagingNamespace.on("connection", (socket: AuthenticatedSocket) => {
  logger.info("Client connected to messaging namespace");

  if (!socket.user?.id) {
    logger.warn("Unauthenticated client attempted to connect to messaging namespace");
    socket.disconnect(true);
    return;
  }

  const userId = socket.user.id;
  const userRoom = `user:${userId}`;
  socket.join(userRoom);
  logger.info(`Client ${socket.id} joined messaging room`, { room: userRoom });

  socket.on("error", (error: Error) => {
    logger.error("Messaging socket error", error);
  });

  // Join conversation room — only after verifying the authenticated user is a
  // participant. The conversation id is client-supplied, so we never trust it to
  // scope a room without an ownership check (these rooms carry message ciphertext,
  // edits, reactions, deletions and typing indicators).
  socket.on("joinConversation", async (conversationId: string) => {
    /**
     * A bound on the input, and deliberately NOT a format check.
     *
     * Conversation ids are `text` and come in two shapes — a uuid v7 for rows
     * created since the Postgres cutover, and a 24-character hex id for rows
     * that predate it — so any single-format test would reject one of the two
     * outright. The authorization is not the format anyway; it is the
     * participant lookup below, which answers for both.
     */
    if (
      typeof conversationId !== "string" ||
      conversationId.length === 0 ||
      conversationId.length > MAX_CONVERSATION_ID_LENGTH
    ) {
      return;
    }

    try {
      const isParticipant = await isConversationParticipant(getDb(), conversationId, userId);

      if (!isParticipant) {
        logger.warn(`Client ${socket.id} denied joinConversation (not a participant)`, {
          conversationId,
          userId,
        });
        return;
      }

      const room = `conversation:${conversationId}`;
      socket.join(room);
      logger.info(`Client ${socket.id} joined conversation room`, { room });
    } catch (error) {
      logger.error("Failed to authorize joinConversation", error);
    }
  });

  // Leave conversation room
  socket.on("leaveConversation", (conversationId: string) => {
    const room = `conversation:${conversationId}`;
    socket.leave(room);
    logger.info(`Client ${socket.id} left conversation room`, { room });
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
    logger.info(`Client ${socket.id} disconnected from messaging namespace`, { reason });
    socket.leave(userRoom);
  });
});

// Configure main namespace
io.on("connection", (socket: AuthenticatedSocket) => {
  logger.info("Client connected");

  socket.on("error", (error: Error) => {
    logger.error("Socket error", error);
    if (socket.connected) {
      socket.disconnect();
    }
  });

  socket.on("disconnect", (reason: DisconnectReason) => {
    logger.info("Client disconnected", { reason });
  });
});

// --- Expose namespaces for use in routes ---
const realtimeServer: AlloRealtimeServer = { io, messagingNamespace };
app.locals.realtime = realtimeServer;

// Resolve session and apply per-user rate limiting in one shared middleware.
app.use(createOxyRateLimit(oxy));

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
authenticatedApiRouter.use("/reports", reportsRoutes);
authenticatedApiRouter.use("/bridges", bridgesRoutes);
authenticatedApiRouter.use("/push", pushRoutes);
authenticatedApiRouter.use("/directory", createDirectoryRoutes({ service: createOxyDirectoryService(oxy) }));

// Mount public and authenticated API routers
app.use("/api", publicApiRouter);

/**
 * Two ways to be signed in, one shape of `req.user`.
 *
 * `createMatrixAuthMiddleware` runs FIRST and answers only requests whose
 * `Authorization` header uses the `MatrixBearer` scheme; every other request —
 * which today is every request, because the app still sends an Oxy `Bearer` —
 * passes straight through to `createOxyAuthMiddleware`, unchanged.
 *
 * The order is what makes the composition safe rather than merely convenient.
 * `oxy.auth()` reads a token only from a header beginning with the exact string
 * `"Bearer "`, so a MatrixBearer credential is INVISIBLE to it; and the Matrix
 * middleware never calls `next()` after refusing one, so a token can never be
 * offered to both validators. See `src/middleware/matrixAuth.ts` for the rest
 * of the reasoning, including why this cannot sit ahead of the rate limiter.
 */
app.use("/api", createMatrixAuthMiddleware(), createOxyAuthMiddleware(oxy), authenticatedApiRouter);

// --- Root API Welcome Route ---
app.get("/", async (req, res) => {
  res.json({ message: "Welcome to Allo API", version: "1.0.0" });
});

/**
 * The Postgres connection string. REQUIRED — this service stores everything it
 * owns there and no route can answer without it.
 *
 * Read and validated at boot rather than on first use, so a deployment with a
 * missing or malformed URL dies immediately and visibly instead of serving 500s
 * from whichever endpoint a user happens to hit first.
 */
function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      "DATABASE_URL is not set. Every route in this service runs on Postgres and " +
        "cannot answer without it.",
    );
  }
  return url;
}

// --- Server Listen ---
// Local dev default only — ECS injects PORT explicitly (oxy-infra
// terraform-uswest2/app-allo.tf sets it to 8080). 4140 is Allo's slot in the
// per-app port map so several Oxy backends can run side by side.
const PORT = process.env.PORT || 4140;
const bootServer = async () => {
  try {
    /**
     * Postgres first, and not lazily: `createDatabase` opens the pool here so a
     * bad connection string fails the boot rather than the first request that
     * happens to touch a table.
     */
    const postgres = connectPostgres(requireDatabaseUrl());
    /**
     * The replacement for three Mongo TTL indexes (`db/expiry.ts`). Started here
     * because Mongo's TTL monitor was never something this codebase started
     * either — it was the server's, and dropping it on the way to Postgres is
     * invisible until a table has grown for months.
     */
    startExpirySweep(postgres, logger);
    // Started after the pool is open: the dispatcher's first act is a claim
    // query, and a drain with nothing to query would only log noise.
    // A no-op unless CROWDSOURCE_ENABLED=true.
    startModerationOutboxDispatcher();
    /**
     * The sweep that notices SILENCE (bridges.md §5.4). A no-op unless a bridge
     * network is enabled. Started after the database is reachable for the same
     * reason as the dispatcher: its first act is a query.
     */
    startBridgeStatusSweep();
    server.listen(PORT, () => {
      logger.info(`Allo backend server running on port ${PORT}`);
    });
  } catch (error) {
    logger.error("Failed to start server: the database is unreachable or misconfigured", error);
    process.exit(1);
  }
};

if (require.main === module) {
  void bootServer();
}

export { io, messagingNamespace };
export default server;
