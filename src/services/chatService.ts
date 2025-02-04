import mongoose from "mongoose";
import MessageModel from "../models/Message.model";
import ConversationModel from "../models/Conversation.model";
import ReportModel from "../models/Report.model";

async function checkConversation(conversationID: string) {
  if (!mongoose.Types.ObjectId.isValid(conversationID)) return null;
  return ConversationModel.findById(conversationID);
}

const createConversation = async (data: any) => {
  const { participants, type, topic, owner } = data;
  const conversationData: any = {
    participants,
    type,
    topic,
    owner: owner || "system",
  };
  if (type === "group" || type === "channel") {
    conversationData.admins = [conversationData.owner];
  }
  return await ConversationModel.create(conversationData);
};

const sendMessage = async (data: any) => {
  const { userID, conversationID, message } = data;
  const convo = await checkConversation(conversationID);
  if (!convo) throw new Error("Conversation not found");
  const newMessage = { userID, conversationID, message, createdAt: new Date(), status: "sent" };
  return await MessageModel.create(newMessage);
};

const sendSecureMessage = async (data: any) => {
  const { userID, conversationID, message, encrypted, encryptionAlgorithm, signature } = data;
  const convo = await checkConversation(conversationID);
  if (!convo) throw new Error("Conversation not found");
  const secureMessage = { userID, conversationID, message, createdAt: new Date(), status: "sent", encrypted, encryptionAlgorithm, signature };
  return await MessageModel.create(secureMessage);
};

const reportMessage = async (data: any) => {
  const { conversationID, messageId, reason } = data;
  return await ReportModel.create({
    conversationID,
    messageId,
    reporter: "system",
    reason,
    createdAt: new Date(),
  });
};

const editMessage = async (data: any) => {
  const { messageId, newMessage } = data;
  return await MessageModel.findByIdAndUpdate(messageId, { message: newMessage, editedAt: new Date() });
};

const deleteMessage = async (data: any) => {
  const { messageId } = data;
  return await MessageModel.findByIdAndDelete(messageId);
};

const forwardMessage = async (data: any) => {
  const { fromConversationID, toConversationID, messageId } = data;
  const originalMessage = await MessageModel.findById(messageId);
  if (!originalMessage) throw new Error("Original message not found");
  const forwardedMessage = {
    userID: originalMessage.userID,
    conversationID: toConversationID,
    message: originalMessage.message,
    createdAt: new Date(),
    status: "sent",
    forwardedFrom: fromConversationID,
  };
  return await MessageModel.create(forwardedMessage);
};

const messageRead = async (data: any) => {
  const { messageId } = data;
  return await MessageModel.findByIdAndUpdate(messageId, {
    status: "read",
    $addToSet: { readBy: "system" },
  });
};

const pinMessage = async (data: any) => {
  const { messageId, pin } = data;
  return await MessageModel.findByIdAndUpdate(messageId, {
    pinned: pin,
    pinnedAt: new Date(),
    pinnedBy: "system",
  });
};

const reactionMessage = async (data: any) => {
  const { messageId, emoji } = data;
  return await MessageModel.findByIdAndUpdate(messageId, {
    $push: { reactions: { emoji, userID: "system" } },
  });
};

const scheduleMessage = async (data: any) => {
  const { userID, conversationID, message, scheduledTime } = data;
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
    }, delay);
  } else {
    const newMessage = { userID, conversationID, message, createdAt: new Date(), status: "sent" };
    await MessageModel.create(newMessage);
  }
};

const unsendMessage = async (data: any) => {
  const { messageId } = data;
  return await MessageModel.findByIdAndDelete(messageId);
};

const sendEphemeralMessage = async (data: any) => {
  const { userID, conversationID, message, expiresIn } = data;
  const convo = await checkConversation(conversationID);
  if (!convo) throw new Error("Conversation not found");
  const ephemeralMessage = {
    userID,
    conversationID,
    message,
    createdAt: new Date(),
    status: "sent",
    ephemeralExpiresAt: new Date(Date.now() + expiresIn)
  };
  await MessageModel.create(ephemeralMessage);
  setTimeout(() => {
    MessageModel.findByIdAndDelete(ephemeralMessage._id);
  }, expiresIn);
};

const sendVoiceMessage = async (data: any) => {
  const { userID, conversationID, message, voiceUrl } = data;
  const voiceMessage = {
    userID,
    conversationID,
    message,
    createdAt: new Date(),
    status: "sent",
    attachments: [{ type: "voice", url: voiceUrl }]
  };
  return await MessageModel.create(voiceMessage);
};

const sendSticker = async (data: any) => {
  const { userID, conversationID, stickerUrl } = data;
  const stickerMessage = {
    userID,
    conversationID,
    message: "",
    createdAt: new Date(),
    status: "sent",
    attachments: [{ type: "sticker", url: stickerUrl }]
  };
  return await MessageModel.create(stickerMessage);
};

const createPoll = async (data: any) => {
  const { userID, conversationID, question, options } = data;
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
  return await MessageModel.create(pollMessage);
};

const votePoll = async (data: any) => {
  const { messageId, optionIndex } = data;
  const message = await MessageModel.findById(messageId);
  if (!message || !message.poll) throw new Error("Poll not found");
  const votes = Array.isArray(message.poll.votes)
    ? message.poll.votes
    : message.poll.options.map(() => 0);
  votes[optionIndex] = (votes[optionIndex] || 0) + 1;
  return await MessageModel.findByIdAndUpdate(messageId, { "poll.votes": votes });
};

export {
  checkConversation,
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
