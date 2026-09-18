import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useConversation, useConversationActions, useTimeline } from '@allo/react';
import { GroupAvatar } from '@oxy.so/bloom/chat-list';
import {
  ChatInfoPanel,
  type ChatInfoAction,
  type ChatInfoPanelVariant,
  type ChatInfoTab,
  type ChatMember,
} from '@oxy.so/bloom/chat-screen';
import {
  RiDeleteBinLine,
  RiDoorOpenLine,
  RiFileTextLine,
  RiForbidLine,
  RiGroupLine,
  RiImageLine,
  RiLink,
  RiLock2Line,
  RiMicLine,
  RiSearchLine,
  RiSpamLine,
  RiUserAddLine,
  RiUserLine,
} from '@oxy.so/bloom/icons';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';

import { countOf, SharedFiles, SharedLinks, SharedMedia, SharedVoice } from '@/components/chat/info/SharedAttachments';
import { useChatContext } from '@/hooks/useChatContext';
import { usePerson } from '@/hooks/usePerson';
import { conversationAvatar, conversationFaces, conversationTitle } from '@/lib/chat/model';
import { report } from '@/lib/moderation/report';
import { addModeratedUser } from '@/lib/privacy/api';
import { profileHref } from '@/lib/profile/handle';
import { confirmDialog } from '@/utils/alerts';
import { logger } from '@/utils/logger';

interface ConversationInfoProps {
  conversationId: string;
  variant: ChatInfoPanelVariant;
  onClose: () => void;
  /** Opens search over this conversation, in the screen that owns the transcript. */
  onSearch?: () => void;
}

/**
 * WHO A CONVERSATION IS WITH, and what can be done to it — Bloom's
 * `ChatInfoPanel`, composed the way its own story composes it: the identity
 * block, the action tiles, the settings group, the shared-content tabs, the
 * roster, and the destructive actions last.
 *
 * Every row is backed by something. The tabs count what the loaded history
 * actually holds; blocking goes to Oxy and reporting to the moderation
 * endpoint; and nothing here claims what the platform does not have — no calls,
 * no per-conversation mute, no disappearing messages.
 */
export function ConversationInfo({ conversationId, variant, onClose, onSearch }: ConversationInfoProps) {
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const view = useConversation(conversationId);
  const { items } = useTimeline(conversationId);
  const { leave, rename } = useConversationActions();
  const ctx = useChatContext(view?.memberAccountIds ?? []);
  const [memberQuery, setMemberQuery] = useState('');

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
  const person = usePerson(other);

  const openProfile = useCallback(
    (accountId: string) => {
      const href = profileHref(ctx.person(accountId)?.handle);
      if (href) router.push(href);
    },
    [ctx, router],
  );

  const members = useMemo<ChatMember[]>(() => {
    const needle = memberQuery.trim().toLocaleLowerCase();
    return (view?.memberAccountIds ?? [])
      .map((id) => {
        const member = ctx.person(id);
        return {
          id,
          name: id === ctx.me ? t('chat.you') : (member?.displayName ?? ''),
          source: member?.avatar,
          role: id === ctx.me ? view?.myRole : undefined,
          subtitle: member?.handle ? `@${member.handle}` : undefined,
        };
      })
      .filter((member) => !needle || member.name.toLocaleLowerCase().includes(needle));
  }, [ctx, memberQuery, t, view?.memberAccountIds, view?.myRole]);

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

  const confirmBlock = useCallback(async () => {
    if (!other) return;
    const ok = await confirmDialog({
      title: t('chat.block.title'),
      message: t('chat.block.confirm'),
      okText: t('chat.block.title'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await addModeratedUser('blocks', other);
      toast.success(t('settings.privacy.userBlocked'));
    } catch (error) {
      logger.error('[ConversationInfo] block failed', error);
      toast.error(t('settings.privacy.failedToBlockUser'));
    }
  }, [other, t]);

  const confirmReport = useCallback(async () => {
    if (!other) return;
    const ok = await confirmDialog({
      title: t('chat.report.title'),
      message: t('chat.report.confirm'),
      okText: t('chat.report.title'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await report('user', other);
      toast.success(t('chat.report.sent'));
    } catch (error) {
      logger.error('[ConversationInfo] report failed', error);
      toast.error(t('chat.report.failed'));
    }
  }, [other, t]);

  if (!view) return null;

  const title = conversationTitle(view, ctx);
  const faces = conversationFaces(view, ctx);
  const icon = { width: 20, height: 20, fill: theme.colors.textSecondary };

  const actions: ChatInfoAction[] = [
    ...(other
      ? [{ key: 'profile', label: t('chat.info.profile'), icon: RiUserLine, onPress: () => openProfile(other) }]
      : []),
    ...(onSearch ? [{ key: 'search', label: t('chat.info.search'), icon: RiSearchLine, onPress: onSearch }] : []),
    ...(canManage
      ? [
          {
            key: 'add',
            label: t('chat.group.addMember'),
            icon: RiUserAddLine,
            onPress: () => router.push(`/new?addTo=${view.id}`),
          },
          {
            key: 'members',
            label: t('chat.info.manageMembers'),
            icon: RiGroupLine,
            onPress: () => router.push(`/c/${view.id}/members`),
          },
        ]
      : []),
  ];

  const tabs: ChatInfoTab[] = [
    {
      value: 'media',
      label: t('chat.details.media'),
      icon: RiImageLine,
      count: countOf(items, ['image', 'video']),
      content: <SharedMedia items={items} />,
    },
    {
      value: 'files',
      label: t('chat.details.files'),
      icon: RiFileTextLine,
      count: countOf(items, ['file']),
      content: <SharedFiles items={items} />,
    },
    {
      value: 'links',
      label: t('chat.details.links'),
      icon: RiLink,
      content: <SharedLinks items={items} />,
    },
    {
      value: 'voice',
      label: t('chat.details.voice'),
      icon: RiMicLine,
      count: countOf(items, ['voice', 'audio']),
      content: <SharedVoice items={items} />,
    },
  ];

  const destructiveActions: ChatInfoAction[] = [
    ...(other
      ? [
          {
            key: 'block',
            label: t('chat.block.title'),
            icon: RiForbidLine,
            tone: 'negative' as const,
            onPress: () => void confirmBlock(),
          },
          {
            key: 'report',
            label: t('chat.report.title'),
            icon: RiSpamLine,
            tone: 'negative' as const,
            onPress: () => void confirmReport(),
          },
        ]
      : []),
    {
      key: 'leave',
      label: isGroup ? t('chat.leave.group') : t('chat.leave.conversation'),
      icon: isGroup ? RiDoorOpenLine : RiDeleteBinLine,
      tone: 'negative',
      onPress: () => void confirmLeave(),
    },
  ];

  return (
    <ChatInfoPanel
      variant={variant}
      title={isGroup ? t('chat.details.groupInfo') : t('chat.details.contactInfo')}
      onClose={onClose}
      closeLabel={t('common.close')}
      avatar={faces ? <GroupAvatar faces={faces} size={96} /> : undefined}
      avatarSource={faces ? undefined : conversationAvatar(view, ctx)}
      name={title}
      handle={
        isGroup
          ? t('chat.members', { count: view.memberAccountIds.length })
          : person?.handle
            ? `@${person.handle}`
            : undefined
      }
      bio={isGroup ? undefined : person?.bio}
      settingsTitle={t('chat.info.settingsTitle')}
      settings={
        <SettingsListGroup variant="filled">
          {canManage ? (
            <SettingsListItem
              title={t('chat.group.name')}
              icon={<RiUserLine {...icon} />}
              showChevron={false}
              rightElement={
                <View style={styles.rename}>
                  <TextFieldInput
                    label={t('chat.group.name')}
                    placeholder={null}
                    value={name}
                    onChangeText={setName}
                    onBlur={() => void saveName()}
                    onSubmitEditing={() => void saveName()}
                    returnKeyType="done"
                    maxLength={128}
                    size="small"
                  />
                </View>
              }
            />
          ) : null}
          <SettingsListItem
            title={t('chat.info.encryption')}
            value={t('chat.info.encryptionValue')}
            icon={<RiLock2Line {...icon} />}
            showChevron={false}
          />
        </SettingsListGroup>
      }
      tabs={tabs}
      members={isGroup ? members : undefined}
      membersTitle={t('chat.details.participants')}
      memberSearch={isGroup && view.memberAccountIds.length >= 8}
      memberQuery={memberQuery}
      onMemberQueryChange={setMemberQuery}
      onPressMember={(member) => openProfile(member.id)}
      roleLabels={{ owner: t('chat.role.owner'), admin: t('chat.role.admin') }}
      onAddMember={canManage ? () => router.push(`/new?addTo=${view.id}`) : undefined}
      addMemberLabel={t('chat.group.addMember')}
      actions={actions}
      destructiveActions={destructiveActions}
    />
  );
}

const styles = StyleSheet.create({
  rename: { width: 180 },
});
