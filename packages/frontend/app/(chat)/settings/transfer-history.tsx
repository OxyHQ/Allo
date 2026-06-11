import { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useFocusEffect } from '@react-navigation/native';

import { useOxy } from '@oxyhq/services';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@/hooks/useTheme';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import { useConversationsStore } from '@/stores/conversationsStore';
import {
  generateTransferSecret,
  encodePairingPayload,
  formatPairingCodeForDisplay,
  startHistoryReceive,
  type TransferDriverProgress,
  type TransferHandle,
} from '@/lib/historyTransfer';
import { SPACING, SPACING_CLASSES } from '@/constants/spacing';

const IconComponent = Ionicons as unknown as React.ComponentType<{
  name: string;
  size: number;
  color: string;
}>;

/** UI phases for the receive flow. */
type ReceivePhase = 'idle' | 'waiting' | 'transferring' | 'applying' | 'done' | 'error';

export default function TransferHistoryReceiveScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useOxy();
  const ownDeviceId = useDeviceKeysStore((state) => state.deviceKeys?.deviceId);
  const refreshConversations = useConversationsStore((state) => state.refreshConversations);
  // Both identifiers must be present before we can mint a pairing code.
  const ready = !!user?.id && ownDeviceId !== undefined;

  const [phase, setPhase] = useState<ReceivePhase>('idle');
  const [progress, setProgress] = useState<TransferDriverProgress | null>(null);

  // The running receive handle (so we can cancel on blur / restart). The pairing
  // code is held in state so it renders; the secret only needs to live inside the
  // active receive driver, so it is not retained separately.
  const handleRef = useRef<TransferHandle | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  /** Start (or restart) listening: mint a fresh secret, show its code, accept. */
  const startListening = useCallback(() => {
    const userId = user?.id;
    if (!userId || ownDeviceId === undefined) return;
    // Tear down any prior attempt before starting a new one.
    handleRef.current?.cancel();
    handleRef.current = null;

    const secret = generateTransferSecret();
    const code = encodePairingPayload({
      userId,
      deviceId: ownDeviceId,
      secret,
    });
    setPairingCode(code);
    setProgress(null);
    setPhase('waiting');

    // The transport's `selfDeviceId` is owned by `useP2PMessaging` (mounted at
    // the chat layout, above this screen), so it is already in sync here.
    handleRef.current = startHistoryReceive(secret, userId, {
      onProgress: (p) => {
        setProgress(p);
        if (p.phase === 'transferring') setPhase('transferring');
        else if (p.phase === 'applying') setPhase('applying');
      },
      onComplete: () => {
        setPhase('done');
        // Refresh the conversation list so the imported history appears.
        void refreshConversations();
      },
      onError: (reason) => {
        // A user-initiated cancel returns us to the waiting state silently;
        // other failures surface the error screen. The underlying reason is
        // already logged by the transport layer.
        if (reason === 'user_cancelled') return;
        setPhase('error');
      },
    });
  }, [ownDeviceId, refreshConversations, user?.id]);

  // Auto-start when the screen gains focus; cancel when it loses focus so a
  // dangling responder never lingers after the user navigates away.
  useFocusEffect(
    useCallback(() => {
      startListening();
      return () => {
        handleRef.current?.cancel();
        handleRef.current = null;
      };
    }, [startListening])
  );

  const groupedCode = useMemo(
    () => (pairingCode ? formatPairingCodeForDisplay(pairingCode) : ''),
    [pairingCode]
  );

  const onRetry = useCallback(() => {
    startListening();
  }, [startListening]);

  const onDone = useCallback(() => {
    router.back();
  }, []);

  const content = useMemo(() => {
    if (!ready) {
      return (
        <View className="items-center justify-center py-12">
          <ActivityIndicator color={theme.colors.primary} />
          <Text className="text-[14px] mt-3" style={{ color: theme.colors.textSecondary }}>
            {t('settings.transferHistory.initializing', 'Preparing secure transfer…')}
          </Text>
        </View>
      );
    }

    if (phase === 'done') {
      return (
        <View className="items-center justify-center py-12">
          <IconComponent name="checkmark-circle" size={56} color={theme.colors.primary} />
          <Text className="text-[17px] font-semibold mt-4" style={{ color: theme.colors.text }}>
            {t('settings.transferHistory.receiveDoneTitle', 'History received')}
          </Text>
          <Text
            className="text-[14px] text-center mt-2 px-6"
            style={{ color: theme.colors.textSecondary }}
          >
            {t(
              'settings.transferHistory.receiveDoneBody',
              'Your conversations have been restored on this device.'
            )}
          </Text>
          <TouchableOpacity
            className="mt-6 px-6 py-3 rounded-full"
            style={{ backgroundColor: theme.colors.primary }}
            onPress={onDone}
            activeOpacity={0.85}
          >
            <Text className="text-[15px] font-semibold" style={{ color: theme.colors.card }}>
              {t('common.done', 'Done')}
            </Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (phase === 'error') {
      return (
        <View className="items-center justify-center py-12">
          <IconComponent name="alert-circle-outline" size={52} color={theme.colors.error} />
          <Text className="text-[16px] font-semibold mt-4" style={{ color: theme.colors.text }}>
            {t('settings.transferHistory.errorTitle', 'Transfer failed')}
          </Text>
          <Text
            className="text-[14px] text-center mt-2 px-6"
            style={{ color: theme.colors.textSecondary }}
          >
            {t(
              'settings.transferHistory.errorBody',
              'The transfer could not be completed. No data was changed on this device. Start a new transfer to try again.'
            )}
          </Text>
          <TouchableOpacity
            className="mt-6 px-6 py-3 rounded-full"
            style={{ backgroundColor: theme.colors.primary }}
            onPress={onRetry}
            activeOpacity={0.85}
          >
            <Text className="text-[15px] font-semibold" style={{ color: theme.colors.card }}>
              {t('settings.transferHistory.retry', 'Try again')}
            </Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (phase === 'transferring' || phase === 'applying') {
      const current = progress?.current ?? 0;
      const total = progress?.total ?? 0;
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      return (
        <View className="items-center justify-center py-12">
          <ActivityIndicator color={theme.colors.primary} size="large" />
          <Text className="text-[16px] font-semibold mt-4" style={{ color: theme.colors.text }}>
            {phase === 'applying'
              ? t('settings.transferHistory.applying', 'Finishing up…')
              : t('settings.transferHistory.receiving', 'Receiving history…')}
          </Text>
          {total > 0 ? (
            <Text className="text-[14px] mt-2" style={{ color: theme.colors.textSecondary }}>
              {t('settings.transferHistory.progressPercent', {
                pct,
                defaultValue: '{{pct}}%',
              })}
            </Text>
          ) : null}
          {progress && progress.totalMessages > 0 ? (
            <Text className="text-[13px] mt-1" style={{ color: theme.colors.textTertiary }}>
              {t('settings.transferHistory.progressCounts', {
                conversations: progress.conversationCount,
                messages: progress.totalMessages,
                defaultValue: '{{conversations}} chats · {{messages}} messages',
              })}
            </Text>
          ) : null}
        </View>
      );
    }

    // waiting: show the pairing code for the old device to enter.
    return (
      <View className="items-center">
        <View
          className="rounded-2xl border w-full items-center"
          style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}
        >
          <View className="py-6 px-5 items-center">
            <IconComponent name="key-outline" size={28} color={theme.colors.primary} />
            <Text
              className="text-[13px] text-center mt-3 mb-4"
              style={{ color: theme.colors.textSecondary }}
            >
              {t(
                'settings.transferHistory.enterCodeHint',
                'On your other device, open Linked Devices → Transfer history and enter this code:'
              )}
            </Text>
            <Text
              className="text-[22px] font-semibold tracking-wider text-center"
              style={{ color: theme.colors.text }}
              accessibilityLabel={t('settings.transferHistory.codeLabel', 'Transfer code')}
              selectable
            >
              {groupedCode}
            </Text>
          </View>
        </View>

        <View className="flex-row items-center mt-6">
          <ActivityIndicator color={theme.colors.textSecondary} />
          <Text className="text-[14px] ml-3" style={{ color: theme.colors.textSecondary }}>
            {t('settings.transferHistory.waiting', 'Waiting for the other device…')}
          </Text>
        </View>
      </View>
    );
  }, [groupedCode, onDone, onRetry, phase, progress, ready, t, theme.colors]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.transferHistory.receiveTitle', 'Receive history'),
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView className={SPACING_CLASSES.screen} showsVerticalScrollIndicator={false}>
        <Text
          className={`text-[13px] mb-${SPACING.content.gapLarge} px-1`}
          style={{ color: theme.colors.textSecondary }}
        >
          {t(
            'settings.transferHistory.receiveSubtitle',
            'Copy your existing chats from another device you are signed in on. The transfer is end-to-end encrypted and goes directly between your devices.'
          )}
        </Text>
        {content}
      </ScrollView>
    </ThemedView>
  );
}
