import { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { useOxy } from '@oxyhq/services';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@/hooks/useTheme';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import {
  decodePairingPayload,
  startHistorySend,
  type PairingPayload,
  type TransferDriverProgress,
  type TransferHandle,
} from '@/lib/historyTransfer';
import { SPACING, SPACING_CLASSES } from '@/constants/spacing';

const IconComponent = Ionicons as unknown as React.ComponentType<{
  name: string;
  size: number;
  color: string;
}>;

/** UI phases for the send flow. */
type SendPhase = 'entry' | 'connecting' | 'transferring' | 'done' | 'error';

export default function TransferHistorySendScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user } = useOxy();
  const ownDeviceId = useDeviceKeysStore((state) => state.deviceKeys?.deviceId);

  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<SendPhase>('entry');
  const [progress, setProgress] = useState<TransferDriverProgress | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  const handleRef = useRef<TransferHandle | null>(null);

  const beginSend = useCallback(
    (pairing: PairingPayload) => {
      // The transport's `selfDeviceId` is owned by `useP2PMessaging` (mounted at
      // the chat layout, above this screen), so the receiver will learn which
      // device it is talking to via the signaling `fromDeviceId`.
      setPhase('connecting');
      setProgress(null);

      handleRef.current = startHistorySend(pairing, {
        onProgress: (p) => {
          setProgress(p);
          if (p.phase === 'transferring') setPhase('transferring');
        },
        onComplete: () => setPhase('done'),
        onError: (reason) => {
          // A user-initiated cancel returns to entry; other failures show the
          // error screen. The underlying reason is logged by the transport layer.
          if (reason === 'user_cancelled') {
            setPhase('entry');
            return;
          }
          setPhase('error');
        },
      });
    },
    []
  );

  const onStart = useCallback(() => {
    setCodeError(null);
    let pairing: PairingPayload;
    try {
      pairing = decodePairingPayload(code);
    } catch {
      setCodeError(
        t('settings.transferHistory.invalidCode', 'That code is not valid. Check it and try again.')
      );
      return;
    }
    // The code must belong to the SAME account (history is only ever shared
    // between a user's own devices), and must not point back at this device.
    const ownUserId = user?.id;
    if (ownUserId && pairing.userId !== ownUserId) {
      setCodeError(
        t(
          'settings.transferHistory.differentAccount',
          'That code is for a different account. History can only be shared between your own devices.'
        )
      );
      return;
    }
    if (ownUserId && pairing.userId === ownUserId && pairing.deviceId === ownDeviceId) {
      setCodeError(
        t('settings.transferHistory.sameDevice', 'This is the same device. Use the code from your new device.')
      );
      return;
    }
    beginSend(pairing);
  }, [beginSend, code, ownDeviceId, t, user?.id]);

  const onCancel = useCallback(() => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setPhase('entry');
  }, []);

  const onRetry = useCallback(() => {
    setPhase('entry');
  }, []);

  const content = useMemo(() => {
    if (phase === 'done') {
      return (
        <View className="items-center justify-center py-12">
          <IconComponent name="checkmark-circle" size={56} color={theme.colors.primary} />
          <Text className="text-[17px] font-semibold mt-4" style={{ color: theme.colors.text }}>
            {t('settings.transferHistory.sendDoneTitle', 'History sent')}
          </Text>
          <Text
            className="text-[14px] text-center mt-2 px-6"
            style={{ color: theme.colors.textSecondary }}
          >
            {t(
              'settings.transferHistory.sendDoneBody',
              'Your chats have been copied to the other device.'
            )}
          </Text>
          <TouchableOpacity
            className="mt-6 px-6 py-3 rounded-full"
            style={{ backgroundColor: theme.colors.primary }}
            onPress={() => router.back()}
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
              'settings.transferHistory.sendErrorBody',
              'The transfer could not be completed. Make sure both devices are online, then try again.'
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

    if (phase === 'connecting' || phase === 'transferring') {
      const current = progress?.current ?? 0;
      const total = progress?.total ?? 0;
      const pct = total > 0 ? Math.round((current / total) * 100) : 0;
      return (
        <View className="items-center justify-center py-12">
          <ActivityIndicator color={theme.colors.primary} size="large" />
          <Text className="text-[16px] font-semibold mt-4" style={{ color: theme.colors.text }}>
            {phase === 'connecting'
              ? t('settings.transferHistory.connecting', 'Connecting to the other device…')
              : t('settings.transferHistory.sending', 'Sending history…')}
          </Text>
          {total > 0 ? (
            <Text className="text-[14px] mt-2" style={{ color: theme.colors.textSecondary }}>
              {t('settings.transferHistory.progressPercent', { pct, defaultValue: '{{pct}}%' })}
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
          <TouchableOpacity
            className="mt-6 px-6 py-2.5 rounded-full border"
            style={{ borderColor: theme.colors.border }}
            onPress={onCancel}
            activeOpacity={0.7}
          >
            <Text className="text-[14px] font-medium" style={{ color: theme.colors.textSecondary }}>
              {t('common.cancel', 'Cancel')}
            </Text>
          </TouchableOpacity>
        </View>
      );
    }

    // entry: manual code input.
    return (
      <View>
        <View
          className="rounded-2xl border px-4 py-4"
          style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}
        >
          <Text className="text-[14px] font-medium mb-2" style={{ color: theme.colors.text }}>
            {t('settings.transferHistory.codeInputLabel', 'Transfer code')}
          </Text>
          <TextInput
            className="text-[16px] rounded-xl px-3 py-3"
            style={{
              color: theme.colors.text,
              backgroundColor: theme.colors.background,
              borderColor: codeError ? theme.colors.error : theme.colors.border,
              borderWidth: 1,
            }}
            placeholder={t('settings.transferHistory.codePlaceholder', 'Enter the code from your new device')}
            placeholderTextColor={theme.colors.textTertiary}
            value={code}
            onChangeText={(text) => {
              setCode(text);
              if (codeError) setCodeError(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            multiline
            returnKeyType="done"
          />
          {codeError ? (
            <Text className="text-[13px] mt-2" style={{ color: theme.colors.error }}>
              {codeError}
            </Text>
          ) : null}
        </View>

        <TouchableOpacity
          className="mt-6 px-6 py-3 rounded-full items-center"
          style={{
            backgroundColor: code.trim().length > 0 ? theme.colors.primary : theme.colors.border,
          }}
          onPress={onStart}
          disabled={code.trim().length === 0}
          activeOpacity={0.85}
        >
          <Text
            className="text-[15px] font-semibold"
            style={{ color: code.trim().length > 0 ? theme.colors.card : theme.colors.textTertiary }}
          >
            {t('settings.transferHistory.startSend', 'Start transfer')}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }, [code, codeError, onCancel, onRetry, onStart, phase, progress, t, theme.colors]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.transferHistory.sendTitle', 'Transfer history'),
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView
        className={SPACING_CLASSES.screen}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Text
          className={`text-[13px] mb-${SPACING.content.gapLarge} px-1`}
          style={{ color: theme.colors.textSecondary }}
        >
          {t(
            'settings.transferHistory.sendSubtitle',
            'Copy your chats from this device to another device you are signing in on. On the new device, open Receive history to get its code.'
          )}
        </Text>
        {content}
      </ScrollView>
    </ThemedView>
  );
}
