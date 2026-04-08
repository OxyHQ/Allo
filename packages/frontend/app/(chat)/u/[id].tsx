import { useEffect } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";

/**
 * Legacy route handler for /u/:id
 *
 * This route is deprecated. It now simply redirects to /c/:id
 * which handles both direct and group conversations.
 *
 * Kept for backwards compatibility.
 */
export default function LegacyUserConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    if (id) {
      // Redirect to unified conversation route
      router.replace(`/c/${id}` as any);
    }
  }, [id, router]);

  return null;
}
