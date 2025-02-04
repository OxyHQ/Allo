import { Server as SocketIOServer } from "socket.io";
import mongoose from "mongoose";
import MessageModel from "../models/Message.model";
import ConversationModel from "../models/Conversation.model";
import ReportModel from "../models/Report.model";

const verifyToken = (socket: any, next: any) => {
  const token = socket.handshake.auth.token;
  if (token && tokenIsValid(token)) return next();
  return next(new Error("Authentication error"));
};

async function checkConversation(conversationID: string) {
  if (!mongoose.Types.ObjectId.isValid(conversationID)) return null;
  return ConversationModel.findById(conversationID);
}

const joinConversation = (socket: any, conversationID: string) => {
  socket.join(conversationID);
  console.log(`User ${socket.id} joined conversation ${conversationID}`);
};

const createConversation = async (socket: any, data: any) => {
  try {
    const { participants, type, topic, owner } = data;
    const conversationData: any = {
      participants,
      type,
      topic,
      owner: owner || socket.id,
    };
    if (type === "group" || type === "channel") {
      conversationData.admins = [conversationData.owner];
    }
    const conversation = await ConversationModel.create(conversationData);
    socket.join(conversation.id);
    socket.emit("conversationCreated", conversation);
  } catch (err) {
    console.error("Error creating conversation:", err);
    socket.emit("error", { message: "Could not create conversation" });
  }
};

const sendMessage = async (io: SocketIOServer, socket: any, data: any) => {
  try {
    const { userID, conversationID, message } = data;
    const convo = await checkConversation(conversationID);
    if (!convo) return socket.emit("error", { message: "Conversation not found" });
    const newMessage = { userID, conversationID, message, createdAt: new Date(), status: "sent" };
    await MessageModel.create(newMessage);
    io.to(conversationID).emit("message", newMessage);
  } catch (err) {
    console.error("Error sending message:", err);
  }
};

const sendSecureMessage = async (io: SocketIOServer, socket: any, data: any) => {
  try {
    const { userID, conversationID, message, encrypted, encryptionAlgorithm, signature } = data;
    const convo = await checkConversation(conversationID);
    if (!convo) return socket.emit("error", { message: "Conversation not found" });
    const secureMessage = { userID, conversationID, message, createdAt: new Date(), status: "sent", encrypted, encryptionAlgorithm, signature };
    await MessageModel.create(secureMessage);
    io.to(conversationID).emit("message", secureMessage);
  } catch (err) {
    console.error("Error sending secure message:", err);
  }
};

const reportMessage = async (io: SocketIOServer, socket: any, data: any) => {
  const { conversationID, messageId, reason } = data;
  try {
    await ReportModel.create({
      conversationID,
      messageId,
      reporter: socket.id,
      reason,
      createdAt: new Date(),
    });
    io.to(conversationID).emit("messageReported", { messageId, reporter: socket.id, reason });
  } catch (err) {
    console.error("Error reporting message:", err);
    socket.emit("error", { message: "Could not report message" });
  }
};

const editMessage = async (io: SocketIOServer, socket: any, data: any) => {
  try {
    const { conversationID, messageId, newMessage } = data;
    await MessageModel.findByIdAndUpdate(messageId, { message: newMessage, editedAt: new Date() });
    io.to(conversationID).emit("messageEdited", { messageId, newMessage, editedAt: new Date() });
  } catch (err) {
    console.error("Error editing message:", err);
  }
};

const deleteMessage = async (io: SocketIOServer, socket: any, data: any) => {
  const { conversationID, messageId } = data;
  try {
    await MessageModel.findByIdAndDelete(messageId);
    io.to(conversationID).emit("messageDeleted", { messageId });
  } catch (err) {
    console.error("Error deleting message:", err);
    socket.emit("error", { message: "Could not delete message" });
  }
};

const forwardMessage = async (io: SocketIOServer, socket: any, data: any) => {
  const { fromConversationID, toConversationID, messageId } = data;
  try {
    const originalMessage = await MessageModel.findById(messageId);
    if (originalMessage) {
      const forwardedMessage = {
        userID: originalMessage.userID,
        conversationID: toConversationID,
        message: originalMessage.message,
        createdAt: new Date(),
        status: "sent",
        forwardedFrom: fromConversationID,
      };
      const newMessage = await MessageModel.create(forwardedMessage);
      io.to(toConversationID).emit("messageForwarded", { messageId: newMessage.id, forwardedAt: new Date() });
    } else {
      throw new Error("Original message not found");
    }
  } catch (err) {
    console.error("Error forwarding message:", err);
    socket.emit("error", { message: "Could not forward message" });
  }
};

const messageRead = async (io: SocketIOServer, socket: any, data: any) => {
  const { conversationID, messageId } = data;
  try {
    await MessageModel.findByIdAndUpdate(messageId, {
      status: "read",
      $addToSet: { readBy: socket.id },
    });
    io.to(conversationID).emit("messageStatusUpdate", { messageId, status: "read" });
  } catch (err) {
    console.error("Error updating read status:", err);
    socket.emit("error", { message: "Could not update read status" });
  }
};

const pinMessage = async (io: SocketIOServer, socket: any, data: any) => {
  const { conversationID, messageId, pin } = data;
  try {
    await MessageModel.findByIdAndUpdate(messageId, {
      pinned: pin,
      pinnedAt: new Date(),
      pinnedBy: socket.id,
    });
    io.to(conversationID).emit("messagePinned", { messageId, pinned: pin, pinnedAt: new Date(), pinnedBy: socket.id });
  } catch (err) {
    console.error("Error updating pinned status:", err);
    socket.emit("error", { message: "Could not update pinned status" });
  }
};

const reactionMessage = async (io: SocketIOServer, socket: any, data: any) => {
  const { conversationID, messageId, emoji } = data;
  try {
    await MessageModel.findByIdAndUpdate(messageId, {
      $push: { reactions: { emoji, userID: socket.id } },
    });
    io.to(conversationID).emit("messageReaction", { messageId, emoji, userID: socket.id });
  } catch (err) {
    console.error("Error updating reaction:", err);
    socket.emit("error", { message: "Could not update reaction" });
  }
};

const scheduleMessage = (io: SocketIOServer, socket: any, data: any) => {
  const { userID, conversationID, message, scheduledTime } = data;
  checkConversation(conversationID).then(convo => {
    if (!convo) return socket.emit("error", { message: "Conversation not found" });
    const delay = new Date(scheduledTime).getTime() - Date.now();
    if (delay > 0) {
      setTimeout(async () => {
        const scheduledMessage = {
          userID,
          conversationID,
          message,
          createdAt: new Date(),
          status: "sent",
          scheduledAt: new Date(scheduledTime)
        };
        await MessageModel.create(scheduledMessage);
        console.log("Scheduled message sent:", scheduledMessage);
        io.to(conversationID).emit("message", scheduledMessage);
      }, delay);
    } else {
      (async () => {
        const newMessage = { userID, conversationID, message, createdAt: new Date(), status: "sent" };
        await MessageModel.create(newMessage);
        io.to(conversationID).emit("message", newMessage);
      })();
    }
  }).catch(err => {
    console.error("Error finding conversation:", err);
    socket.emit("error", { message: "Conversation not found" });
  });
};

const unsendMessage = async (io: SocketIOServer, socket: any, data: any) => {
  const { conversationID, messageId } = data;
  try {
    await MessageModel.findByIdAndDelete(messageId);
    io.to(conversationID).emit("messageUnsent", { messageId });
  } catch (err) {
    console.error("Error unsending message:", err);
    socket.emit("error", { message: "Could not unsend message" });
  }
};

const sendEphemeralMessage = async (io: SocketIOServer, socket: any, data: any) => {
  const { userID, conversationID, message, expiresIn } = data;
  const convo = await checkConversation(conversationID);
  if (!convo) return socket.emit("error", { message: "Conversation not found" });
  const ephemeralMessage = {
    userID,
    conversationID,
    message,
    createdAt: new Date(),
    status: "sent",
    ephemeralExpiresAt: new Date(Date.now() + expiresIn)
  };
  try {
    await MessageModel.create(ephemeralMessage);
    io.to(conversationID).emit("message", ephemeralMessage);
    setTimeout(() => {
      io.to(conversationID).emit("messageDeleted", { messageId: ephemeralMessage.createdAt.toString() });
    }, expiresIn);
  } catch (err) {
    console.error("Error sending ephemeral message:", err);
    socket.emit("error", { message: "Could not send ephemeral message" });
  }
};

const sendVoiceMessage = (io: SocketIOServer, socket: any, data: any) => {
  const { userID, conversationID, message, voiceUrl } = data;
  checkConversation(conversationID).then(convo => {
    if (!convo) return socket.emit("error", { message: "Conversation not found" });
    const voiceMessage = {
      userID,
      conversationID,
      message,
      createdAt: new Date(),
      status: "sent",
      attachments: [{ type: "voice", url: voiceUrl }]
    };
    io.to(conversationID).emit("message", voiceMessage);
  });
};

const sendSticker = (io: SocketIOServer, socket: any, data: any) => {
  const { userID, conversationID, stickerUrl } = data;
  checkConversation(conversationID).then(convo => {
    if (!convo) return socket.emit("error", { message: "Conversation not found" });
    const stickerMessage = {
      userID,
      conversationID,
      message: "",
      createdAt: new Date(),
      status: "sent",
      attachments: [{ type: "sticker", url: stickerUrl }]
    };
    io.to(conversationID).emit("message", stickerMessage);
  });
};

const createPoll = (io: SocketIOServer, socket: any, data: any) => {
  const { userID, conversationID, question, options } = data;
  if (!mongoose.Types.ObjectId.isValid(conversationID))
    return socket.emit("error", { message: "Invalid conversation id" });
  ConversationModel.findById(conversationID).then(convo => {
    if (!convo) return socket.emit("error", { message: "Conversation not found" });
    const pollMessage = {
      userID,
      conversationID,
      message: "",
      createdAt: new Date(),
      status: "sent",
      poll: {
        question,
        options,
        votes: options.map(() => 0)
      }
    };
    io.to(conversationID).emit("message", pollMessage);
  });
};

const votePoll = async (io: SocketIOServer, socket: any, data: any) => {
  const { conversationID, messageId, optionIndex } = data;
  try {
    const message = await MessageModel.findById(messageId);
    if (message && message.poll) {
      const votes = Array.isArray(message.poll.votes)
        ? message.poll.votes
        : message.poll.options.map(() => 0);
      votes[optionIndex] = (votes[optionIndex] || 0) + 1;
      await MessageModel.findByIdAndUpdate(messageId, { "poll.votes": votes });
      io.to(conversationID).emit("pollVoted", { messageId, optionIndex, votes });
    } else {
      throw new Error("Poll not found");
    }
  } catch (err) {
    console.error("Error voting poll:", err);
    socket.emit("error", { message: "Could not vote on poll" });
  }
};

export {
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
};

function tokenIsValid(token: string): boolean {
  return token === "valid-token";
}
