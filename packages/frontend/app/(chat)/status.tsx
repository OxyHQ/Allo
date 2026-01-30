import React, { useState, useMemo, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import LottieView from 'lottie-react-native';

// Components
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { EmptyState } from '@/components/shared/EmptyState';

// Icons
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';

// Hooks
import { useTheme } from '@/hooks/useTheme';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';

const IconComponent = Ionicons as any;

interface StatusUpdate {
  id: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  timestamp: Date;
  isViewed: boolean;
  type: 'image' | 'video' | 'text';
  preview?: string;
  viewsCount?: number;
}

interface StatusGroup {
  userId: string;
  userName: string;
  userAvatar?: string;
  isViewed: boolean;
  lastUpdate: Date;
  updates: StatusUpdate[];
  unreadCount: number;
}

// Mock status data - replace with actual data from your store/API
const MOCK_STATUS_GROUPS: StatusGroup[] = [
  {
    userId: '1',
    userName: 'John Doe',
    userAvatar: undefined,
    isViewed: false,
    lastUpdate: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    unreadCount: 2,
    updates: [
      {
        id: '1',
        userId: '1',
        userName: 'John Doe',
        timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000),
        isViewed: false,
        type: 'image',
        preview: undefined,
      },
    ],
  },
  {
    userId: '2',
    userName: 'Jane Smith',
    userAvatar: undefined,
    isViewed: true,
    lastUpdate: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5 hours ago
    unreadCount: 0,
    updates: [
      {
        id: '2',
        userId: '2',
        userName: 'Jane Smith',
        timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000),
        isViewed: true,
        type: 'video',
        preview: undefined,
      },
    ],
  },
  {
    userId: '3',
    userName: 'Alice Johnson',
    userAvatar: undefined,
    isViewed: false,
    lastUpdate: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1 hour ago
    unreadCount: 3,
    updates: [
      {
        id: '3',
        userId: '3',
        userName: 'Alice Johnson',
        timestamp: new Date(Date.now() - 1 * 60 * 60 * 1000),
        isViewed: false,
        type: 'text',
        preview: undefined,
      },
    ],
  },
];

/**
 * Formats a date to a human-readable "time ago" string
 */
const formatTimeAgo = (date: Date): string => {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
};

export default function StatusScreen() {
  const theme = useTheme();
  const router = useRouter();
  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });
  const [statusGroups] = useState<StatusGroup[]>(MOCK_STATUS_GROUPS);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    header: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.background,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: 'bold',
      color: theme.colors.text,
    },
    list: {
      flex: 1,
    },
    myStatusSection: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.background,
    },
    myStatusTitle: {
      fontSize: 13,
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      color: theme.colors.textSecondary,
      marginBottom: 12,
    },
    myStatusItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
    },
    myStatusAvatar: {
      marginRight: 12,
      position: 'relative',
    },
    addStatusButton: {
      position: 'absolute',
      bottom: -2,
      right: -2,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: theme.colors.primary,
      borderWidth: 2,
      borderColor: theme.colors.background,
      justifyContent: 'center',
      alignItems: 'center',
    },
    myStatusText: {
      flex: 1,
    },
    myStatusName: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 2,
    },
    myStatusSubtext: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    recentUpdatesSection: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.background,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      color: theme.colors.textSecondary,
      marginBottom: 12,
    },
    statusItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 16,
      paddingHorizontal: 16,
      backgroundColor: theme.colors.background,
    },
    statusAvatarContainer: {
      marginRight: 14,
      position: 'relative',
    },
    statusRing: {
      position: 'absolute',
      top: -2.5,
      left: -2.5,
      width: 52,
      height: 52,
      borderRadius: 26,
      borderWidth: 2.5,
      borderColor: theme.colors.primary,
    },
    statusRingViewed: {
      borderColor: theme.colors.border,
      borderWidth: 2,
      top: -2,
      left: -2,
      width: 48,
      height: 48,
      borderRadius: 24,
    },
    statusContent: {
      flex: 1,
      justifyContent: 'center',
    },
    statusHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    statusName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      flex: 1,
      marginRight: 8,
    },
    statusTime: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      fontWeight: '400',
    },
    statusPreview: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      lineHeight: 18,
    },
  }), [theme]);

  const renderMyStatus = useCallback(() => {
    return (
      <View style={styles.myStatusSection}>
        <ThemedText style={styles.myStatusTitle}>My Status</ThemedText>
        <TouchableOpacity style={styles.myStatusItem} activeOpacity={0.7}>
          <View style={styles.myStatusAvatar}>
            <Avatar size={44} label="Y" />
            <View style={styles.addStatusButton}>
              <IconComponent name="add" size={12} color="#FFFFFF" />
            </View>
          </View>
          <View style={styles.myStatusText}>
            <ThemedText style={styles.myStatusName}>My Status</ThemedText>
            <ThemedText style={styles.myStatusSubtext}>
              Tap to add status update
            </ThemedText>
          </View>
        </TouchableOpacity>
      </View>
    );
  }, [styles]);

  const renderStatusItem = useCallback(({ item }: { item: StatusGroup }) => {
    const hasUnread = item.unreadCount > 0;
    const latestUpdate = item.updates[item.updates.length - 1];
    const updateTypeText = latestUpdate?.type === 'image' ? '📷 Photo' :
                          latestUpdate?.type === 'video' ? '🎥 Video' :
                          latestUpdate?.type === 'text' ? '💬 Text' : '';

    return (
      <TouchableOpacity 
        style={styles.statusItem} 
        activeOpacity={0.7}
      >
        <View style={styles.statusAvatarContainer}>
          {!item.isViewed && (
            <View style={styles.statusRing} />
          )}
          {item.isViewed && (
            <View style={styles.statusRingViewed} />
          )}
          <Avatar
            size={48}
            source={item.userAvatar ? { uri: item.userAvatar } : undefined}
            label={item.userName.charAt(0)}
          />
        </View>
        <View style={styles.statusContent}>
          <View style={styles.statusHeader}>
            <ThemedText 
              style={[
                styles.statusName,
                hasUnread && { fontWeight: '700', color: theme.colors.text },
              ]} 
              numberOfLines={1}
            >
              {item.userName}
            </ThemedText>
            <ThemedText style={styles.statusTime}>
              {formatTimeAgo(item.lastUpdate)}
            </ThemedText>
          </View>
          <ThemedText 
            style={[
              styles.statusPreview,
              hasUnread && { color: theme.colors.text, fontWeight: '500' },
            ]} 
            numberOfLines={1}
          >
            {hasUnread 
              ? `${item.unreadCount} new update${item.unreadCount > 1 ? 's' : ''}`
              : updateTypeText || 'Viewed'}
          </ThemedText>
        </View>
      </TouchableOpacity>
    );
  }, [styles, formatTimeAgo, theme]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ThemedView style={styles.container}>
        {!isLargeScreen && (
          <Header
            options={{
              title: 'Status',
              leftComponents: [
                <HeaderIconButton
                  key="back"
                  onPress={handleBack}
                >
                  <BackArrowIcon size={20} color={theme.colors.text} />
                </HeaderIconButton>,
              ],
            }}
            hideBottomBorder={true}
            disableSticky={true}
          />
        )}

        {renderMyStatus()}

        {statusGroups.length > 0 ? (
          <View style={styles.recentUpdatesSection}>
            <ThemedText style={styles.sectionTitle}>Recent Updates</ThemedText>
            <FlatList
              data={statusGroups}
              renderItem={renderStatusItem}
              keyExtractor={(item) => item.userId}
              scrollEnabled={true}
              showsVerticalScrollIndicator={false}
              ItemSeparatorComponent={() => (
                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border, marginLeft: 70 }} />
              )}
              contentContainerStyle={{ paddingBottom: 16 }}
            />
          </View>
        ) : (
          <EmptyState
            lottieSource={require('@/assets/lottie/welcome.json')}
            title="No status updates yet"
            subtitle="Your contacts' status updates will appear here"
          />
        )}
      </ThemedView>
    </SafeAreaView>
  );
}

