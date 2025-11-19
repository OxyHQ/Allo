import React, { useMemo, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Image,
} from 'react-native';
import AnimatedTabBar from './common/AnimatedTabBar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from './Avatar';
import { Ionicons } from '@expo/vector-icons';
import { useOxy } from '@oxyhq/services';
import { useUserById, useUsersStore } from '@/stores/usersStore';
import { useParticipantFullName } from '@/utils/conversationUtils';

import { ConversationParticipant, ConversationType } from '@/app/(chat)/index';
import { getConversationDisplayName, getOtherParticipants, isGroupConversation } from '@/utils/conversationUtils';
import { GroupAvatar } from './GroupAvatar';
import { OxyServices } from '@oxyhq/services';

/**
 * Participant item component for group conversations
 * Extracted to separate component to allow using hooks properly
 */
function ParticipantItem({
  participant,
  oxyServices,
  usersStore,
}: {
  participant: ConversationParticipant;
  oxyServices: OxyServices;
  usersStore: ReturnType<typeof useUsersStore>;
}) {
  const theme = useTheme();
  const participantUser = useUserById(participant.id);
  const fullName = useParticipantFullName(participant);
  const initial = fullName?.charAt(0).toUpperCase() || '?';
  
  // Ensure we fetch user data if missing
  React.useEffect(() => {
    if (!participantUser) {
      if (participant.username) {
        usersStore.ensureByUsername(participant.username, (u) => oxyServices.getProfileByUsername(u));
      } else if (participant.id) {
        usersStore.ensureById(participant.id, (id) => oxyServices.getProfileByUsername(id));
      }
    }
  }, [participant.username, participant.id, participantUser, usersStore, oxyServices]);
  
  // Get avatar URL using oxyServices
  const participantAvatar = React.useMemo(() => {
    let avatar = participantUser?.avatar || participant.avatar;
    if (avatar && !avatar.startsWith('http') && !avatar.startsWith('file://')) {
      try {
        return oxyServices.getFileDownloadUrl(avatar, 'thumb');
      } catch (e) {
        // Ignore error
      }
    }
    return avatar;
  }, [participantUser?.avatar, participant.avatar, oxyServices]);
  
  const participantUsername = participantUser?.username || participantUser?.handle || participant.username;

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
  }), [theme]);

  return (
    <TouchableOpacity style={styles.participantItem} activeOpacity={0.7}>
      <Avatar
        size={40}
        source={participantAvatar ? { uri: participantAvatar } : undefined}
        label={initial}
      />
      <View style={styles.participantInfo}>
        <ThemedText style={styles.participantName}>{fullName}</ThemedText>
        {participantUsername && (
          <ThemedText style={styles.participantUsername}>@{participantUsername}</ThemedText>
        )}
      </View>
    </TouchableOpacity>
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
}: ContactDetailsProps) {
  const theme = useTheme();
  const isGroup = conversationType === 'group';
  const otherParticipants = isGroup && participants
    ? getOtherParticipants({ participants, type: 'group' } as any, currentUserId)
    : [];
  const displayName = isGroup && groupName
    ? groupName
    : contactName;

  // Define tabs based on conversation type
  const tabs = isGroup
    ? [
      { id: 'participants', label: 'Participants' },
      { id: 'info', label: 'Info' },
    ]
    : [
      { id: 'info', label: 'Info' },
      { id: 'media', label: 'Media' },
    ];

  const [activeTab, setActiveTab] = useState(tabs[0].id);

  // Get oxy services for avatar URLs
  const { oxyServices } = useOxy();
  const usersStore = useUsersStore();

  // For direct conversations, get the other participant's user data from Oxy
  const otherParticipant = !isGroup && participants?.find(p => p.id !== currentUserId);
  const contactUser = !isGroup && otherParticipant ? useUserById(otherParticipant.id) : null;

  // Ensure we fetch user data if missing
  React.useEffect(() => {
    if (!isGroup && otherParticipant && !contactUser) {
      if (otherParticipant.username) {
        usersStore.ensureByUsername(otherParticipant.username, (u) => oxyServices.getProfileByUsername(u));
      } else if (otherParticipant.id) {
        usersStore.ensureById(otherParticipant.id, (id) => oxyServices.getProfileByUsername(id));
      }
    }
  }, [isGroup, otherParticipant, contactUser, usersStore, oxyServices]);

  // Get contact avatar URL using oxyServices
  const contactAvatarUrl = useMemo(() => {
    if (isGroup) return groupAvatar || contactAvatar;
    
    // For direct conversations, try Oxy user data first
    let avatar = contactUser?.avatar || contactAvatar;
    
    if (avatar && !avatar.startsWith('http') && !avatar.startsWith('file://')) {
      try {
        return oxyServices.getFileDownloadUrl(avatar, 'thumb');
      } catch (e) {
        // Ignore error
      }
    }
    
    return avatar;
  }, [isGroup, contactUser?.avatar, contactAvatar, groupAvatar, oxyServices]);

  // Get contact bio from Oxy user data
  const contactBio = contactUser?.bio || contactUser?.description;
  
  // Use actual contact data from Oxy
  const contactData = {
    name: contactName,
    username: contactUsername || contactUser?.username || contactUser?.handle,
    avatar: contactAvatarUrl,
    bio: contactBio,
    isOnline,
    lastSeen: lastSeen || new Date(),
    verified: contactUser?.verified || false,
  };

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
    avatarContainer: {
      alignItems: 'center',
      marginBottom: 24,
    },
    avatar: {
      marginBottom: 12,
    },
    nameContainer: {
      alignItems: 'center',
      marginBottom: 8,
    },
    name: {
      fontSize: 22,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginBottom: 4,
    },
    username: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      marginBottom: 8,
    },
    status: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    onlineStatus: {
      fontSize: 14,
      color: '#4CAF50',
      fontWeight: '500',
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
      color: '#FFFFFF',
      marginLeft: 8,
    },
    tabsContainer: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    tabContent: {
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
            {isGroup ? 'Group Info' : 'Contact Info'}
          </ThemedText>
        </View>

        {/* Avatar and Name - Always visible */}
        <View style={styles.avatarContainer}>
          {isGroup && otherParticipants.length > 0 ? (
            <GroupAvatar
              participants={otherParticipants}
              size={100}
              maxAvatars={2}
              style={styles.avatar}
            />
          ) : (
            <Avatar
              source={contactAvatarUrl ? { uri: contactAvatarUrl } : undefined}
              size={100}
              style={styles.avatar}
              label={displayName.charAt(0)}
            />
          )}
          <View style={styles.nameContainer}>
            <ThemedText style={styles.name}>{displayName}</ThemedText>
            {!isGroup && contactUsername && (
              <ThemedText style={styles.username}>{contactUsername}</ThemedText>
            )}
            {isGroup && otherParticipants.length > 0 && (
              <ThemedText style={styles.username}>
                {otherParticipants.length} participant{otherParticipants.length > 1 ? 's' : ''}
              </ThemedText>
            )}
            {!isGroup && (
              contactData.isOnline ? (
                <ThemedText style={styles.onlineStatus}>Online</ThemedText>
              ) : (
                <ThemedText style={styles.status}>
                  Last seen {formatLastSeen(contactData.lastSeen)}
                </ThemedText>
              )
            )}
          </View>
        </View>

        {/* Tabs */}
        <AnimatedTabBar
          tabs={tabs}
          activeTabId={activeTab}
          onTabPress={setActiveTab}
          style={styles.tabsContainer}
        />

        {/* Tab Content */}
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          {/* Participants Tab - Only for groups */}
          {isGroup && activeTab === 'participants' && otherParticipants.length > 0 && (
            <View style={styles.section}>
              {otherParticipants.map((participant) => (
                <ParticipantItem
                  key={participant.id}
                  participant={participant}
                  oxyServices={oxyServices}
                  usersStore={usersStore}
                />
              ))}
            </View>
          )}

          {/* Info Tab */}
          {activeTab === 'info' && (
            <>
              {/* Actions - Only for direct conversations */}
              {!isGroup && (
                <View style={styles.section}>
                  <TouchableOpacity style={styles.actionButton} activeOpacity={0.7}>
                    <Ionicons name="call" size={20} color="#FFFFFF" />
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

              {/* About - Only for direct conversations */}
              {!isGroup && contactData.bio && (
                <View style={styles.section}>
                  <ThemedText style={styles.sectionTitle}>About</ThemedText>
                  <ThemedText style={{ color: theme.colors.text, fontSize: 15, lineHeight: 22 }}>
                    {contactData.bio}
                  </ThemedText>
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
              <View style={{ padding: 32, alignItems: 'center' }}>
                <ThemedText style={{ color: theme.colors.textSecondary }}>
                  No media shared yet
                </ThemedText>
              </View>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

