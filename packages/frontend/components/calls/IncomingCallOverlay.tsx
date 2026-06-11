import React, { useMemo } from 'react';
import {
  Modal,
  View,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { useCallsStore } from '@/stores/callsStore';
import { useUserById } from '@/stores/usersStore';
import { webAlert } from '@/utils/api';

const IconComponent = Ionicons as any;

/**
 * Global overlay shown when an incoming call arrives. Mounted once at the
 * chat layout root so it stays available across all screens.
 */
export function IncomingCallOverlay() {
  const router = useRouter();
  const { t } = useTranslation();
  const incoming = useCallsStore((s) => s.incoming);
  const acceptIncoming = useCallsStore((s) => s.acceptIncoming);
  const decline = useCallsStore((s) => s.decline);
  const peer = useUserById(incoming?.peerId);

  const peerName = useMemo(() => {
    if (!incoming) return '';
    if (peer) {
      if (typeof peer.name === 'string') return peer.name;
      if (peer.name?.full) return peer.name.full;
      const first = peer.name?.first || '';
      const last = peer.name?.last || '';
      const composed = `${first} ${last}`.trim();
      return composed || peer.username || peer.handle || incoming.peerId;
    }
    return incoming.peerId;
  }, [incoming, peer]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        backdrop: {
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.85)',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: Platform.OS === 'ios' ? 80 : 60,
          paddingBottom: 60,
          paddingHorizontal: 24,
        },
        header: {
          alignItems: 'center',
          gap: 16,
        },
        callType: {
          fontSize: 16,
          color: 'rgba(255,255,255,0.8)',
          textTransform: 'lowercase',
        },
        name: {
          fontSize: 28,
          fontWeight: '700',
          color: '#FFFFFF',
          textAlign: 'center',
        },
        avatarWrap: {
          marginTop: 24,
        },
        actions: {
          flexDirection: 'row',
          gap: 48,
          alignItems: 'center',
          justifyContent: 'center',
        },
        actionButton: {
          width: 72,
          height: 72,
          borderRadius: 36,
          alignItems: 'center',
          justifyContent: 'center',
        },
        decline: {
          backgroundColor: '#FF3B30',
        },
        accept: {
          backgroundColor: '#34C759',
        },
        actionLabel: {
          marginTop: 8,
          color: '#FFFFFF',
          fontSize: 14,
          textAlign: 'center',
        },
        actionCol: {
          alignItems: 'center',
        },
      }),
    []
  );

  if (!incoming) return null;

  const onAccept = async () => {
    const callId = incoming.callId;
    await acceptIncoming(callId);
    const { active, errorCode } = useCallsStore.getState();
    if (active) {
      router.push(`/(chat)/call/${callId}` as never);
      return;
    }
    if (errorCode) {
      // Accept failed (e.g. mic/camera permission denied) — the store already
      // declined to the caller; surface the localized reason here.
      webAlert(
        t('calls.error.title', 'Call'),
        t(`calls.error.${errorCode}`, t('calls.failedToStart', 'Could not start the call')),
        [{ text: t('calls.error.dismiss', 'OK'), onPress: () => useCallsStore.getState().clearError() }]
      );
    }
  };

  const onDecline = async () => {
    await decline(incoming.callId);
  };

  return (
    <Modal
      visible={!!incoming}
      animationType="fade"
      transparent
      onRequestClose={onDecline}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.header}>
          <ThemedText style={styles.callType}>
            {incoming.type === 'video'
              ? t('calls.incomingVideo', 'Incoming video call')
              : t('calls.incomingVoice', 'Incoming voice call')}
          </ThemedText>
          <ThemedText style={styles.name}>{peerName}</ThemedText>
          <View style={styles.avatarWrap}>
            <Avatar source={peer?.avatar} size={160} />
          </View>
        </View>

        <View style={styles.actions}>
          <View style={styles.actionCol}>
            <TouchableOpacity
              style={[styles.actionButton, styles.decline]}
              onPress={onDecline}
              activeOpacity={0.8}
              accessibilityLabel={t('calls.decline', 'Decline')}
            >
              <IconComponent name="call" size={28} color="#FFFFFF" style={{ transform: [{ rotate: '135deg' }] }} />
            </TouchableOpacity>
            <ThemedText style={styles.actionLabel}>
              {t('calls.decline', 'Decline')}
            </ThemedText>
          </View>
          <View style={styles.actionCol}>
            <TouchableOpacity
              style={[styles.actionButton, styles.accept]}
              onPress={onAccept}
              activeOpacity={0.8}
              accessibilityLabel={t('calls.accept', 'Accept')}
            >
              <IconComponent
                name={incoming.type === 'video' ? 'videocam' : 'call'}
                size={28}
                color="#FFFFFF"
              />
            </TouchableOpacity>
            <ThemedText style={styles.actionLabel}>
              {t('calls.accept', 'Accept')}
            </ThemedText>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default IncomingCallOverlay;
