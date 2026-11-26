import { useCallback, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useConversation, useConversationActions } from '@allo/react';
import { Badge } from '@oxy.so/bloom/badge';
import { RiUserAddLine } from '@oxy.so/bloom/icons/RiUserAddLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { toast } from '@oxy.so/bloom/toast';

import { useChatContext } from '@/hooks/useChatContext';
import { profileHref } from '@/lib/profile/handle';
import { confirm } from '@oxy.so/bloom/surfaces';
import { logger } from '@/utils/logger';

import { Button as LButton, Header, Icon, ScrollView, Text } from '@oxy.so/bloom-language';
import { Search as LSearch } from '@oxy.so/bloom-language/inputs';
import { List as LList } from '@oxy.so/bloom-language/list';
import { screen } from '@oxy.so/bloom-language/router';

/**
 * `/c/:id/members` — the roster an owner or admin manages.
 *
 * The info panel shows who is in a group; taking somebody out of it is a
 * different act with a different confirmation, so it has its own screen, on
 * Bloom's `List` with its shared person rows and actions.
 */
export default screen(function MembersRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const conversationId = id ?? '';
  const view = useConversation(conversationId);
  const { removeMember } = useConversationActions();
  const ctx = useChatContext(view?.memberAccountIds ?? []);
  const [search, setSearch] = useState('');

  const canManage = view?.myRole === 'owner' || view?.myRole === 'admin';

  const members = useMemo(
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

  return ScrollView(
    LSearch([search, setSearch])
      .label(t('chat.new.search'))
      .onClearText(() => setSearch('')),
    LList(
      members
        .filter((member) =>
          `${member.name} ${member.subtitle ?? ''}`
            .toLocaleLowerCase()
            .includes(search.trim().toLocaleLowerCase()),
        )
        .map((member) => {
          // Leaving has its own confirmation; your row never offers removal.
          const canRemove = canManage && member.id !== ctx.me;
          const href = profileHref(ctx.person(member.id)?.handle);
          const role =
            member.role === 'owner'
              ? t('chat.role.owner')
              : member.role === 'admin'
                ? t('chat.role.admin')
                : undefined;
          return {
            id: member.id,
            person: {
              ...member,
              onAction: canRemove ? () => void remove(member.id) : undefined,
              actionLabel: t('chat.group.removeMember'),
            },
            onPress: href ? () => router.push(href) : undefined,
            // A row's slot takes an element: Bloom's Badge itself, no language root per row.
            trailing: role ? <Badge content={role} /> : undefined,
            actions: canRemove
              ? [
                  {
                    key: 'remove',
                    label: t('chat.group.removeMember'),
                    icon: RiDeleteBinLine,
                    tone: 'negative' as const,
                  },
                ]
              : undefined,
            onAction: canRemove ? () => void remove(member.id) : undefined,
          };
        }),
    )
      .testID('conversation-members')
      .headerContent(
        canManage
          ? LButton(Icon(RiUserAddLine), Text(t('chat.group.addMember'))).onPress(() =>
              router.push(`/new?addTo=${conversationId}`),
            )
          : undefined,
      ),
  )
    .keyboardTaps('handled')
    .contentView((v) => v.padding('horizontal', 'lg').padding('bottom', '3xl'))
    .screenScroll('content')
    .header(Header(t('chat.details.participants')).inPage());
});
