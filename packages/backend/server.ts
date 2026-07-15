// --- Imports ---
import express from "express";
import http from "http";
import mongoose from "mongoose";
import { connectToDatabase } from "./src/utils/database";
import { Server as SocketIOServer } from "socket.io";
import type { DisconnectReason, Namespace } from "socket.io";
import dotenv from "dotenv";
import { oxyClient } from "@oxyhq/core";
import { createOxyAuthMiddleware, createOxyCors, createOxyRateLimit } from "@oxyhq/core/server";
import { logger } from "./src/utils/logger";
import type { AlloRealtimeServer, AuthenticatedSocket } from "./src/types/realtime";
import Conversation from "./src/models/Conversation";

// Routers
import profileSettingsRoutes from "./src/routes/profileSettings";
import conversationsRoutes from "./src/routes/conversations";
import messagesRoutes from "./src/routes/messages";
import devicesRoutes from "./src/routes/devices";

// Middleware

// --- Config ---
dotenv.config();

// Explicit localhost dev origins. The Oxy apex family (*.oxy.so — including
// allo.oxy.so / api.allo.oxy.so) is allowed automatically by createOxyCors, so
// only non-apex dev origins need to be listed here. Reused for both the Express
// CORS middleware and the Socket.IO CORS allowlist.
const APP_ORIGINS = ["http://localhost:8081", "http://localhost:8082"];

const app = express();

// Initialize Oxy client for authentication
export const oxy = oxyClient;

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
    origin: [...APP_ORIGINS, "https://allo.oxy.so"],
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
    if (typeof conversationId !== "string" || !mongoose.isValidObjectId(conversationId)) {
      return;
    }

    try {
      const isParticipant = await Conversation.exists({
        _id: conversationId,
        "participants.userId": userId,
      });

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

// Mount public and authenticated API routers
app.use("/api", publicApiRouter);
app.use("/api", createOxyAuthMiddleware(oxy), authenticatedApiRouter);

// --- Root API Welcome Route ---
app.get("/", async (req, res) => {
  res.json({ message: "Welcome to Allo API", version: "1.0.0" });
});

// --- MongoDB Connection ---
const db = mongoose.connection;
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
});

// --- Server Listen ---
const PORT = process.env.PORT || 3000;
const bootServer = async () => {
  try {
    await connectToDatabase();
    server.listen(PORT, () => {
      logger.info(`Allo backend server running on port ${PORT}`);
    });
  } catch (error) {
    logger.error("Failed to start server: unable to connect to MongoDB", error);
    process.exit(1);
  }
};

if (require.main === module) {
  void bootServer();
}

export { io, messagingNamespace };
export default server;
