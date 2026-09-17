import React, { useMemo, useState, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import AnimatedTabBar from './common/AnimatedTabBar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from './Avatar';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { Search } from '@oxy.so/bloom/search';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useRouter, type Href } from 'expo-router';
import { useConversationActions } from '@allo/react';
import { EmptyState } from '@/components/shared/EmptyState';
import { useParticipantFullName } from '@/utils/conversationUtils';
import { COLOR_THEMES } from '@/styles/colorThemes';
import { useConversationThemeStore } from '@/stores/conversationThemeStore';
import { useAvatarUrl, usePeople, usePerson } from '@/hooks/usePerson';
import { useUserSearch } from '@/hooks/useUserSearch';
import { confirmDialog } from '@/utils/alerts';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

import type { ConversationParticipant, ConversationType } from '@/lib/chat/model';
import { getOtherParticipants } from '@/utils/conversationUtils';
import { GroupAvatar } from './GroupAvatar';
import { ProfileIdentity } from './profile/ProfileIdentity';
import { useAvatarShape } from '@/hooks/useAvatarShape';

/**
 * The handle without its `@`.
 *
 * `contactUsername` reaches this component both ways — the conversation metadata
 * stores it bare, the prop's own default carries the sigil — and the renderer
 * puts the `@` on itself, so a value that already had one would draw `@@name`.
 */
function bareHandle(username: string | undefined): string | undefined {
  const handle = username?.replace(/^@+/, '');
  return handle ? handle : undefined;
}

/** How long a group's name may be. The same cap `app/(chat)/new.tsx` applies. */
const GROUP_NAME_MAX_LENGTH = 64;

/**
 * Participant item component for group conversations
 * Extracted to separate component to allow using hooks properly
 */
function ParticipantItem({
  participant,
  onRemove,
}: {
  participant: ConversationParticipant;
  /** Present when the viewer may remove this member. */
  onRemove?: (participant: ConversationParticipant) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const person = usePerson(participant.id);
  const fullName = useParticipantFullName(participant);
  const initial = fullName?.charAt(0).toUpperCase() || '?';
  const participantShape = useAvatarShape(participant.id);
  const participantAvatar = useAvatarUrl(person?.avatar ?? participant.avatar);
  const participantUsername = person?.handle ?? participant.username;

  const styles = React.useMemo(() => StyleSheet.create({
    participantItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    participantInfo: {
      marginLeft: 12,
      flex: 1,
    },
    participantName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    participantUsername: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    removeButton: {
      padding: 8,
    },
  }), [theme]);

  return (
    <View style={styles.participantItem}>
      <Avatar
        size={40}
        source={participantAvatar ? { uri: participantAvatar } : undefined}
        label={initial}
        shape={participantShape}
      />
      <View style={styles.participantInfo}>
        <ThemedText style={styles.participantName}>{fullName}</ThemedText>
        {participantUsername && (
          <ThemedText style={styles.participantUsername}>@{participantUsername}</ThemedText>
        )}
      </View>
      {onRemove && (
        <TouchableOpacity
          style={styles.removeButton}
          onPress={() => onRemove(participant)}
          accessibilityRole="button"
          accessibilityLabel={t('chat.group.removeMember', 'Remove from group')}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="person-remove-outline" size={20} color={theme.colors.error} />
        </TouchableOpacity>
      )}
    </View>
  );
}

interface ContactDetailsProps {
  conversationId?: string;
  conversationType?: ConversationType;
  contactName?: string;
  contactAvatar?: string;
  contactUsername?: string;
  isOnline?: boolean;
  lastSeen?: Date;
  // Group-specific props
  participants?: ConversationParticipant[];
  groupName?: string;
  groupAvatar?: string;
  currentUserId?: string;
  /** What the viewer may do to a group. Absent means "member". */
  myRole?: 'owner' | 'admin' | 'member';
}

export function ContactDetails({
  conversationId,
  conversationType = 'direct',
  contactName = 'Contact Name',
  contactAvatar,
  contactUsername = '@username',
  isOnline = false,
  lastSeen,
  participants = [],
  groupName,
  groupAvatar,
  currentUserId,
  myRole = 'member',
}: ContactDetailsProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { addMember, removeMember, leave, rename } = useConversationActions();
  const isGroup = conversationType === 'group';
  const canManage = isGroup && (myRole === 'owner' || myRole === 'admin');
  const otherParticipants = isGroup && participants
    ? (getOtherParticipants({ participants }, currentUserId) || [])
    : [];
  const displayName = isGroup && groupName
    ? groupName
    : contactName;

  usePeople(useMemo(() => participants.map((p) => p.id), [participants]));

  // The conversation's colour theme is this device's preference: see the store.
  const conversationTheme = useConversationThemeStore((state) =>
    conversationId ? state.themeByConversation[conversationId] : undefined,
  );
  const setConversationTheme = useConversationThemeStore((state) => state.setConversationTheme);

  const handleThemeChange = useCallback((themeId: string) => {
    if (!conversationId) return;
    setConversationTheme(conversationId, themeId);
  }, [conversationId, setConversationTheme]);

  // Define tabs based on conversation type
  const tabs = isGroup
    ? [
      { id: 'participants', label: t('chat.details.participants', 'Participants') },
      { id: 'info', label: t('chat.details.info', 'Info') },
    ]
    : [
      { id: 'info', label: t('chat.details.info', 'Info') },
      { id: 'media', label: t('chat.details.media', 'Media') },
    ];

  const [activeTab, setActiveTab] = useState(tabs[0].id);

  // For direct conversations, the other participant, through the people layer
  const otherParticipant = !isGroup ? participants?.find(p => p.id !== currentUserId) : undefined;
  const contactPerson = usePerson(!isGroup ? otherParticipant?.id : undefined);
  const contactAvatarUrl = useAvatarUrl(isGroup ? (groupAvatar || contactAvatar) : (contactPerson?.avatar || contactAvatar));

  // Use actual contact data from Oxy
  const contactData = {
    name: contactPerson?.displayName || contactName,
    username: bareHandle(contactUsername) || contactPerson?.handle,
    avatar: contactAvatarUrl,
    isOnline,
    lastSeen: lastSeen || new Date(),
  };

  // Get avatar shape for the contact (only for direct conversations)
  const contactAvatarShape = useAvatarShape(!isGroup ? otherParticipant?.id : undefined);

  // ---- group management -----------------------------------------------------
  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState<string | null>(null);
  const search = useUserSearch();
  const memberIds = useMemo(() => new Set(participants.map((p) => p.id)), [participants]);

  const run = useCallback(async (action: () => Promise<void>, failure: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error: unknown) {
      logger.error('[ContactDetails] group action failed:', error);
      toast.error(getErrorMessage(error) || failure);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const handleRename = useCallback(() => {
    if (!conversationId || draftName === null) return;
    const name = draftName.trim();
    if (name === '' || name === groupName) {
      setDraftName(null);
      return;
    }
    void run(async () => {
      await rename(conversationId, name);
      setDraftName(null);
      toast.success(t('chat.group.renamed', 'Group renamed'));
    }, t('chat.group.renameFailed', 'The group could not be renamed'));
  }, [conversationId, draftName, groupName, rename, run, t]);

  const handleAddMember = useCallback((accountId: string) => {
    if (!conversationId) return;
    if (memberIds.has(accountId)) {
      toast.error(t('chat.group.alreadyMember', 'Already in this group'));
      return;
    }
    void run(async () => {
      await addMember(conversationId, accountId);
      search.clear();
      toast.success(t('chat.group.memberAdded', 'Added to the group'));
    }, t('chat.group.addFailed', 'The person could not be added'));
  }, [conversationId, memberIds, addMember, search, run, t]);

  const handleRemoveMember = useCallback(async (participant: ConversationParticipant) => {
    if (!conversationId) return;
    const confirmed = await confirmDialog({
      title: t('chat.group.removeMember', 'Remove from group'),
      message: t('chat.group.removeMemberConfirm', 'They will no longer see new messages in this group.'),
      okText: t('common.remove', 'Remove'),
      cancelText: t('common.cancel', 'Cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    void run(async () => {
      await removeMember(conversationId, participant.id);
      toast.success(t('chat.group.memberRemoved', 'Removed from the group'));
    }, t('chat.group.removeFailed', 'The person could not be removed'));
  }, [conversationId, removeMember, run, t]);

  const handleLeave = useCallback(async () => {
    if (!conversationId) return;
    const confirmed = await confirmDialog({
      title: isGroup ? t('chat.leave.group', 'Leave group') : t('chat.leave.conversation', 'Delete conversation'),
      message: t('chat.leave.confirm', 'You will stop receiving messages here, and this device will no longer be able to read them.'),
      okText: isGroup ? t('chat.leave.group', 'Leave group') : t('common.delete', 'Delete'),
      cancelText: t('common.cancel', 'Cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    void run(async () => {
      await leave(conversationId);
      router.replace('/' as Href);
    }, t('chat.leave.failed', 'The conversation could not be left'));
  }, [conversationId, isGroup, leave, router, run, t]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    header: {
      paddingHorizontal: 16,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.background,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    content: {
      flex: 1,
      paddingHorizontal: 16,
      paddingTop: 24,
    },
    avatar: {
      marginBottom: 12,
    },
    section: {
      marginBottom: 24,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 12,
    },
    infoItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    infoIcon: {
      marginRight: 12,
      width: 24,
      alignItems: 'center',
    },
    infoContent: {
      flex: 1,
    },
    infoLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginBottom: 2,
    },
    infoValue: {
      fontSize: 16,
      color: theme.colors.text,
    },
    infoValueDestructive: {
      fontSize: 16,
      color: theme.colors.error,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 8,
      backgroundColor: theme.colors.primary,
      marginBottom: 12,
    },
    actionButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.background,
      marginLeft: 8,
    },
    tabsContainer: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    tabContent: {
      flex: 1,
    },
    renameRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
    },
    renameField: {
      flex: 1,
    },
    smallButton: {
      paddingVertical: 10,
      paddingHorizontal: 16,
      borderRadius: 8,
      backgroundColor: theme.colors.primary,
    },
    smallButtonText: {
      color: theme.colors.background,
      fontWeight: '600',
    },
    searchResult: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      gap: 12,
    },
    searchResultName: {
      fontSize: 15,
      color: theme.colors.text,
      flex: 1,
    },
  }), [theme]);

  const formatLastSeen = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.container} edges={['top']}>
        {/* Header */}
        <View style={styles.header}>
          <ThemedText style={styles.headerTitle}>
            {isGroup ? t('chat.details.groupInfo', 'Group Info') : t('chat.details.contactInfo', 'Contact Info')}
          </ThemedText>
        </View>

        {/* Avatar and Name - Always visible. The same renderer the profile
            screen uses, so a person looks the same wherever they are shown. */}
        <ProfileIdentity
          displayName={isGroup ? displayName : contactData.name}
          handle={isGroup ? undefined : contactData.username}
          status={
            isGroup
              ? otherParticipants.length > 0
                ? `${otherParticipants.length} participant${otherParticipants.length > 1 ? 's' : ''}`
                : undefined
              : contactData.isOnline
                ? 'Online'
                : `Last seen ${formatLastSeen(contactData.lastSeen)}`
          }
          statusIsPresence={!isGroup && contactData.isOnline}
          avatarUrl={contactAvatarUrl}
          avatarShape={contactAvatarShape}
          avatarSlot={
            isGroup && otherParticipants.length > 0 ? (
              <GroupAvatar
                participants={otherParticipants}
                size={100}
                maxAvatars={2}
                style={styles.avatar}
              />
            ) : undefined
          }
        />

        {/* Tabs */}
        <AnimatedTabBar
          tabs={tabs}
          activeTabId={activeTab}
          onTabPress={setActiveTab}
          style={styles.tabsContainer}
        />

        {/* Tab Content */}
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {/* Participants Tab - Only for groups */}
          {isGroup && activeTab === 'participants' && (
            <>
              {canManage && (
                <View style={styles.section}>
                  <ThemedText style={styles.sectionTitle}>{t('chat.group.addMember', 'Add someone')}</ThemedText>
                  <Search
                    label={t('Search users…')}
                    value={search.term}
                    onChangeText={search.setTerm}
                    onClearText={search.clear}
                  />
                  {search.searching && <ActivityIndicator color={theme.colors.primary} style={{ marginTop: 12 }} />}
                  {search.results
                    .filter((candidate) => !memberIds.has(candidate.id))
                    .map((candidate) => (
                      <TouchableOpacity
                        key={candidate.id}
                        style={styles.searchResult}
                        onPress={() => handleAddMember(candidate.id)}
                        disabled={busy}
                        accessibilityRole="button"
                      >
                        <Avatar size={36} source={candidate.avatar ? { uri: candidate.avatar } : undefined} label={candidate.displayName.charAt(0).toUpperCase()} />
                        <ThemedText style={styles.searchResultName} numberOfLines={1}>
                          {candidate.displayName}
                        </ThemedText>
                        <Ionicons name="person-add-outline" size={20} color={theme.colors.primary} />
                      </TouchableOpacity>
                    ))}
                </View>
              )}
              {otherParticipants.length > 0 && (
                <View style={styles.section}>
                  {otherParticipants.map((participant) => (
                    <ParticipantItem
                      key={participant.id}
                      participant={participant}
                      onRemove={canManage ? handleRemoveMember : undefined}
                    />
                  ))}
                </View>
              )}
            </>
          )}

          {/* Info Tab */}
          {activeTab === 'info' && (
            <>
              {/* Group name */}
              {isGroup && (
                <View style={styles.section}>
                  <ThemedText style={styles.sectionTitle}>{t('chat.group.name', 'Group name')}</ThemedText>
                  <View style={styles.renameRow}>
                    <View style={styles.renameField}>
                      <TextFieldInput
                        label={t('chat.group.name', 'Group name')}
                        placeholder={t('Group name (optional)')}
                        value={draftName ?? groupName ?? ''}
                        onChangeText={setDraftName}
                        maxLength={GROUP_NAME_MAX_LENGTH}
                        returnKeyType="done"
                        onSubmitEditing={handleRename}
                      />
                    </View>
                    {draftName !== null && draftName.trim() !== (groupName ?? '') && (
                      <TouchableOpacity style={styles.smallButton} onPress={handleRename} disabled={busy} accessibilityRole="button">
                        <Text style={styles.smallButtonText}>{t('Save')}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              )}

              {/* Actions - Only for direct conversations */}
              {!isGroup && (
                <View style={styles.section}>
                  <TouchableOpacity style={styles.actionButton} activeOpacity={0.7}>
                    <Ionicons name="call" size={20} color={theme.colors.background} />
                    <Text style={styles.actionButtonText}>Call</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionButton, { backgroundColor: theme.colors.card }]}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="videocam" size={20} color={theme.colors.text} />
                    <Text style={[styles.actionButtonText, { color: theme.colors.text }]}>Video</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Contact Information - Only for direct conversations */}
              {!isGroup && contactData.username && (
                <View style={styles.section}>
                  <ThemedText style={styles.sectionTitle}>Contact Information</ThemedText>

                  <TouchableOpacity style={styles.infoItem} activeOpacity={0.7}>
                    <View style={styles.infoIcon}>
                      <Ionicons name="at-outline" size={20} color={theme.colors.textSecondary} />
                    </View>
                    <View style={styles.infoContent}>
                      <Text style={styles.infoLabel}>Username</Text>
                      <Text style={styles.infoValue}>@{contactData.username}</Text>
                    </View>
                  </TouchableOpacity>
                </View>
              )}

              {/* Chat Theme — a preference of this device; see conversationThemeStore */}
              <View style={styles.section}>
                <ThemedText style={styles.sectionTitle}>{t('chat.theme.title', 'Chat Theme')}</ThemedText>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingVertical: 8 }}
                >
                  {COLOR_THEMES.map((colorTheme) => {
                    const isSelected = conversationTheme === colorTheme.id;
                    const variant = theme.isDark ? colorTheme.dark : colorTheme.light;

                    return (
                      <TouchableOpacity
                        key={colorTheme.id}
                        onPress={() => handleThemeChange(colorTheme.id)}
                        activeOpacity={0.8}
                        style={{
                          width: 80,
                          marginRight: 12,
                          alignItems: 'center',
                        }}
                      >
                        {/* Mini preview */}
                        <View
                          style={{
                            width: 80,
                            height: 60,
                            borderRadius: 12,
                            padding: 8,
                            justifyContent: 'space-between',
                            backgroundColor: variant.chatBackground,
                            borderWidth: isSelected ? 2.5 : 1,
                            borderColor: isSelected ? colorTheme.primaryColor : theme.colors.border,
                            overflow: 'hidden',
                          }}
                        >
                          <View
                            style={{
                              width: '60%',
                              height: 14,
                              borderRadius: 7,
                              backgroundColor: variant.bubbleReceived,
                              alignSelf: 'flex-start',
                            }}
                          />
                          <View
                            style={{
                              width: '50%',
                              height: 14,
                              borderRadius: 7,
                              backgroundColor: variant.bubbleSent,
                              alignSelf: 'flex-end',
                            }}
                          />
                        </View>
                        <Text
                          style={{
                            fontSize: 13,
                            marginTop: 6,
                            color: isSelected ? colorTheme.primaryColor : theme.colors.text,
                            fontWeight: isSelected ? '600' : '400',
                          }}
                        >
                          {colorTheme.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>

              {/* Common Actions */}
              <View style={styles.section}>
                <TouchableOpacity style={styles.infoItem} activeOpacity={0.7}>
                  <View style={styles.infoIcon}>
                    <Ionicons name="search-outline" size={20} color={theme.colors.textSecondary} />
                  </View>
                  <View style={styles.infoContent}>
                    <Text style={styles.infoValue}>Search in Conversation</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
                </TouchableOpacity>

                <TouchableOpacity style={styles.infoItem} activeOpacity={0.7}>
                  <View style={styles.infoIcon}>
                    <Ionicons name="notifications-outline" size={20} color={theme.colors.textSecondary} />
                  </View>
                  <View style={styles.infoContent}>
                    <Text style={styles.infoValue}>Mute Notifications</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
                </TouchableOpacity>

                {conversationId && (
                  <TouchableOpacity
                    style={styles.infoItem}
                    activeOpacity={0.7}
                    onPress={() => {
                      void handleLeave();
                    }}
                    disabled={busy}
                    accessibilityRole="button"
                  >
                    <View style={styles.infoIcon}>
                      <Ionicons name="exit-outline" size={20} color={theme.colors.error} />
                    </View>
                    <View style={styles.infoContent}>
                      <Text style={styles.infoValueDestructive}>
                        {isGroup ? t('chat.leave.group', 'Leave group') : t('chat.leave.conversation', 'Delete conversation')}
                      </Text>
                    </View>
                  </TouchableOpacity>
                )}
              </View>
            </>
          )}

          {/* Media Tab */}
          {activeTab === 'media' && (
            <View style={styles.section}>
              <TouchableOpacity style={styles.infoItem} activeOpacity={0.7}>
                <View style={styles.infoIcon}>
                  <Ionicons name="images-outline" size={20} color={theme.colors.textSecondary} />
                </View>
                <View style={styles.infoContent}>
                  <Text style={styles.infoValue}>Media, Links & Docs</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
              </TouchableOpacity>
              <EmptyState
                lottieSource={require('@/assets/lottie/welcome.json')}
                title="No media shared yet"
              />
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}
