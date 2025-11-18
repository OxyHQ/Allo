// --- Imports ---
import express from "express";
import http from "http";
import { connectToDatabase } from "./src/utils/database";
import { Server as SocketIOServer, Socket, Namespace } from "socket.io";
import dotenv from "dotenv";
import { OxyServices } from "@oxyhq/services";

// Routers
import profileSettingsRoutes from "./src/routes/profileSettings";
import conversationsRoutes from "./src/routes/conversations";
import messagesRoutes from "./src/routes/messages";
import devicesRoutes from "./src/routes/devices";

// Middleware
import { rateLimiter, bruteForceProtection } from "./src/middleware/security";

// --- Config ---
dotenv.config();

const app = express();

// Initialize Oxy Services for authentication
export const oxy = new OxyServices({
  baseURL: process.env.OXY_API_URL || "https://api.oxy.so",
});

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database connection middleware
app.use(async (req, res, next) => {
  try {
    await connectToDatabase();
    next();
  } catch (error) {
    console.error("MongoDB connection unavailable:", error);
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
  user?: { id: string; [key: string]: any };
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
[messagingNamespace, io].forEach((namespaceOrServer: any) => {
  if (namespaceOrServer && typeof namespaceOrServer.use === "function") {
    namespaceOrServer.use((socket: AuthenticatedSocket, next: (err?: any) => void) => {
      try {
        const auth = socket.handshake?.auth as any;
        const token = auth?.token || socket.handshake?.headers?.authorization?.replace("Bearer ", "");
        
        if (token) {
          // Verify token with Oxy
          // For now, accept userId from handshake auth
          // TODO: Implement proper token verification with Oxy
          const userId = auth?.userId || auth?.id || auth?.user?.id;
          if (userId && typeof userId === "string") {
            socket.user = { id: userId };
          }
        }
      } catch (_) {
        // ignore – will be handled by connection handlers if user missing
      }
      return next();
    });
  }
});

// Configure messaging namespace
messagingNamespace.on("connection", (socket: AuthenticatedSocket) => {
  console.log("Client connected to messaging namespace from ip:", socket.handshake.address);

  if (!socket.user?.id) {
    console.log("Unauthenticated client attempted to connect to messaging namespace");
    socket.disconnect(true);
    return;
  }

  const userId = socket.user.id;
  const userRoom = `user:${userId}`;
  socket.join(userRoom);
  console.log(`Client ${socket.id} joined messaging room:`, userRoom);

  socket.on("error", (error: Error) => {
    console.error("Messaging socket error:", error.message);
  });

  // Join conversation room
  socket.on("joinConversation", (conversationId: string) => {
    const room = `conversation:${conversationId}`;
    socket.join(room);
    console.log(`Client ${socket.id} joined conversation room:`, room);
  });

  // Leave conversation room
  socket.on("leaveConversation", (conversationId: string) => {
    const room = `conversation:${conversationId}`;
    socket.leave(room);
    console.log(`Client ${socket.id} left conversation room:`, room);
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
    console.log(`Client ${socket.id} disconnected from messaging namespace:`, reason);
    socket.leave(userRoom);
  });
});

// Configure main namespace
io.on("connection", (socket: AuthenticatedSocket) => {
  console.log("Client connected from ip:", socket.handshake.address);

  socket.on("error", (error: Error) => {
    console.error("Socket error:", error.message);
    if (socket.connected) {
      socket.disconnect();
    }
  });

  socket.on("disconnect", (reason: DisconnectReason) => {
    console.log("Client disconnected:", reason);
  });
});

// --- Expose namespaces for use in routes ---
app.set("io", io);
app.set("messagingNamespace", messagingNamespace);
(global as any).io = io;

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
  authMiddleware(req, res, (err?: any) => {
    if (err) {
      console.log(
        "Optional auth: Authentication failed, continuing as unauthenticated:",
        err?.message || "Unknown error"
      );
      (req as any).user = undefined;
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
  console.error("MongoDB connection error:", error);
});
db.once("open", () => {
  console.log("Connected to MongoDB successfully");
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
      console.log(`Allo backend server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server: unable to connect to MongoDB", error);
    process.exit(1);
  }
};

if (require.main === module) {
  void bootServer();
}

export { io, messagingNamespace };
export default server;

