import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { usePerson } from '@/hooks/usePerson';
import type { Conversation } from '@/lib/chat/model';

/**
 * The words for a conversation whose members have not all set up Allo.
 *
 * The SDK reports who is unreachable as `unreachableMemberAccountIds` (see
 * `lib/chat/model.ts`) and holds an own message with `holdReason` while nobody
 * else could read it. Three lines come out of that, each `null` when there is
 * nothing to say:
 *
 * - `banner`, above the composer: what is going on and that typing is fine.
 * - `hold`, the accessible name of a held echo's clock.
 * - `waiting`, the list row's subtitle in place of the preview.
 *
 * A direct message names the person; a group counts them, because the hold
 * only happens when EVERY other member is unreachable and a list of names would
 * not fit on a banner. The name comes through the people layer and an account
 * id never reaches the screen: while the lookup is out, or if Oxy does not know
 * the account, the line says "this person" instead.
 */
export interface UnreachableCopy {
  banner: string | null;
  hold: string | null;
  waiting: string | null;
}

const NONE: UnreachableCopy = { banner: null, hold: null, waiting: null };

export function useUnreachableMembers(conversation: Pick<Conversation, 'type' | 'unreachableMemberAccountIds'> | null | undefined): UnreachableCopy {
  const ids = conversation?.unreachableMemberAccountIds;
  const count = ids?.length ?? 0;
  const isGroup = conversation?.type === 'group';
  const person = usePerson(!isGroup && count === 1 ? ids?.[0] : undefined);
  const name = person?.displayName;
  const { t } = useTranslation();

  return useMemo<UnreachableCopy>(() => {
    if (count === 0) return NONE;
    if (isGroup) {
      return {
        banner: t('chat.unreachable.group', "{{count}} members haven't set up Allo yet; they will receive new messages when they join.", { count }),
        hold: t('chat.hold.group', 'Waiting for {{count}} members to join', { count }),
        waiting: t('chat.waiting.group', 'Waiting for {{count}} members', { count }),
      };
    }
    if (name) {
      return {
        banner: t('chat.unreachable.dm', "{{name}} hasn't set up Allo yet. Your messages will be delivered when they join.", { name }),
        hold: t('chat.hold.dm', 'Waiting for {{name}} to join', { name }),
        waiting: t('chat.waiting.dm', 'Waiting for {{name}}', { name }),
      };
    }
    return {
      banner: t('chat.unreachable.dmUnnamed', "This person hasn't set up Allo yet. Your messages will be delivered when they join."),
      hold: t('chat.hold.dmUnnamed', 'Waiting for this person to join'),
      waiting: t('chat.waiting.dmUnnamed', 'Waiting for this person'),
    };
  }, [count, isGroup, name, t]);
}
