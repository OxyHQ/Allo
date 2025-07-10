import express, { Request, Response } from "express";
import http from "http";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./config/db";
import authRoutes from "./routes/auth.routes";
import { initializeSocket } from "./socket/socket";

dotenv.config();

const app = express();

// Middlewares
app.use(express.json());
app.use(cors());

// Routes
app.use("/auth", authRoutes);

app.get("/", (req, res) => {
  res.send("Server is running.");
});

// Create HTTP server and initialize Socket.IO
const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

// listen to socket events
initializeSocket(server);

connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error(
      "Failed to start server due to database connection error:",
      error
    );
  });
