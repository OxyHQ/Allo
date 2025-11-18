import { useEffect, useState } from 'react';
import { useOxy } from '@oxyhq/services';

/**
 * Hook for typing indicators in a conversation
 */
export const useTypingIndicator = (conversationId?: string) => {
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const { user } = useOxy();

  useEffect(() => {
    if (!conversationId || typeof window === 'undefined') return;

    const handleTypingEvent = (event: CustomEvent) => {
      const data = event.detail as { conversationId: string; userId: string; isTyping: boolean };
      if (data.conversationId === conversationId && data.userId !== user?.id) {
        setTypingUsers((prev) => {
          const next = new Set(prev);
          if (data.isTyping) {
            next.add(data.userId);
            // Auto-remove after 3 seconds
            setTimeout(() => {
              setTypingUsers((current) => {
                const updated = new Set(current);
                updated.delete(data.userId);
                return updated;
              });
            }, 3000);
          } else {
            next.delete(data.userId);
          }
          return next;
        });
      }
    };

    window.addEventListener('typingIndicator', handleTypingEvent as EventListener);

    return () => {
      window.removeEventListener('typingIndicator', handleTypingEvent as EventListener);
    };
  }, [conversationId, user?.id]);

  return Array.from(typingUsers);
};

