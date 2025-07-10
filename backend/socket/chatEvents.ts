// src/socket/chatEvents.ts
import { Server as SocketIOServer, Socket } from "socket.io";
import Conversation from "../modals/Conversation";
import { ConversationProps } from "../types";
import Message from "../modals/Message";
import mongoose from "mongoose";
import { error } from "console";

export function registerChatEvents(io: SocketIOServer, socket: Socket) {
  // Get all conversations for the current user
  socket.on("getConversations", async () => {
    console.log(
      "getConversations event received from user:",
      socket.data.userId
    );
    try {
      const userId = socket.data.userId;
      if (!userId) {
        console.error("No userId found in socket data");
        return socket.emit("getConversations", {
          success: false,
          msg: "User not authenticated",
        });
      }

      // Find all conversations where user is a participant
      const conversations = await Conversation.find({
        participants: userId,
      })
        .sort({ updatedAt: -1 })
        .populate({
          path: "lastMessage",
          select: "content senderId attachment createdAt",
        })
        .populate({
          path: "participants",
          select: "name avatar email",
        })
        .lean();

      socket.emit("getConversations", {
        success: true,
        data: conversations,
      });
    } catch (error) {
      console.error("Error in getConversations:", error);
      socket.emit("getConversations", {
        success: false,
        msg: "Failed to fetch conversations",
      });
    }
  });

  // Create new conversation
  socket.on("newConversation", async (data) => {
    console.log("incoming newConversation: ", data);
    try {
      // If it's a direct conversation, check if it already exists
      if (data.type === "direct") {
        const existingConversation = await Conversation.findOne({
          type: "direct",
          participants: { $all: data.participants, $size: 2 },
        })
          .populate({
            path: "participants",
            select: "name avatar email",
          })
          .lean();

        if (existingConversation) {
          // If conversation exists, just send back to the requester
          socket.emit("newConversation", {
            success: true,
            data: { ...existingConversation, isNew: false },
          });
          return;
        }
      }

      // Create new conversation
      const conversation = await Conversation.create({
        type: data.type,
        participants: data.participants,
        name: data.name || "",
        avatar: data.avatar || "",
        createdBy: socket.data.userId,
      });

      // Get all connected sockets for participants
      const connectedSockets = Array.from(io.sockets.sockets.values()).filter(
        (s) => data.participants.includes(s.data.userId)
      );
      // Have all connected participants join the conversation room
      connectedSockets.forEach((participantSocket) => {
        participantSocket.join(conversation._id.toString());
      });

      // Populate the conversation with participants data
      const populatedConversation = await Conversation.findById(
        conversation._id
      )
        .populate({
          path: "participants",
          select: "name avatar email",
        })
        .lean();

      if (!populatedConversation) {
        throw new Error("Failed to populate conversation");
      }

      // Emit to all participants in the conversation room
      io.to(conversation._id.toString()).emit("newConversation", {
        success: true,
        data: { ...populatedConversation, isNew: true },
      });
    } catch (error) {
      socket.emit("newConversation", {
        success: false,
        msg: "Failed to create conversation",
      });
    }
  });

  // Handle new messages
  socket.on("newMessage", async (data) => {
    try {
      // Debug: Log all rooms this socket has joined
      console.log("incoming newMessage: ", data);

      // Create new message in database
      const message = await Message.create({
        conversationId: data.conversationId,
        senderId: data.sender.id,
        content: data.content,
        attachment: data.attachment,
      });

      // Also try emitting to all sockets in the room
      io.to(data.conversationId).emit("newMessage", {
        success: true,
        data: {
          id: message._id,
          content: data.content,
          sender: {
            id: data.sender.id,
            name: data.sender.name,
            avatar: data.sender.avatar,
          },
          attachment: data.attachment,
          createdAt: new Date().toISOString(),
          conversationId: data.conversationId,
          status: message.status,
        },
      });

      // Update conversation's lastMessage
      await Conversation.findByIdAndUpdate(data.conversationId, {
        lastMessage: message._id,
      });
    } catch (error) {
      console.error("Error in newMessage event:", error);
      socket.emit("newMessage", {
        success: false,
        msg: "Failed to send message",
      });
    }
  });

  socket.on("conversations", (data: { groupId: string; message: string }) => {
    io.emit("conversations", [1, 2, 3, 5]);
  });

  // Get messages for a conversation
  socket.on("getMessages", async (data: { conversationId: string }) => {
    try {
      const messages = await Message.find({
        conversationId: data.conversationId,
      })
        .sort({ createdAt: -1 }) // Sort by creation time, newest first, 1 for oldest first
        .populate<{ senderId: { _id: string; name: string; avatar: string } }>({
          path: "senderId",
          select: "name avatar",
        })
        .lean();

      // Add sender property while keeping senderId
      const messagesWithSender = messages.map((message) => ({
        ...message,
        id: message._id,
        sender: {
          id: message.senderId._id,
          name: message.senderId.name,
          avatar: message.senderId.avatar,
        },
        status: message.status,
      }));

      socket.emit("getMessages", {
        success: true,
        data: messagesWithSender,
      });
    } catch (error) {
      console.error("Error fetching messages:", error);
      socket.emit("getMessages", {
        success: false,
        msg: "Failed to fetch messages",
      });
    }
  });

  // Mark message as delivered
  socket.on("messageDelivered", async (data: { messageId: string; conversationId: string }) => {
    try {
      const userId = socket.data.userId;
      if (!userId) {
        return socket.emit("messageDelivered", {
          success: false,
          msg: "User not authenticated",
        });
      }

      // Find the message and check if it's not from current user
      const message = await Message.findById(data.messageId);
      if (!message || message.senderId.toString() === userId) {
        return;
      }

      // Add user to deliveredTo array if not already there
      const alreadyDelivered = message.deliveredTo.some(
        (delivery: any) => delivery.userId.toString() === userId
      );

      if (!alreadyDelivered) {
        message.deliveredTo.push({
          userId: userId,
          deliveredAt: new Date()
        });

        // Update message status to delivered if not read yet
        if (message.status === 'sent') {
          message.status = 'delivered';
        }
        
        await message.save();

        // Notify the sender about delivery
        io.to(data.conversationId).emit("messageStatusUpdate", {
          messageId: data.messageId,
          status: message.status,
          updatedBy: userId,
        });
      }
    } catch (error) {
      console.error("Error in messageDelivered:", error);
    }
  });

  // Mark message as read
  socket.on("messageRead", async (data: { messageId: string; conversationId: string }) => {
    try {
      const userId = socket.data.userId;
      if (!userId) {
        return socket.emit("messageRead", {
          success: false,
          msg: "User not authenticated",
        });
      }

      // Find the message and check if it's not from current user
      const message = await Message.findById(data.messageId);
      if (!message || message.senderId.toString() === userId) {
        return;
      }

      // Add user to readBy array if not already there
      const alreadyRead = message.readBy.some(
        (read: any) => read.userId.toString() === userId
      );

      if (!alreadyRead) {
        message.readBy.push({
          userId: userId,
          readAt: new Date()
        });

        // Update message status to read
        message.status = 'read';
        
        await message.save();

        // Notify the sender about read receipt
        io.to(data.conversationId).emit("messageStatusUpdate", {
          messageId: data.messageId,
          status: message.status,
          updatedBy: userId,
        });
      }
    } catch (error) {
      console.error("Error in messageRead:", error);
    }
  });

  // Mark all messages in conversation as read
  socket.on("markConversationRead", async (data: { conversationId: string }) => {
    try {
      const userId = socket.data.userId;
      if (!userId) {
        return;
      }

      // Find all unread messages in the conversation that are not from current user
      const messages = await Message.find({
        conversationId: data.conversationId,
        senderId: { $ne: userId },
        'readBy.userId': { $ne: userId }
      });

      const updatedMessageIds: string[] = [];

      for (const message of messages) {
        // Add user to readBy array
        message.readBy.push({
          userId: userId,
          readAt: new Date()
        });

        // Update message status to read
        message.status = 'read';
        await message.save();
        
        updatedMessageIds.push(message._id.toString());
      }

      if (updatedMessageIds.length > 0) {
        // Notify about bulk read status update
        io.to(data.conversationId).emit("bulkMessageStatusUpdate", {
          messageIds: updatedMessageIds,
          status: 'read',
          updatedBy: userId,
        });
      }
    } catch (error) {
      console.error("Error in markConversationRead:", error);
    }
  });

  // Add reaction to message
  socket.on("addReaction", async (data: { messageId: string; emoji: string; conversationId: string }) => {
    try {
      const userId = socket.data.userId;
      if (!userId) {
        return socket.emit("addReaction", {
          success: false,
          msg: "User not authenticated",
        });
      }

      const message = await Message.findById(data.messageId);
      if (!message) {
        return socket.emit("addReaction", {
          success: false,
          msg: "Message not found",
        });
      }

      // Check if user already reacted with this emoji
      const existingReactionIndex = message.reactions.findIndex(
        (reaction: any) => reaction.userId.toString() === userId && reaction.emoji === data.emoji
      );

      if (existingReactionIndex > -1) {
        // Remove existing reaction if same emoji
        message.reactions.splice(existingReactionIndex, 1);
      } else {
        // Remove any other reaction from this user first (only one reaction per user allowed)
        for (let i = message.reactions.length - 1; i >= 0; i--) {
          if (message.reactions[i].userId.toString() === userId) {
            message.reactions.splice(i, 1);
            break;
          }
        }
        
        // Add new reaction
        message.reactions.push({
          userId: userId,
          emoji: data.emoji,
          createdAt: new Date()
        } as any);
      }

      await message.save();

      // Get user info for the reaction
      const User = mongoose.model('User');
      const user = await User.findById(userId).select('name avatar').lean() as any;

      // Notify all participants about the reaction update
      io.to(data.conversationId).emit("reactionUpdate", {
        messageId: data.messageId,
        reactions: message.reactions,
        updatedBy: {
          id: userId,
          name: user?.name,
          avatar: user?.avatar
        }
      });

    } catch (error) {
      console.error("Error in addReaction:", error);
      socket.emit("addReaction", {
        success: false,
        msg: "Failed to add reaction",
      });
    }
  });

  // Remove reaction from message
  socket.on("removeReaction", async (data: { messageId: string; conversationId: string }) => {
    try {
      const userId = socket.data.userId;
      if (!userId) {
        return socket.emit("removeReaction", {
          success: false,
          msg: "User not authenticated",
        });
      }

      const message = await Message.findById(data.messageId);
      if (!message) {
        return socket.emit("removeReaction", {
          success: false,
          msg: "Message not found",
        });
      }

      // Remove user's reaction
      let reactionRemoved = false;
      for (let i = message.reactions.length - 1; i >= 0; i--) {
        if (message.reactions[i].userId.toString() === userId) {
          message.reactions.splice(i, 1);
          reactionRemoved = true;
          break;
        }
      }

      if (reactionRemoved) {
        await message.save();

        // Notify all participants about the reaction update
        io.to(data.conversationId).emit("reactionUpdate", {
          messageId: data.messageId,
          reactions: message.reactions,
          updatedBy: {
            id: userId
          }
        });
      }

    } catch (error) {
      console.error("Error in removeReaction:", error);
      socket.emit("removeReaction", {
        success: false,
        msg: "Failed to remove reaction",
      });
    }
  });

  // Typing indicators
  socket.on("startTyping", (data: { conversationId: string }) => {
    try {
      const userId = socket.data.userId;
      
      if (!userId) {
        return;
      }

      // Emit to all other participants in the conversation
      socket.to(data.conversationId).emit("userStartedTyping", {
        userId,
        conversationId: data.conversationId,
      });
    } catch (error) {
      console.error("Error in startTyping:", error);
    }
  });

  socket.on("stopTyping", (data: { conversationId: string }) => {
    try {
      const userId = socket.data.userId;
      
      if (!userId) {
        return;
      }

      // Emit to all other participants in the conversation
      socket.to(data.conversationId).emit("userStoppedTyping", {
        userId,
        conversationId: data.conversationId,
      });
    } catch (error) {
      console.error("Error in stopTyping:", error);
    }
  });
}
