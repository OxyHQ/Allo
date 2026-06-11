import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Platform,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { useCallsStore } from '@/stores/callsStore';
import { useUserById } from '@/stores/usersStore';
import { RTCView } from '@/lib/webrtc';

const IconComponent = Ionicons as any;

function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

export default function CallScreen() {
  const router = useRouter();
  const { t } = useTranslation();

  const active = useCallsStore((s) => s.active);
  const localStream = useCallsStore((s) => s.localStream);
  const remoteStream = useCallsStore((s) => s.remoteStream);
  const localStreamURL = useCallsStore((s) => s.localStreamURL);
  const remoteStreamURL = useCallsStore((s) => s.remoteStreamURL);
  const endCall = useCallsStore((s) => s.endCall);
  const cancel = useCallsStore((s) => s.cancel);
  const toggleMute = useCallsStore((s) => s.toggleMute);
  const toggleCamera = useCallsStore((s) => s.toggleCamera);
  const toggleSpeaker = useCallsStore((s) => s.toggleSpeaker);
  const swapCamera = useCallsStore((s) => s.swapCamera);

  const peer = useUserById(active?.peerId);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // If the active call ends/disappears, leave the screen.
  useEffect(() => {
    if (!active || active.state === 'ended') {
      const timer = setTimeout(() => {
        if (router.canGoBack()) router.back();
        else router.replace('/calls' as never);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [active, router]);

  const peerName = useMemo(() => {
    if (!active) return '';
    if (peer) {
      if (typeof peer.name === 'string') return peer.name;
      if (peer.name?.full) return peer.name.full;
      const first = peer.name?.first || '';
      const last = peer.name?.last || '';
      const composed = `${first} ${last}`.trim();
      return composed || peer.username || peer.handle || active.peerId;
    }
    return active.peerId;
  }, [active, peer]);

  const elapsedSec = useMemo(() => {
    if (!active?.connectedAt) return 0;
    return Math.max(0, Math.floor((now - active.connectedAt.getTime()) / 1000));
  }, [active?.connectedAt, now]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: {
          flex: 1,
          backgroundColor: '#000',
        },
        remoteWrap: {
          ...StyleSheet.absoluteFill,
          backgroundColor: '#000',
        },
        remoteView: {
          flex: 1,
          backgroundColor: '#000',
        },
        audioBackdrop: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          paddingHorizontal: 24,
        },
        topOverlay: {
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          paddingHorizontal: 24,
          paddingTop: 24,
          alignItems: 'center',
          gap: 4,
        },
        peerName: {
          fontSize: 24,
          fontWeight: '700',
          color: '#FFFFFF',
          textAlign: 'center',
          textShadowColor: 'rgba(0,0,0,0.6)',
          textShadowRadius: 6,
        },
        statusText: {
          color: 'rgba(255,255,255,0.85)',
          fontSize: 15,
          marginTop: 6,
        },
        pip: {
          position: 'absolute',
          top: 24,
          right: 16,
          width: 110,
          height: 160,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: '#111',
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: 'rgba(255,255,255,0.2)',
        },
        controlsRow: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 32,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 18,
          paddingHorizontal: 16,
        },
        controlButton: {
          width: 60,
          height: 60,
          borderRadius: 30,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'rgba(255,255,255,0.15)',
        },
        controlButtonActive: {
          backgroundColor: '#FFFFFF',
        },
        hangup: {
          width: 68,
          height: 68,
          borderRadius: 34,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#FF3B30',
        },
      }),
    []
  );

  if (!active) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ThemedText style={{ color: '#FFFFFF' }}>
            {t('calls.notActive', 'No active call')}
          </ThemedText>
        </View>
      </SafeAreaView>
    );
  }

  const showRemoteVideo =
    active.type === 'video' &&
    (active.state === 'connected' || active.state === 'connecting') &&
    !!(remoteStream || remoteStreamURL);

  const stateLabel =
    active.state === 'ringing'
      ? t('calls.stateRinging', 'Ringing…')
      : active.state === 'connecting'
        ? t('calls.stateConnecting', 'Connecting…')
        : active.state === 'connected'
          ? formatDuration(elapsedSec)
          : t('calls.stateEnded', 'Call ended');

  const onHangup = async () => {
    if (active.role === 'caller' && active.state === 'ringing') {
      await cancel();
    } else {
      await endCall();
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />

      {/* Remote video (full screen) or audio backdrop */}
      <View style={styles.remoteWrap}>
        {showRemoteVideo ? (
          <RTCView
            style={styles.remoteView}
            stream={remoteStream}
            streamURL={remoteStreamURL}
            objectFit="cover"
          />
        ) : (
          <View style={styles.audioBackdrop}>
            <Avatar source={peer?.avatar} size={160} />
          </View>
        )}
      </View>

      {/* Top overlay (name + status). Always shown. */}
      <View style={styles.topOverlay} pointerEvents="none">
        <ThemedText style={styles.peerName}>{peerName}</ThemedText>
        <ThemedText style={styles.statusText}>{stateLabel}</ThemedText>
      </View>

      {/* Local PiP — only for video calls with a live local stream */}
      {active.type === 'video' && (localStream || localStreamURL) && (
        <View style={styles.pip}>
          <RTCView
            style={{ flex: 1 }}
            stream={localStream}
            streamURL={localStreamURL}
            objectFit="cover"
            mirror={active.facing === 'user'}
            muted
          />
        </View>
      )}

      {/* Control bar */}
      <View style={styles.controlsRow}>
        <TouchableOpacity
          style={[styles.controlButton, active.muted && styles.controlButtonActive]}
          onPress={toggleMute}
          activeOpacity={0.8}
          accessibilityLabel={t('calls.toggleMute', 'Mute')}
        >
          <IconComponent
            name={active.muted ? 'mic-off' : 'mic'}
            size={26}
            color={active.muted ? '#000' : '#FFFFFF'}
          />
        </TouchableOpacity>

        {active.type === 'video' ? (
          <TouchableOpacity
            style={[styles.controlButton, !active.cameraOn && styles.controlButtonActive]}
            onPress={toggleCamera}
            activeOpacity={0.8}
            accessibilityLabel={t('calls.toggleCamera', 'Camera')}
          >
            <IconComponent
              name={active.cameraOn ? 'videocam' : 'videocam-off'}
              size={26}
              color={!active.cameraOn ? '#000' : '#FFFFFF'}
            />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.controlButton, active.speakerOn && styles.controlButtonActive]}
            onPress={toggleSpeaker}
            activeOpacity={0.8}
            accessibilityLabel={t('calls.toggleSpeaker', 'Speaker')}
          >
            <IconComponent
              name={active.speakerOn ? 'volume-high' : 'volume-medium'}
              size={26}
              color={active.speakerOn ? '#000' : '#FFFFFF'}
            />
          </TouchableOpacity>
        )}

        {active.type === 'video' && Platform.OS !== 'web' && (
          <TouchableOpacity
            style={styles.controlButton}
            onPress={swapCamera}
            activeOpacity={0.8}
            accessibilityLabel={t('calls.swapCamera', 'Switch camera')}
          >
            <IconComponent name="camera-reverse" size={26} color="#FFFFFF" />
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={styles.hangup}
          onPress={onHangup}
          activeOpacity={0.8}
          accessibilityLabel={t('calls.hangup', 'Hang up')}
        >
          <IconComponent
            name="call"
            size={28}
            color="#FFFFFF"
            style={{ transform: [{ rotate: '135deg' }] }}
          />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
