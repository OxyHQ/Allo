import React, { useCallback, useContext, useEffect, useMemo } from 'react';
import {
  StyleSheet,
  View,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { EmptyState } from '@/components/shared/EmptyState';
import { useCallsStore } from '@/stores/callsStore';
import { useOxy } from '@oxyhq/services';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import type { CallHistoryEntry, CallPeerSummary, CallStatus, CallType } from '@allo/shared-types';
import { webAlert } from '@/utils/api';

const IconComponent = Ionicons as any;

function peerDisplayName(peer: CallPeerSummary | undefined, fallback: string): string {
  if (!peer) return fallback;
  if (typeof peer.name === 'string') return peer.name;
  if (peer.name) {
    const composed = `${peer.name.first || ''} ${peer.name.last || ''}`.trim();
    if (composed) return composed;
  }
  return peer.username || peer.handle || peer.id || fallback;
}

function formatDuration(sec?: number): string {
  if (!sec || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function relativeTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString();
}

function statusIcon(direction: 'incoming' | 'outgoing', status: CallStatus) {
  if (status === 'missed' || status === 'canceled' || status === 'declined') {
    return { name: 'call-outline' as const, color: '#FF3B30' };
  }
  if (direction === 'outgoing') {
    return { name: 'arrow-up' as const, color: '#34C759' };
  }
  return { name: 'arrow-down' as const, color: '#34C759' };
}

export default function CallsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const bottomSheet = useContext(BottomSheetContext);

  const history = useCallsStore((s) => s.history);
  const loading = useCallsStore((s) => s.loading);
  const fetchHistory = useCallsStore((s) => s.fetchHistory);
  const startCall = useCallsStore((s) => s.startCall);
  const deleteEntry = useCallsStore((s) => s.deleteEntry);

  useEffect(() => {
    if (isAuthenticated) {
      void fetchHistory();
    }
  }, [isAuthenticated, fetchHistory]);

  // Start a call then either navigate to the active-call screen or surface the
  // localized error (busy / permission denied / etc.). Centralized so every
  // entry point (bottom sheet, alert fallback, call-back button) behaves alike.
  const startAndOpen = useCallback(
    async (peerId: string, type: CallType, conversationId?: string) => {
      const store = useCallsStore.getState();
      store.clearError();
      await startCall(peerId, type, conversationId);
      const { active, errorCode } = useCallsStore.getState();
      if (active) {
        router.push(`/(chat)/call/${active.callId}` as never);
        return;
      }
      if (errorCode) {
        webAlert(
          t('calls.error.title', 'Call'),
          t(`calls.error.${errorCode}`, t('calls.failedToStart', 'Could not start the call')),
          [{ text: t('calls.error.dismiss', 'OK'), onPress: () => store.clearError() }]
        );
      }
    },
    [startCall, router, t]
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: theme.colors.background,
        },
        header: {
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
          backgroundColor: theme.colors.background,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        },
        headerTitle: {
          fontSize: 24,
          fontWeight: '700',
          color: theme.colors.text,
        },
        list: {
          flex: 1,
        },
        item: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
          gap: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        itemBody: {
          flex: 1,
          minWidth: 0,
        },
        topRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        },
        peerName: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.colors.text,
          flexShrink: 1,
        },
        peerNameMissed: {
          color: '#FF3B30',
        },
        subtitle: {
          marginTop: 2,
          fontSize: 13,
          color: theme.colors.textSecondary,
        },
        timestamp: {
          fontSize: 12,
          color: theme.colors.textSecondary,
        },
        actionGroup: {
          flexDirection: 'row',
          gap: 6,
          alignItems: 'center',
        },
        actionButton: {
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
        },
      }),
    [theme]
  );

  const openOptions = (item: CallHistoryEntry) => {
    const peerId = item.peer?.id;
    if (!peerId) return;
    const name = peerDisplayName(item.peer, peerId);

    if (!bottomSheet) {
      // Fallback to a platform alert when there's no bottom sheet context.
      webAlert(name, t('calls.optionsTitle', 'Call options'), [
        {
          text: t('calls.callVoice', 'Voice call'),
          onPress: () => void startAndOpen(peerId, 'audio', item.conversationId),
        },
        {
          text: t('calls.callVideo', 'Video call'),
          onPress: () => void startAndOpen(peerId, 'video', item.conversationId),
        },
        {
          text: t('calls.deleteEntry', 'Delete'),
          style: 'destructive',
          onPress: () => void deleteEntry(item.id),
        },
        { text: t('calls.cancel', 'Cancel'), style: 'cancel' },
      ]);
      return;
    }

    const close = () => bottomSheet.openBottomSheet(false);

    bottomSheet.setBottomSheetContent(
      <CallItemOptions
        name={name}
        onVoice={async () => {
          close();
          await startAndOpen(peerId, 'audio', item.conversationId);
        }}
        onVideo={async () => {
          close();
          await startAndOpen(peerId, 'video', item.conversationId);
        }}
        onDelete={async () => {
          close();
          await deleteEntry(item.id);
        }}
        onClose={close}
      />
    );
    bottomSheet.openBottomSheet(true);
  };

  const renderItem = ({ item }: { item: CallHistoryEntry }) => {
    const name = peerDisplayName(item.peer, item.peer?.id || 'Unknown');
    const startedAt = new Date(item.startedAt);
    const isMissed = item.status === 'missed';
    const icon = statusIcon(item.direction, item.status);
    const subtitleParts: string[] = [];
    const typeLabel = item.type === 'video' ? t('calls.video', 'Video') : t('calls.voice', 'Voice');
    subtitleParts.push(typeLabel);
    if (item.status === 'missed') subtitleParts.push(t('calls.missed', 'Missed'));
    else if (item.status === 'declined') subtitleParts.push(t('calls.declined', 'Declined'));
    else if (item.status === 'canceled') subtitleParts.push(t('calls.canceled', 'Canceled'));
    else if (item.durationSec) subtitleParts.push(formatDuration(item.durationSec));

    return (
      <TouchableOpacity style={styles.item} activeOpacity={0.7} onPress={() => openOptions(item)}>
        <Avatar source={item.peer?.avatar} size={48} />
        <View style={styles.itemBody}>
          <View style={styles.topRow}>
            <IconComponent name={icon.name} size={16} color={icon.color} />
            <ThemedText
              numberOfLines={1}
              style={[styles.peerName, isMissed && styles.peerNameMissed]}
            >
              {name}
            </ThemedText>
          </View>
          <ThemedText numberOfLines={1} style={styles.subtitle}>
            {subtitleParts.join(' · ')}
          </ThemedText>
        </View>
        <View style={styles.actionGroup}>
          <ThemedText style={styles.timestamp}>{relativeTime(startedAt)}</ThemedText>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={(e) => {
              e.stopPropagation();
              if (!item.peer?.id) return;
              void startAndOpen(item.peer.id, item.type, item.conversationId);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={t('calls.callBack', 'Call back')}
          >
            <IconComponent
              name={item.type === 'video' ? 'videocam-outline' : 'call-outline'}
              size={22}
              color={theme.colors.primary}
            />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ThemedView style={styles.container}>
        <View style={styles.header}>
          <ThemedText style={styles.headerTitle}>{t('calls.title', 'Calls')}</ThemedText>
          {loading && Platform.OS !== 'web' && (
            <ActivityIndicator color={theme.colors.primary} />
          )}
        </View>

        {history.length === 0 && !loading ? (
          <EmptyState
            lottieSource={require('@/assets/lottie/welcome.json')}
            title={t('calls.emptyTitle', 'No calls yet')}
            subtitle={t('calls.emptySubtitle', 'Your call history will appear here.')}
          />
        ) : (
          <FlatList
            style={styles.list}
            data={history}
            keyExtractor={(c) => c.id}
            renderItem={renderItem}
            refreshControl={
              <RefreshControl
                refreshing={loading}
                onRefresh={() => void fetchHistory()}
                tintColor={theme.colors.primary}
              />
            }
          />
        )}
      </ThemedView>
    </SafeAreaView>
  );
}

// --- Inline component: bottom sheet options ---

function CallItemOptions({
  name,
  onVoice,
  onVideo,
  onDelete,
  onClose,
}: {
  name: string;
  onVoice: () => void;
  onVideo: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          padding: 16,
          paddingBottom: 24,
        },
        title: {
          fontSize: 18,
          fontWeight: '700',
          color: theme.colors.text,
          marginBottom: 12,
        },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 14,
        },
        rowText: {
          fontSize: 16,
          color: theme.colors.text,
        },
        rowTextDestructive: {
          fontSize: 16,
          color: '#FF3B30',
        },
        cancel: {
          marginTop: 8,
          paddingVertical: 12,
          alignItems: 'center',
        },
        cancelText: {
          color: theme.colors.textSecondary,
          fontSize: 16,
        },
      }),
    [theme]
  );

  return (
    <View style={styles.container}>
      <ThemedText style={styles.title}>{name}</ThemedText>
      <TouchableOpacity style={styles.row} onPress={onVoice} activeOpacity={0.7}>
        <IconComponent name="call-outline" size={22} color={theme.colors.text} />
        <ThemedText style={styles.rowText}>{t('calls.callVoice', 'Voice call')}</ThemedText>
      </TouchableOpacity>
      <TouchableOpacity style={styles.row} onPress={onVideo} activeOpacity={0.7}>
        <IconComponent name="videocam-outline" size={22} color={theme.colors.text} />
        <ThemedText style={styles.rowText}>{t('calls.callVideo', 'Video call')}</ThemedText>
      </TouchableOpacity>
      <TouchableOpacity style={styles.row} onPress={onDelete} activeOpacity={0.7}>
        <IconComponent name="trash-outline" size={22} color="#FF3B30" />
        <ThemedText style={styles.rowTextDestructive}>
          {t('calls.deleteEntry', 'Delete from history')}
        </ThemedText>
      </TouchableOpacity>
      <TouchableOpacity style={styles.cancel} onPress={onClose} activeOpacity={0.7}>
        <ThemedText style={styles.cancelText}>{t('calls.cancel', 'Cancel')}</ThemedText>
      </TouchableOpacity>
    </View>
  );
}
