import { Router } from "express";
import { Server as SocketIOServer } from "socket.io";
import mongoose from "mongoose"; // <-- Added for ObjectId validation
import MessageModel, { IConversation } from "../models/Conversation.model";
import ConversationModel from "../models/Conversation.model";
import ReportModel from "../models/Report.model"; // new import for reports
// ...import any token verification utilities...

const router = Router();

// Token verification middleware
const verifyToken = (socket: any, next: any) => {
  const token = socket.handshake.auth.token;
  if (token && tokenIsValid(token)) return next();
  return next(new Error("Authentication error"));
};

// Add helper to check conversation existence.
async function checkConversation(conversationID: string): Promise<IConversation | null> {
  // Validate ObjectId and lookup conversation.
  if (!mongoose.Types.ObjectId.isValid(conversationID)) return null;
  return ConversationModel.findById(conversationID) as Promise<IConversation | null>;
}

export default (io: SocketIOServer) => {
  io.use(verifyToken);

  io.on("connection", (socket) => {
    socket.on("joinConversation", (conversationID: string) => {
      socket.join(conversationID);
      console.log(`User ${socket.id} joined conversation ${conversationID}`);
    });

    socket.on("createConversation", async (data) => {
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
    });

    // Typing indicator events
    socket.on("typing", (conversationID: string) => {
      socket.to(conversationID).emit("typing", { user: socket.id });
    });
    socket.on("stopTyping", (conversationID: string) => {
      socket.to(conversationID).emit("stopTyping", { user: socket.id });
    });

    socket.on("sendMessage", async (data) => {
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
    });

    socket.on("sendSecureMessage", async (data) => {
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
    });

    socket.on("reportMessage", async (data) => {
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
    });

    socket.on("editMessage", async (data) => {
      try {
        const { conversationID, messageId, newMessage } = data;
        await MessageModel.findByIdAndUpdate(messageId, { message: newMessage, editedAt: new Date() });
        io.to(conversationID).emit("messageEdited", { messageId, newMessage, editedAt: new Date() });
      } catch (err) {
        console.error("Error editing message:", err);
      }
    });

    socket.on("deleteMessage", async (data) => {
      const { conversationID, messageId } = data;
      try {
        await MessageModel.findByIdAndDelete(messageId);
        io.to(conversationID).emit("messageDeleted", { messageId });
      } catch (err) {
        console.error("Error deleting message:", err);
        socket.emit("error", { message: "Could not delete message" });
      }
    });

    socket.on("forwardMessage", async (data) => {
      const { fromConversationID, toConversationID, messageId } = data;
      try {
        const originalMessage = await MessageModel.findById(messageId);
        if (originalMessage) {
          // Create a duplicate with forwarded metadata.
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
    });

    socket.on("messageRead", async (data) => {
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
    });

    socket.on("pinMessage", async (data) => {
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
    });

    socket.on("reactionMessage", async (data) => {
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
    });

    socket.on("scheduleMessage", (data) => {
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
    });

    socket.on("unsendMessage", async (data) => {
      const { conversationID, messageId } = data;
      try {
        await MessageModel.findByIdAndDelete(messageId);
        io.to(conversationID).emit("messageUnsent", { messageId });
      } catch (err) {
        console.error("Error unsending message:", err);
        socket.emit("error", { message: "Could not unsend message" });
      }
    });

    socket.on("sendEphemeralMessage", async (data) => {
      const { userID, conversationID, message, expiresIn } = data; // expiresIn in milliseconds
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
        // Optionally, notify clients when message is removed.
        setTimeout(() => {
          io.to(conversationID).emit("messageDeleted", { messageId: ephemeralMessage.createdAt.toString() });
        }, expiresIn);
      } catch (err) {
        console.error("Error sending ephemeral message:", err);
        socket.emit("error", { message: "Could not send ephemeral message" });
      }
    });

    socket.on("sendVoiceMessage", (data) => {
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
    });

    socket.on("sendSticker", (data) => {
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
    });

    socket.on("createPoll", (data) => {
      const { userID, conversationID, question, options } = data;
      if (!mongoose.Types.ObjectId.isValid(conversationID))
        return socket.emit("error", { message: "Invalid conversation id" });
      // Added check for conversation existence
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
    });

    socket.on("votePoll", async (data) => {
      const { conversationID, messageId, optionIndex } = data;
      try {
        const message = await MessageModel.findById(messageId);
        if (message && message.poll) {
          // Ensure votes array is valid.
          const votes = Array.isArray(message.poll.votes)
            ? message.poll.votes
            : message.poll.options.map(() => 0);
          // Increment vote for the selected option.
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
    });
  });

  return router;
};

// Basic token verification implementation.
function tokenIsValid(token: string): boolean {
  // Replace with your own verification logic.
  return token === "valid-token";
}
