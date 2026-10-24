import { useStatuses } from '@allo/react';
import { useScreenBack } from '@oxy.so/bloom/screen';
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import NotFoundScreen from '@/components/NotFoundScreen';
import { StoryViewerScreen } from '@/components/phase2/StoryViewerScreen';
import { statusAuthors } from '@/lib/statuses';

/**
 * `/updates/:accountId` — one person's status updates, then the next person's.
 * Opened from the Status page and from the stories row on the chats page.
 */
export default function StoryRoute() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const statuses = useStatuses();
  const back = useScreenBack();
  const authors = useMemo(() => statusAuthors(statuses.all), [statuses.all]);
  if (!authors.some((author) => author.accountId === accountId)) return <NotFoundScreen />;
  return (
    <StoryViewerScreen
      authors={authors}
      startAccountId={accountId ?? ''}
      onClose={() => back?.()}
    />
  );
}
