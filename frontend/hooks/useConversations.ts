import { useEffect, useState, useCallback } from "react";
import {
  getConversations,
  newConversation,
  newMessage,
  messageStatusUpdate,
  bulkMessageStatusUpdate,
} from "@/socket/socketEvents";
import { ConversationProps, ResponseProps } from "@/types";
import { useAuth } from "@/contexts/authContext";

interface UseConversationsResult {
  conversations: ConversationProps[];
  loading: boolean;
  directConversations: ConversationProps[];
  groupConversations: ConversationProps[];
}

const useConversations = (): UseConversationsResult => {
  const [conversations, setConversations] = useState<ConversationProps[]>([]);
  const [loading, setLoading] = useState(true);
  const { user: currentUser } = useAuth();

  // Handler for initial fetch
  const processConversations = useCallback((res: ResponseProps) => {
    setLoading(false);
    if (res?.success) {
      setConversations(res.data);
    }
  }, []);

  // Handler for new messages
  const newMessageHandler = useCallback((res: ResponseProps) => {
    if (res?.success) {
      const conversationId = res.data.conversationId;
      const isFromCurrentUser = res.data.sender.id === currentUser?.id;
      
      setConversations((prev) =>
        prev.map((item) =>
          item._id === conversationId
            ? { 
                ...item, 
                lastMessage: res.data,
                // Increment unread count only if message is from another user
                unreadCount: isFromCurrentUser 
                  ? (item.unreadCount || 0) 
                  : (item.unreadCount || 0) + 1
              }
            : item
        )
      );
    }
  }, [currentUser?.id]);

  // Handler for new conversations
  const newConversationHandler = useCallback((res: ResponseProps) => {
    if (res?.success && res.data?.isNew) {
      setConversations((prev) => [...prev, res.data]);
    }
  }, []);

  // Handler for message status updates (when messages are read)
  const messageStatusUpdateHandler = useCallback((data: { messageId: string; status: string; updatedBy: string; conversationId?: string }) => {
    if (data.status === 'read' && data.updatedBy === currentUser?.id) {
      // When current user reads a message, decrease unread count
      setConversations((prev) =>
        prev.map((item) =>
          item._id === data.conversationId || item.lastMessage?._id === data.messageId
            ? { ...item, unreadCount: Math.max(0, (item.unreadCount || 0) - 1) }
            : item
        )
      );
    }
  }, [currentUser?.id]);

  // Handler for bulk message status updates (when conversation is marked as read)
  const bulkMessageStatusUpdateHandler = useCallback((data: { messageIds: string[]; status: string; updatedBy: string; conversationId?: string }) => {
    if (data.status === 'read' && data.updatedBy === currentUser?.id) {
      // When current user marks conversation as read, reset unread count to 0
      setConversations((prev) =>
        prev.map((item) =>
          item._id === data.conversationId
            ? { ...item, unreadCount: 0 }
            : item
        )
      );
    }
  }, [currentUser?.id]);

  useEffect(() => {
    getConversations(processConversations);
    newMessage(newMessageHandler);
    newConversation(newConversationHandler);
    messageStatusUpdate(messageStatusUpdateHandler);
    bulkMessageStatusUpdate(bulkMessageStatusUpdateHandler);
    getConversations(null); // Possibly triggers a refresh

    return () => {
      getConversations(processConversations, true);
      newMessage(newMessageHandler, true);
      newConversation(newConversationHandler, true);
      messageStatusUpdate(messageStatusUpdateHandler, true);
      bulkMessageStatusUpdate(bulkMessageStatusUpdateHandler, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Memoized sorted lists
  const directConversations = conversations
    .filter((item) => item.type === "direct")
    .sort((a, b) => {
      const aDate = a?.lastMessage?.createdAt || a.createdAt;
      const bDate = b?.lastMessage?.createdAt || b.createdAt;
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    });

  const groupConversations = conversations
    .filter((item) => item.type === "group")
    .sort((a, b) => {
      const aDate = a?.lastMessage?.createdAt || a.createdAt;
      const bDate = b?.lastMessage?.createdAt || b.createdAt;
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    });

  return {
    conversations,
    loading,
    directConversations,
    groupConversations,
  };
};

export default useConversations; 