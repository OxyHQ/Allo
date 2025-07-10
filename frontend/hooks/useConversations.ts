import { useEffect, useState, useCallback } from "react";
import {
  getConversations,
  newConversation,
  newMessage,
} from "@/socket/socketEvents";
import { ConversationProps, ResponseProps } from "@/types";

interface UseConversationsResult {
  conversations: ConversationProps[];
  loading: boolean;
  directConversations: ConversationProps[];
  groupConversations: ConversationProps[];
}

const useConversations = (): UseConversationsResult => {
  const [conversations, setConversations] = useState<ConversationProps[]>([]);
  const [loading, setLoading] = useState(true);

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
      setConversations((prev) =>
        prev.map((item) =>
          item._id === conversationId
            ? { ...item, lastMessage: res.data }
            : item
        )
      );
    }
  }, []);

  // Handler for new conversations
  const newConversationHandler = useCallback((res: ResponseProps) => {
    if (res?.success && res.data?.isNew) {
      setConversations((prev) => [...prev, res.data]);
    }
  }, []);

  useEffect(() => {
    getConversations(processConversations);
    newMessage(newMessageHandler);
    newConversation(newConversationHandler);
    getConversations(null); // Possibly triggers a refresh

    return () => {
      getConversations(processConversations, true);
      newMessage(newMessageHandler, true);
      newConversation(newConversationHandler, true);
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