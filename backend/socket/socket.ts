import { Server as SocketIOServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { registerChatEvents } from "./chatEvents";
import { registerUserEvents } from "./userEvents";
import Conversation from "../modals/Conversation";

dotenv.config();

export function initializeSocket(server: any): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: {
      origin: "*", // Allow all origins
    },
  }); // io: socket io server instance

  // Authentication middleware for Socket.IO
  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error("Authentication error: No token provided"));
    }
    jwt.verify(
      token,
      process.env.JWT_SECRET as string,
      (err: any, decoded: any) => {
        if (err) {
          return next(new Error("Authentication error: Invalid token"));
        }
        // Attach user info to socket.data for later use
        let userData = decoded.user;
        socket.data = userData;
        socket.data.userId = userData.id;
        next();
      }
    );
  });

  // When a socket connects, register common events (including chat events)
  io.on("connection", async (socket: Socket) => {
    const userId = socket.data.userId;
    console.log(`User connected: ${userId}, username: ${socket.data.name}`);

    registerChatEvents(io, socket);
    registerUserEvents(io, socket);

    // Handle WebRTC signaling
    socket.on("webrtcSignal", (payload) => {
      const { to, ...rest } = payload;
      if (to) {
        io.to(to).emit("webrtcSignal", { ...rest, from: userId });
      } else {
        console.error("Error: 'to' field missing in webrtcSignal payload");
      }
    });

    // Join all conversations the user is part of
    try {
      const conversations = await Conversation.find({
        participants: userId,
      }).select("_id");

      conversations.forEach((conversation) => {
        socket.join(conversation._id.toString());
      });
    } catch (error) {
      console.error("Error joining conversations:", error);
    }

    socket.on("disconnect", () => {
      console.log(`User disconnected: ${userId}`);
      // Socket.io automatically handles leaving rooms on disconnect
    });
  });

  return io;
}
