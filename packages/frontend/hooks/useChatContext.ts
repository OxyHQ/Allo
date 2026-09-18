import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';

import { personFromEntity } from '@/lib/allo/people';
import type { ChatContext } from '@/lib/chat/model';
import { usePeople } from '@/hooks/usePerson';
import { useUsersStore } from '@/stores/usersStore';

/**
 * What the chat projections need to name people and print times, for a screen
 * that shows `accountIds`. Asks the people layer for all of them at once (one
 * coalesced lookup) and changes identity when any of them is resolved, so a
 * memoized projection recomputes exactly then.
 */
export function useChatContext(accountIds: readonly string[]): ChatContext {
  const { user } = useOxy();
  const { t, i18n } = useTranslation();
  usePeople(accountIds);
  const usersById = useUsersStore((state) => state.usersById);

  return useMemo(
    () => ({
      me: user?.id,
      person: (accountId: string) => personFromEntity(usersById[accountId]?.data),
      t,
      locale: i18n.language,
      now: new Date(),
    }),
    [user?.id, usersById, t, i18n.language],
  );
}
