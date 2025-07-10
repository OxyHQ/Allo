import { getSocket, connectSocket } from "./socket";

export const testSocket = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("testSocket", payload);
  } else if (typeof payload == "function") {
    socket.on("testSocket", payload);
  } else {
    socket.emit("testSocket", payload);
  }
};

export const conversations = (payload: any, off: boolean = false) => {
  const socket = getSocket();

  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("conversations", payload);
  } else if (typeof payload == "function") {
    socket.on("conversations", payload);
  } else {
    socket.emit("conversations", payload);
  }
};

export const updateProfile = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("updateProfile", payload);
  } else if (typeof payload == "function") {
    socket.on("updateProfile", payload);
  } else {
    socket.emit("updateProfile", payload);
  }
};

export const getContacts = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("getContacts", payload);
  } else if (typeof payload == "function") {
    socket.on("getContacts", payload);
  } else {
    socket.emit("getContacts", payload);
  }
};

export const newConversation = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("newConversation", payload);
  } else if (typeof payload == "function") {
    socket.on("newConversation", payload);
  } else {
    socket.emit("newConversation", payload);
  }
};

export const getConversations = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("getConversations", payload);
  } else if (typeof payload == "function") {
    socket.on("getConversations", payload);
  } else {
    socket.emit("getConversations");
  }
};

export const newMessage = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("newMessage", payload);
  } else if (typeof payload == "function") {
    socket.on("newMessage", payload);
  } else {
    socket.emit("newMessage", payload);
  }
};

export const getMessages = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("getMessages", payload);
  } else if (typeof payload == "function") {
    socket.on("getMessages", payload);
  } else {
    socket.emit("getMessages", payload);
  }
};

export const messageDelivered = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("messageDelivered", payload);
  } else if (typeof payload == "function") {
    socket.on("messageDelivered", payload);
  } else {
    socket.emit("messageDelivered", payload);
  }
};

export const messageRead = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("messageRead", payload);
  } else if (typeof payload == "function") {
    socket.on("messageRead", payload);
  } else {
    socket.emit("messageRead", payload);
  }
};

export const messageStatusUpdate = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("messageStatusUpdate", payload);
  } else if (typeof payload == "function") {
    socket.on("messageStatusUpdate", payload);
  } else {
    socket.emit("messageStatusUpdate", payload);
  }
};

export const markConversationRead = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("markConversationRead", payload);
  } else if (typeof payload == "function") {
    socket.on("markConversationRead", payload);
  } else {
    socket.emit("markConversationRead", payload);
  }
};

export const bulkMessageStatusUpdate = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("bulkMessageStatusUpdate", payload);
  } else if (typeof payload == "function") {
    socket.on("bulkMessageStatusUpdate", payload);
  } else {
    socket.emit("bulkMessageStatusUpdate", payload);
  }
};

export const addReaction = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("addReaction", payload);
  } else if (typeof payload == "function") {
    socket.on("addReaction", payload);
  } else {
    socket.emit("addReaction", payload);
  }
};

export const removeReaction = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("removeReaction", payload);
  } else if (typeof payload == "function") {
    socket.on("removeReaction", payload);
  } else {
    socket.emit("removeReaction", payload);
  }
};

export const reactionUpdate = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("reactionUpdate", payload);
  } else if (typeof payload == "function") {
    socket.on("reactionUpdate", payload);
  } else {
    socket.emit("reactionUpdate", payload);
  }
};

// Typing indicators
export const startTyping = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("startTyping", payload);
  } else if (typeof payload == "function") {
    socket.on("startTyping", payload);
  } else {
    socket.emit("startTyping", payload);
  }
};

export const stopTyping = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("stopTyping", payload);
  } else if (typeof payload == "function") {
    socket.on("stopTyping", payload);
  } else {
    socket.emit("stopTyping", payload);
  }
};

export const userStartedTyping = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("userStartedTyping", payload);
  } else if (typeof payload == "function") {
    socket.on("userStartedTyping", payload);
  } else {
    socket.emit("userStartedTyping", payload);
  }
};

export const userStoppedTyping = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("userStoppedTyping", payload);
  } else if (typeof payload == "function") {
    socket.on("userStoppedTyping", payload);
  } else {
    socket.emit("userStoppedTyping", payload);
  }
};

// Call functionality
export const initiateCall = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("initiateCall", payload);
  } else if (typeof payload == "function") {
    socket.on("initiateCall", payload);
  } else {
    socket.emit("initiateCall", payload);
  }
};

export const incomingCall = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("incomingCall", payload);
  } else if (typeof payload == "function") {
    socket.on("incomingCall", payload);
  } else {
    socket.emit("incomingCall", payload);
  }
};

export const callInitiated = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("callInitiated", payload);
  } else if (typeof payload == "function") {
    socket.on("callInitiated", payload);
  } else {
    socket.emit("callInitiated", payload);
  }
};

export const answerCall = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("answerCall", payload);
  } else if (typeof payload == "function") {
    socket.on("answerCall", payload);
  } else {
    socket.emit("answerCall", payload);
  }
};

export const callAnswered = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("callAnswered", payload);
  } else if (typeof payload == "function") {
    socket.on("callAnswered", payload);
  } else {
    socket.emit("callAnswered", payload);
  }
};

export const endCall = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("endCall", payload);
  } else if (typeof payload == "function") {
    socket.on("endCall", payload);
  } else {
    socket.emit("endCall", payload);
  }
};

export const callEnded = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("callEnded", payload);
  } else if (typeof payload == "function") {
    socket.on("callEnded", payload);
  } else {
    socket.emit("callEnded", payload);
  }
};

export const webrtcSignal = (payload: any, off: boolean = false) => {
  const socket = getSocket();
  if (!socket) {
    console.warn("Socket is not connected. ");
    return;
  }
  if (off) {
    socket.off("webrtcSignal", payload);
  } else if (typeof payload == "function") {
    socket.on("webrtcSignal", payload);
  } else {
    socket.emit("webrtcSignal", payload);
  }
};
