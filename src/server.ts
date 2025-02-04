import express from "express";
import http from "http";
import mongoose from "mongoose";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import chat from "./routes/chat";
import * as chatController from "./controllers/chatController";
import * as chatService from "./services/chatService";

// Import security middlewares
import { rateLimiter, bruteForceProtection, csrfProtection, parseCookies, csrfErrorHandler } from "./middleware/security";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Add security middlewares
app.use(parseCookies);
app.use(rateLimiter);
app.use(bruteForceProtection);
app.use(csrfProtection);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || "");

const db = mongoose.connection;
db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", () => {
  console.log("Connected to MongoDB");
});

// Socket.IO Connection
io.on("connection", (socket) => {
  console.log("Client connected from ip: " + socket.handshake.address);
  
  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

// API Routes
app.get("/api", async (req, res) => {
  try {

    res.json({
      message: "Welcome to the API",
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching stats", error });
  }
});

app.use("/api/chat", chat(io));

// Add CSRF error handler (should be after routes)
app.use(csrfErrorHandler);

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
