import { Redirect, useLocalSearchParams } from "expo-router";

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

  if (!id) {
    return null;
  }

  return <Redirect href={`/c/${id}`} />;
}
