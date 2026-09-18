import { Redirect, useLocalSearchParams } from 'expo-router';

/** `/u/:id`, an old link shape: a conversation now lives at `/c/:id`. */
export default function LegacyUserConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!id) return null;
  return <Redirect href={`/c/${id}`} />;
}
