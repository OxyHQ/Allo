import React, { useState, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Image,
} from 'react-native';
import { Link, usePathname } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/styles/colors';

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

export default function StatusScreen() {
  const theme = useTheme();
  const pathname = usePathname();
  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });
  const [statusGroups] = useState<StatusGroup[]>(MOCK_STATUS_GROUPS);

  const formatTimeAgo = (date: Date) => {
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
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.background,
    },
    statusAvatarContainer: {
      marginRight: 12,
      position: 'relative',
    },
    statusRing: {
      position: 'absolute',
      top: -2,
      left: -2,
      width: 48,
      height: 48,
      borderRadius: 24,
      borderWidth: 2,
      borderColor: theme.colors.primary,
    },
    statusRingViewed: {
      borderColor: theme.colors.border,
    },
    statusContent: {
      flex: 1,
    },
    statusHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 2,
    },
    statusName: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
    },
    statusTime: {
      fontSize: 12,
      color: theme.colors.textSecondary,
    },
    statusPreview: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },
    emptyStateText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
  }), [theme]);

  const renderMyStatus = () => {
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
  };

  const renderStatusItem = ({ item }: { item: StatusGroup }) => {
    const hasUnread = item.unreadCount > 0;

    return (
      <TouchableOpacity style={styles.statusItem} activeOpacity={0.7}>
        <View style={styles.statusAvatarContainer}>
          <View style={[
            styles.statusRing,
            item.isViewed && styles.statusRingViewed,
          ]} />
          <Avatar
            size={44}
            source={item.userAvatar ? { uri: item.userAvatar } : undefined}
            label={item.userName.charAt(0)}
          />
        </View>
        <View style={styles.statusContent}>
          <View style={styles.statusHeader}>
            <ThemedText style={styles.statusName} numberOfLines={1}>
              {item.userName}
            </ThemedText>
            <ThemedText style={styles.statusTime}>
              {formatTimeAgo(item.lastUpdate)}
            </ThemedText>
          </View>
          {hasUnread && (
            <ThemedText style={styles.statusPreview} numberOfLines={1}>
              {item.unreadCount} new update{item.unreadCount > 1 ? 's' : ''}
            </ThemedText>
          )}
        </View>
      </TouchableOpacity>
    );
  };

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
                  onPress={() => {/* Navigate back */}}
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
              style={styles.list}
              data={statusGroups}
              renderItem={renderStatusItem}
              keyExtractor={(item) => item.userId}
              scrollEnabled={false}
              contentContainerStyle={{ paddingBottom: 16 }}
            />
          </View>
        ) : (
          <View style={styles.emptyState}>
            <ThemedText style={styles.emptyStateText}>
              No status updates yet.{'\n'}
              Your contacts' status updates will appear here
            </ThemedText>
          </View>
        )}
      </ThemedView>
    </SafeAreaView>
  );
}

