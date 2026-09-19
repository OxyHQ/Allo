import React, { useCallback, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useConversation, useConversationActions } from '@allo/react';
import { MemberList, type MemberListItem } from '@oxy.so/bloom/chat-people';
import { toast } from '@oxy.so/bloom/toast';

import { Page } from '@/components/shell/Page';
import { useChatContext } from '@/hooks/useChatContext';
import { profileHref } from '@/lib/profile/handle';
import { confirm } from '@oxy.so/bloom/surfaces';
import { logger } from '@/utils/logger';

/**
 * `/c/:id/members` — the roster an owner or admin manages.
 *
 * The info panel shows who is in a group; taking somebody out of it is a
 * different act with a different confirmation, so it has its own screen, on
 * Bloom's `MemberList` (which owns the per-row actions and the search).
 */
export default function MembersRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const conversationId = id ?? '';
  const view = useConversation(conversationId);
  const { removeMember } = useConversationActions();
  const ctx = useChatContext(view?.memberAccountIds ?? []);
  const [search, setSearch] = useState('');

  const canManage = view?.myRole === 'owner' || view?.myRole === 'admin';

  const members = useMemo<MemberListItem[]>(
    () =>
      (view?.memberAccountIds ?? []).map((accountId) => {
        const person = ctx.person(accountId);
        return {
          id: accountId,
          name: accountId === ctx.me ? t('chat.you') : (person?.displayName ?? ''),
          avatar: person?.avatar,
          subtitle: person?.handle ? `@${person.handle}` : undefined,
          role: accountId === ctx.me ? view?.myRole : undefined,
        };
      }),
    [ctx, t, view?.memberAccountIds, view?.myRole],
  );

  const remove = useCallback(
    async (accountId: string) => {
      const ok = await confirm({
        title: t('chat.group.removeMember'),
        description: t('chat.group.removeMemberConfirm'),
        confirmLabel: t('chat.group.removeMember'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await removeMember(conversationId, accountId);
        toast.success(t('chat.group.memberRemoved'));
      } catch (error) {
        logger.error('[Members] remove failed', error);
        toast.error(t('chat.group.removeFailed'));
      }
    },
    [conversationId, removeMember, t],
  );

  return (
    <Page title={t('chat.details.participants')} back="always" scroll={false}>
      <MemberList
        members={members}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={t('chat.new.search')}
        onMemberPress={(accountId) => {
          const href = profileHref(ctx.person(accountId)?.handle);
          if (href) router.push(href);
        }}
        // Leaving is its own action, with its own confirmation: your row offers no removal.
        onRemove={canManage ? (accountId) => (accountId === ctx.me ? undefined : void remove(accountId)) : undefined}
        onAddMembers={canManage ? () => router.push(`/new?addTo=${conversationId}`) : undefined}
        addMembersLabel={t('chat.group.addMember')}
        labels={{ remove: t('chat.group.removeMember'), owner: t('chat.role.owner'), admin: t('chat.role.admin') }}
      />
    </Page>
  );
}
