import { Router } from "express";
import { Server as SocketIOServer } from "socket.io";
import { 
  verifyToken, 
  joinConversation, 
  createConversation, 
  sendMessage, 
  sendSecureMessage, 
  reportMessage, 
  editMessage, 
  deleteMessage, 
  forwardMessage, 
  messageRead, 
  pinMessage, 
  reactionMessage, 
  scheduleMessage, 
  unsendMessage, 
  sendEphemeralMessage, 
  sendVoiceMessage, 
  sendSticker, 
  createPoll, 
  votePoll 
} from "../controllers/chatController";

const router = Router();

export default (io: SocketIOServer) => {
  io.use(verifyToken);

  io.on("connection", (socket) => {
    socket.on("joinConversation", (conversationID: string) => {
      joinConversation(socket, conversationID);
    });

    socket.on("createConversation", async (data) => {
      await createConversation(socket, data);
    });

    socket.on("sendMessage", async (data) => {
      await sendMessage(io, socket, data);
    });

    socket.on("sendSecureMessage", async (data) => {
      await sendSecureMessage(io, socket, data);
    });

    socket.on("reportMessage", async (data) => {
      await reportMessage(io, socket, data);
    });

    socket.on("editMessage", async (data) => {
      await editMessage(io, socket, data);
    });

    socket.on("deleteMessage", async (data) => {
      await deleteMessage(io, socket, data);
    });

    socket.on("forwardMessage", async (data) => {
      await forwardMessage(io, socket, data);
    });

    socket.on("messageRead", async (data) => {
      await messageRead(io, socket, data);
    });

    socket.on("pinMessage", async (data) => {
      await pinMessage(io, socket, data);
    });

    socket.on("reactionMessage", async (data) => {
      await reactionMessage(io, socket, data);
    });

    socket.on("scheduleMessage", (data) => {
      scheduleMessage(io, socket, data);
    });

    socket.on("unsendMessage", async (data) => {
      await unsendMessage(io, socket, data);
    });

    socket.on("sendEphemeralMessage", async (data) => {
      await sendEphemeralMessage(io, socket, data);
    });

    socket.on("sendVoiceMessage", (data) => {
      sendVoiceMessage(io, socket, data);
    });

    socket.on("sendSticker", (data) => {
      sendSticker(io, socket, data);
    });

    socket.on("createPoll", (data) => {
      createPoll(io, socket, data);
    });

    socket.on("votePoll", async (data) => {
      await votePoll(io, socket, data);
    });
  });

  return router;
};
