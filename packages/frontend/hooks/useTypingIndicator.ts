import { useEffect, useState, useRef } from 'react';
import { useOxy } from '@oxyhq/services';

/**
 * Hook for typing indicators in a conversation
 * Properly tracks and cleans up all timeouts to prevent memory leaks
 */
export const useTypingIndicator = (conversationId?: string) => {
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const { user } = useOxy();
  // Track all auto-remove timeouts for proper cleanup
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    // Check if window.addEventListener exists (web only, not React Native)
    if (!conversationId || typeof window === 'undefined' || !window.addEventListener) return;

    const handleTypingEvent = (event: CustomEvent) => {
      const data = event.detail as { conversationId: string; userId: string; isTyping: boolean };
      if (data.conversationId === conversationId && data.userId !== user?.id) {
        // Clear any existing timeout for this user
        const existingTimeout = timeoutsRef.current.get(data.userId);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          timeoutsRef.current.delete(data.userId);
        }

        setTypingUsers((prev) => {
          const next = new Set(prev);
          if (data.isTyping) {
            next.add(data.userId);
            // Auto-remove after 6 seconds (longer than sender's 5s throttle)
            const timeout = setTimeout(() => {
              setTypingUsers((current) => {
                const updated = new Set(current);
                updated.delete(data.userId);
                return updated;
              });
              timeoutsRef.current.delete(data.userId);
            }, 6000);
            timeoutsRef.current.set(data.userId, timeout);
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
      // Clean up ALL timeouts on unmount or conversation change
      timeoutsRef.current.forEach((timeout) => clearTimeout(timeout));
      timeoutsRef.current.clear();
      setTypingUsers(new Set());
    };
  }, [conversationId, user?.id]);

  return Array.from(typingUsers);
};
