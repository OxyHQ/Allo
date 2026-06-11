import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';

import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { EmptyState } from '@/components/shared/EmptyState';

import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@/hooks/useTheme';
import { useOptimizedMediaQuery } from '@/hooks/useOptimizedMediaQuery';
import { formatRelativeLastSeen } from '@/utils/dateUtils';
import {
  useStatusStore,
  Status,
  StatusAuthor,
  StatusGroup,
} from '@/stores/statusStore';
import { StatusComposer } from '@/components/status/StatusComposer';
import { StatusViewer } from '@/components/status/StatusViewer';
import type { TFunction } from 'i18next';

const IconComponent = Ionicons as unknown as React.ComponentType<{
  name: string;
  size: number;
  color: string;
}>;

function getAuthorName(author: StatusAuthor | undefined, t: TFunction): string {
  if (!author) return t('status.unknownUser');
  const name = author.name;
  if (typeof name === 'string') return name;
  if (name?.first || name?.last) {
    return `${name.first || ''} ${name.last || ''}`.trim();
  }
  return author.username || t('status.unknownUser');
}

function describeStatus(s: Status | undefined, t: TFunction): string {
  if (!s) return '';
  if (s.type === 'image') return t('status.preview.photo');
  if (s.type === 'video') return t('status.preview.video');
  return t('status.preview.text');
}

interface ViewerTarget {
  statuses: Status[];
  author?: StatusAuthor;
  isOwner: boolean;
}

export default function StatusScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { t } = useTranslation();
  const { user } = useOxy() as { user: { id?: string } | null };
  const isLargeScreen = useOptimizedMediaQuery({ minWidth: 768 });

  // Realtime status events are wired once at the (chat) layout via
  // `useRealtimeStatus()`, so they reach the store even off this screen. The
  // screen just consumes the store and fetches the feed on mount.
  const groups = useStatusStore((s) => s.groups);
  const myStatus = useStatusStore((s) => s.myStatus);
  const loading = useStatusStore((s) => s.loading);
  const refreshing = useStatusStore((s) => s.refreshing);
  const hasFetchedOnce = useStatusStore((s) => s.hasFetchedOnce);
  const fetchFeed = useStatusStore((s) => s.fetchFeed);

  const [composerOpen, setComposerOpen] = useState(false);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);

  useEffect(() => {
    fetchFeed();
  }, [fetchFeed]);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const openComposer = useCallback(() => setComposerOpen(true), []);
  const closeComposer = useCallback(() => setComposerOpen(false), []);

  const openMyStatus = useCallback(() => {
    if (myStatus.length === 0) {
      openComposer();
      return;
    }
    setViewer({ statuses: myStatus, author: { userId: user?.id, id: user?.id }, isOwner: true });
  }, [myStatus, user?.id, openComposer]);

  const openGroup = useCallback((group: StatusGroup) => {
    setViewer({
      statuses: group.statuses,
      author: group.author || { userId: group.userId, id: group.userId },
      isOwner: false,
    });
  }, []);

  const closeViewer = useCallback(() => setViewer(null), []);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: theme.colors.background,
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
          width: 22,
          height: 22,
          borderRadius: 11,
          backgroundColor: theme.colors.primary,
          borderWidth: 2,
          borderColor: theme.colors.background,
          justifyContent: 'center',
          alignItems: 'center',
        },
        myStatusText: { flex: 1 },
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
        recentSection: {
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 4,
          backgroundColor: theme.colors.background,
        },
        sectionTitle: {
          fontSize: 13,
          fontWeight: '600',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: theme.colors.textSecondary,
          marginBottom: 8,
        },
        statusItem: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: 12,
          paddingHorizontal: 16,
          backgroundColor: theme.colors.background,
        },
        statusAvatarContainer: {
          marginRight: 14,
          position: 'relative',
          width: 56,
          height: 56,
          alignItems: 'center',
          justifyContent: 'center',
        },
        statusContent: { flex: 1, justifyContent: 'center' },
        statusName: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.colors.text,
          marginBottom: 2,
        },
        statusMeta: {
          fontSize: 13,
          color: theme.colors.textSecondary,
        },
        loadingContainer: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingVertical: 32,
        },
      }),
    [theme]
  );

  const renderRing = useCallback(
    (segments: number, viewedCount: number) => {
      const size = 56;
      const radius = size / 2;
      const stroke = 2.5;
      const allViewed = segments > 0 && viewedCount >= segments;
      const partiallyViewed = viewedCount > 0 && viewedCount < segments;
      return (
        <View
          style={{
            position: 'absolute',
            width: size,
            height: size,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          pointerEvents="none"
        >
          <View
            style={{
              width: size,
              height: size,
              borderRadius: radius,
              borderWidth: stroke,
              borderColor: allViewed ? theme.colors.border : theme.colors.primary,
            }}
          />
          {partiallyViewed ? (
            <View
              style={{
                position: 'absolute',
                width: size,
                height: size,
                borderRadius: radius,
                borderWidth: stroke,
                borderColor: theme.colors.border,
                opacity: viewedCount / segments,
              }}
            />
          ) : null}
        </View>
      );
    },
    [theme]
  );

  const renderMyStatus = useCallback(() => {
    const hasStatus = myStatus.length > 0;
    const latest = hasStatus ? myStatus[myStatus.length - 1] : undefined;
    const label = user?.id ? user.id.charAt(0).toUpperCase() : 'Y';
    return (
      <View style={styles.myStatusSection}>
        <ThemedText style={styles.myStatusTitle}>{t('status.myStatus')}</ThemedText>
        <TouchableOpacity style={styles.myStatusItem} activeOpacity={0.7} onPress={openMyStatus}>
          <View style={styles.myStatusAvatar}>
            {hasStatus ? renderRing(myStatus.length, 0) : null}
            <Avatar size={48} label={label} />
            {!hasStatus ? (
              <View style={styles.addStatusButton}>
                <IconComponent name="add" size={14} color="#FFFFFF" />
              </View>
            ) : null}
          </View>
          <View style={styles.myStatusText}>
            <ThemedText style={styles.myStatusName}>{t('status.myStatus')}</ThemedText>
            <ThemedText style={styles.myStatusSubtext}>
              {hasStatus && latest
                ? `${t('status.updates', { count: myStatus.length })} • ${formatRelativeLastSeen(
                    latest.createdAt,
                    t
                  )}`
                : t('status.tapToAdd')}
            </ThemedText>
          </View>
          <TouchableOpacity
            onPress={openComposer}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.colors.primary,
            }}
          >
            <IconComponent name="add" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        </TouchableOpacity>
      </View>
    );
  }, [
    myStatus,
    user?.id,
    styles,
    t,
    openMyStatus,
    openComposer,
    renderRing,
    theme,
  ]);

  const renderItem = useCallback(
    ({ item }: { item: StatusGroup }) => {
      const author = item.author;
      const name = getAuthorName(author, t);
      const latest = item.statuses[item.statuses.length - 1];
      const viewedCount = item.statuses.filter((s) => s.viewedByMe).length;

      return (
        <TouchableOpacity
          style={styles.statusItem}
          activeOpacity={0.7}
          onPress={() => openGroup(item)}
        >
          <View style={styles.statusAvatarContainer}>
            {renderRing(item.statuses.length, viewedCount)}
            <Avatar
              size={48}
              source={author?.avatar ? { uri: author.avatar } : undefined}
              label={name.charAt(0).toUpperCase()}
            />
          </View>
          <View style={styles.statusContent}>
            <ThemedText
              style={[
                styles.statusName,
                item.hasUnviewed && { fontWeight: '700' },
              ]}
              numberOfLines={1}
            >
              {name}
            </ThemedText>
            <ThemedText style={styles.statusMeta} numberOfLines={1}>
              {describeStatus(latest, t)} • {formatRelativeLastSeen(item.lastCreatedAt, t)}
            </ThemedText>
          </View>
        </TouchableOpacity>
      );
    },
    [styles, renderRing, openGroup, t]
  );

  const showLoading = loading && !hasFetchedOnce && groups.length === 0 && myStatus.length === 0;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ThemedView style={styles.container}>
        {!isLargeScreen && (
          <Header
            options={{
              title: t('status.title'),
              leftComponents: [
                <HeaderIconButton key="back" onPress={handleBack}>
                  <BackArrowIcon size={20} color={theme.colors.text} />
                </HeaderIconButton>,
              ],
              rightComponents: [
                <HeaderIconButton key="add" onPress={openComposer}>
                  <IconComponent name="add" size={22} color={theme.colors.text} />
                </HeaderIconButton>,
              ],
            }}
            hideBottomBorder
            disableSticky
          />
        )}

        {showLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : (
          <FlatList
            data={groups}
            keyExtractor={(item) => item.userId}
            ListHeaderComponent={
              <>
                {renderMyStatus()}
                {groups.length > 0 ? (
                  <View style={styles.recentSection}>
                    <ThemedText style={styles.sectionTitle}>
                      {t('status.recentUpdates')}
                    </ThemedText>
                  </View>
                ) : null}
              </>
            }
            renderItem={renderItem}
            ItemSeparatorComponent={() => (
              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: theme.colors.border,
                  marginLeft: 86,
                }}
              />
            )}
            ListEmptyComponent={
              !showLoading && groups.length === 0 ? (
                <EmptyState
                  lottieSource={require('@/assets/lottie/welcome.json')}
                  title={t('status.empty.title')}
                  subtitle={t('status.empty.subtitle')}
                />
              ) : null
            }
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => fetchFeed({ refresh: true })}
                tintColor={theme.colors.primary}
              />
            }
            contentContainerStyle={{ paddingBottom: 32 }}
          />
        )}

        <StatusComposer visible={composerOpen} onClose={closeComposer} />

        {viewer ? (
          <StatusViewer
            visible={!!viewer}
            statuses={viewer.statuses}
            author={viewer.author}
            isOwner={viewer.isOwner}
            onClose={closeViewer}
          />
        ) : null}
      </ThemedView>
    </SafeAreaView>
  );
}
