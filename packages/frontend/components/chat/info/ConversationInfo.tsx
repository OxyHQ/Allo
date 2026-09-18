import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useConversation, useConversationActions, useTimeline } from '@allo/react';
import { GroupAvatar } from '@oxy.so/bloom/chat-list';
import { MemberList, type MemberListItem } from '@oxy.so/bloom/chat-people';
import { ChatInfoPanel, type ChatInfoAction, type ChatInfoPanelVariant, type ChatInfoTab } from '@oxy.so/bloom/chat-screen';
import { Button } from '@oxy.so/bloom/button';
import { RiFileTextLine, RiImageLine, RiUserLine } from '@oxy.so/bloom/icons';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';

import { SharedFiles, SharedMedia } from '@/components/chat/info/SharedAttachments';
import { useChatContext } from '@/hooks/useChatContext';
import { conversationAvatar, conversationFaces, conversationTitle } from '@/lib/chat/model';
import { profileHref } from '@/lib/profile/handle';
import { confirmDialog } from '@/utils/alerts';
import { logger } from '@/utils/logger';

interface ConversationInfoProps {
  conversationId: string;
  variant: ChatInfoPanelVariant;
  onClose: () => void;
}

/**
 * Who a conversation is with, and what can be done to it: the person's profile
 * for a DM; the name and the members for a group (an owner or admin adds and
 * removes); leaving, for both.
 */
export function ConversationInfo({ conversationId, variant, onClose }: ConversationInfoProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const view = useConversation(conversationId);
  const { items } = useTimeline(conversationId);
  const { leave, rename, removeMember } = useConversationActions();
  const ctx = useChatContext(view?.memberAccountIds ?? []);
  // The field follows the title until it is edited, and again whenever the title changes.
  const [name, setName] = useState(view?.title ?? '');
  const [shownTitle, setShownTitle] = useState(view?.title);
  if (view?.title !== shownTitle) {
    setShownTitle(view?.title);
    setName(view?.title ?? '');
  }

  const isGroup = view?.kind === 'group';
  const canManage = isGroup && (view?.myRole === 'owner' || view?.myRole === 'admin');
  const other = view?.kind === 'dm' ? view.memberAccountIds.find((id) => id !== ctx.me) : undefined;
  const otherHandle = other ? ctx.person(other)?.handle : undefined;

  const openProfile = useCallback(
    (accountId: string) => {
      const href = profileHref(ctx.person(accountId)?.handle);
      if (href) router.push(href);
    },
    [ctx, router],
  );

  const members = useMemo<MemberListItem[]>(
    () =>
      (view?.memberAccountIds ?? []).map((id) => {
        const person = ctx.person(id);
        return {
          id,
          // Your own row carries no remove action: leaving is a different thing, with its own confirmation.
          name: id === ctx.me ? t('chat.you') : (person?.displayName ?? ''),
          avatar: person?.avatar,
          subtitle: person?.handle ? `@${person.handle}` : undefined,
          role: id === ctx.me ? view?.myRole : undefined,
        };
      }),
    [ctx, t, view?.memberAccountIds, view?.myRole],
  );

  const saveName = useCallback(async () => {
    const next = name.trim();
    if (!view || !next || next === view.title) return;
    try {
      await rename(view.id, next);
      toast.success(t('chat.group.renamed'));
    } catch (error) {
      logger.error('[ConversationInfo] rename failed', error);
      toast.error(t('chat.group.renameFailed'));
    }
  }, [name, rename, t, view]);

  const confirmRemove = useCallback(
    async (accountId: string) => {
      if (!view) return;
      const ok = await confirmDialog({
        title: t('chat.group.removeMember'),
        message: t('chat.group.removeMemberConfirm'),
        okText: t('chat.group.removeMember'),
        cancelText: t('common.cancel'),
        destructive: true,
      });
      if (!ok) return;
      try {
        await removeMember(view.id, accountId);
        toast.success(t('chat.group.memberRemoved'));
      } catch (error) {
        logger.error('[ConversationInfo] remove failed', error);
        toast.error(t('chat.group.removeFailed'));
      }
    },
    [removeMember, t, view],
  );

  const confirmLeave = useCallback(async () => {
    if (!view) return;
    const ok = await confirmDialog({
      title: isGroup ? t('chat.leave.group') : t('chat.leave.conversation'),
      message: t('chat.leave.confirm'),
      okText: t('chat.leave.action'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await leave(view.id);
      onClose();
      router.replace('/');
    } catch (error) {
      logger.error('[ConversationInfo] leave failed', error);
      toast.error(t('chat.leave.failed'));
    }
  }, [isGroup, leave, onClose, router, t, view]);

  if (!view) return null;

  const title = conversationTitle(view, ctx);
  const faces = conversationFaces(view, ctx);
  const tabs: ChatInfoTab[] = [
    {
      value: 'media',
      label: t('chat.details.media'),
      icon: RiImageLine,
      content: <SharedMedia items={items} onOpen={() => router.push(`/c/${view.id}`)} />,
    },
    {
      value: 'files',
      label: t('chat.details.files'),
      icon: RiFileTextLine,
      content: <SharedFiles items={items} />,
    },
  ];
  const actions: ChatInfoAction[] = other
    ? [{ key: 'profile', label: t('chat.info.profile'), icon: RiUserLine, onPress: () => openProfile(other) }]
    : [];

  return (
    <ChatInfoPanel
      variant={variant}
      title={isGroup ? t('chat.details.groupInfo') : t('chat.details.contactInfo')}
      onClose={onClose}
      closeLabel={t('common.close')}
      avatar={faces ? <GroupAvatar faces={faces} size={96} /> : undefined}
      avatarSource={faces ? undefined : conversationAvatar(view, ctx)}
      name={title}
      handle={otherHandle ? `@${otherHandle}` : undefined}
      meta={isGroup ? t('chat.members', { count: view.memberAccountIds.length }) : undefined}
      actions={actions}
      settingsTitle={canManage ? t('chat.group.name') : undefined}
      settings={
        canManage ? (
          <View style={styles.rename}>
            <TextFieldInput
              label={t('chat.group.name')}
              value={name}
              onChangeText={setName}
              onBlur={() => void saveName()}
              onSubmitEditing={() => void saveName()}
              returnKeyType="done"
              maxLength={128}
            />
          </View>
        ) : undefined
      }
      tabs={tabs}
    >
      {isGroup && (
        <MemberList
          title={t('chat.details.participants')}
          members={members}
          onMemberPress={openProfile}
          onRemove={canManage ? (id) => (id === ctx.me ? undefined : void confirmRemove(id)) : undefined}
          onAddMembers={canManage ? () => router.push(`/new?addTo=${view.id}`) : undefined}
          addMembersLabel={t('chat.group.addMember')}
          labels={{ remove: t('chat.group.removeMember'), owner: t('chat.role.owner'), admin: t('chat.role.admin') }}
        />
      )}
      <View style={styles.leave}>
        <Button variant="destructive" size="medium" onPress={() => void confirmLeave()}>
          {isGroup ? t('chat.leave.group') : t('chat.leave.conversation')}
        </Button>
      </View>
    </ChatInfoPanel>
  );
}

const styles = StyleSheet.create({
  rename: { paddingHorizontal: 16 },
  leave: { padding: 16 },
});
