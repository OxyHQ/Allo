/**
 * Interop bridge (F3.x) — Connected accounts screen.
 *
 * Lets the user link/unlink external messaging accounts (Telegram first) so they
 * can chat with those contacts from Allo. Bridged conversations are NOT
 * end-to-end encrypted, which the screen states up front.
 *
 * Degrades gracefully when the backend has the bridge flag OFF: the accounts
 * query 404s and the screen shows a "not available" state instead of an error.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Linking,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@/hooks/useTheme';
import { toast } from '@/lib/sonner';
import { confirmDialog } from '@/utils/alerts';
import { SPACING } from '@/constants/spacing';
import { NETWORK_PRESENTATION } from '@/lib/bridge/networks';
import { useLinkedAccount, useInvalidateBridge } from '@/hooks/useBridge';
import { useBridgeLinkFlow } from '@/hooks/useBridgeLinkFlow';
import { unlinkAccount, type LinkedAccount, type LinkedAccountStatus } from '@/lib/bridge/api';

const IconComponent = Ionicons as React.ComponentType<{
  name: string;
  size: number;
  color: string;
}>;

/** The first (and currently only) bridgeable network surfaced by this screen. */
const TELEGRAM = 'telegram' as const;

/** Map a linked-account status to its localized label key. */
function statusLabelKey(status: LinkedAccountStatus | undefined): string {
  switch (status) {
    case 'active':
      return 'bridge.telegram.statusActive';
    case 'pending_login':
      return 'bridge.telegram.statusPendingLogin';
    case 'expired':
      return 'bridge.telegram.statusExpired';
    case 'revoked':
      return 'bridge.telegram.statusRevoked';
    case 'error':
      return 'bridge.telegram.statusError';
    default:
      return 'bridge.telegram.statusUnlinked';
  }
}

/** Human label for the connected external identity (username → phone hint). */
function identityLabel(account: LinkedAccount | undefined): string | undefined {
  const self = account?.externalSelf;
  if (!self) return undefined;
  if (self.username) return `@${self.username}`;
  if (self.displayName) return self.displayName;
  if (self.phoneHint) return self.phoneHint;
  return undefined;
}

export default function ConnectedAccountsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();

  const { account, isActive, isLoading, isUnavailable } = useLinkedAccount(TELEGRAM);
  const { invalidateAccounts } = useInvalidateBridge();
  const flow = useBridgeLinkFlow(TELEGRAM, invalidateAccounts);

  const [codeInput, setCodeInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');

  const unlinkMutation = useMutation({
    mutationFn: () => unlinkAccount(TELEGRAM),
    onSuccess: () => invalidateAccounts(),
  });

  const presentation = NETWORK_PRESENTATION[TELEGRAM];

  const styles = useMemo(() => createStyles(theme), [theme]);

  const handleDisconnect = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t('bridge.telegram.disconnectTitle'),
      message: t('bridge.telegram.disconnectMessage'),
      okText: t('bridge.telegram.disconnectConfirm'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await unlinkMutation.mutateAsync();
    } catch (error) {
      console.error('[ConnectedAccounts] Failed to disconnect Telegram:', error);
      toast.error(t('bridge.telegram.disconnectError'));
    }
  }, [t, unlinkMutation]);

  const handleOpenTelegram = useCallback(async () => {
    if (!flow.loginUrl) return;
    try {
      const supported = await Linking.canOpenURL(flow.loginUrl);
      if (!supported) {
        toast.error(t('bridge.telegram.openTelegramError'));
        return;
      }
      await Linking.openURL(flow.loginUrl);
    } catch (error) {
      console.error('[ConnectedAccounts] Failed to open Telegram login URL:', error);
      toast.error(t('bridge.telegram.openTelegramError'));
    }
  }, [flow.loginUrl, t]);

  const handleCopyLoginUrl = useCallback(async () => {
    if (!flow.loginUrl) return;
    try {
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(flow.loginUrl);
      toast.success(t('bridge.telegram.qrCopied'));
    } catch (error) {
      console.error('[ConnectedAccounts] Failed to copy login URL:', error);
      toast.error(t('bridge.telegram.openTelegramError'));
    }
  }, [flow.loginUrl, t]);

  const handleSubmitCode = useCallback(async () => {
    await flow.submitCode(codeInput);
    setCodeInput('');
  }, [flow, codeInput]);

  const handleSubmitPassword = useCallback(async () => {
    await flow.submitPassword(passwordInput);
    setPasswordInput('');
  }, [flow, passwordInput]);

  const renderHeader = () => (
    <Header
      options={{
        title: t('bridge.connectedAccounts.title'),
        leftComponents: [
          <HeaderIconButton key="back" onPress={() => router.back()}>
            <BackArrowIcon size={20} color={theme.colors.text} />
          </HeaderIconButton>,
        ],
      }}
      hideBottomBorder
      disableSticky
    />
  );

  // Bridge feature disabled server-side: graceful unavailable state.
  if (isUnavailable) {
    return (
      <ThemedView style={styles.screen}>
        {renderHeader()}
        <View style={styles.centeredState}>
          <IconComponent name="cloud-offline-outline" size={40} color={theme.colors.textSecondary} />
          <Text style={styles.stateTitle}>{t('bridge.unavailableTitle')}</Text>
          <Text style={styles.stateBody}>{t('bridge.unavailableBody')}</Text>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.screen}>
      {renderHeader()}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.intro}>{t('bridge.connectedAccounts.subtitle')}</Text>

        <View style={styles.card}>
          {/* Card header: network identity + status */}
          <View style={styles.cardHeader}>
            <View style={[styles.networkIcon, { backgroundColor: `${presentation.color}1A` }]}>
              <IconComponent name={presentation.icon} size={24} color={presentation.color} />
            </View>
            <View style={styles.cardHeaderText}>
              <Text style={styles.networkName}>{t('bridge.telegram.name')}</Text>
              <Text style={styles.networkStatus}>{t(statusLabelKey(account?.status))}</Text>
            </View>
            {isLoading && <ActivityIndicator size="small" color={theme.colors.primary} />}
          </View>

          {/* LINKED: identity + disconnect */}
          {isActive ? (
            <View style={styles.cardBody}>
              {identityLabel(account) && (
                <Text style={styles.identity}>
                  {t('bridge.telegram.linkedAs', { identity: identityLabel(account) })}
                </Text>
              )}
              <TouchableOpacity
                style={[styles.button, styles.dangerButton]}
                onPress={handleDisconnect}
                disabled={unlinkMutation.isPending}
                activeOpacity={0.8}
              >
                {unlinkMutation.isPending ? (
                  <ActivityIndicator size="small" color={theme.colors.error} />
                ) : (
                  <Text style={[styles.buttonText, styles.dangerButtonText]}>
                    {t('bridge.telegram.disconnect')}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            <LinkFlowBody
              flow={flow}
              styles={styles}
              theme={theme}
              t={t}
              codeInput={codeInput}
              setCodeInput={setCodeInput}
              passwordInput={passwordInput}
              setPasswordInput={setPasswordInput}
              onOpenTelegram={handleOpenTelegram}
              onCopyLoginUrl={handleCopyLoginUrl}
              onSubmitCode={handleSubmitCode}
              onSubmitPassword={handleSubmitPassword}
            />
          )}
        </View>
      </ScrollView>
    </ThemedView>
  );
}

type Styles = ReturnType<typeof createStyles>;
type ThemeValue = ReturnType<typeof useTheme>;
type Translate = ReturnType<typeof useTranslation>['t'];

interface LinkFlowBodyProps {
  flow: ReturnType<typeof useBridgeLinkFlow>;
  styles: Styles;
  theme: ThemeValue;
  t: Translate;
  codeInput: string;
  setCodeInput: (value: string) => void;
  passwordInput: string;
  setPasswordInput: (value: string) => void;
  onOpenTelegram: () => void;
  onCopyLoginUrl: () => void;
  onSubmitCode: () => void;
  onSubmitPassword: () => void;
}

/** Renders the active step of the connect flow (unlinked accounts only). */
function LinkFlowBody({
  flow,
  styles,
  theme,
  t,
  codeInput,
  setCodeInput,
  passwordInput,
  setPasswordInput,
  onOpenTelegram,
  onCopyLoginUrl,
  onSubmitCode,
  onSubmitPassword,
}: LinkFlowBodyProps) {
  const errorText = flow.error ? t(`bridge.telegram.${flow.error}`) : null;

  // Step: not started — single connect CTA.
  if (flow.step === 'idle' || flow.step === 'completed') {
    return (
      <View style={styles.cardBody}>
        <TouchableOpacity
          style={[styles.button, styles.primaryButton]}
          onPress={flow.begin}
          activeOpacity={0.8}
        >
          <Text style={[styles.buttonText, styles.primaryButtonText]}>
            {t('bridge.telegram.connect')}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Step: choose QR vs phone.
  if (flow.step === 'choose_method') {
    return (
      <View style={styles.cardBody}>
        <Text style={styles.stepTitle}>{t('bridge.telegram.chooseMethodTitle')}</Text>
        <TouchableOpacity
          style={styles.methodRow}
          onPress={() => void flow.chooseMethod('qr')}
          disabled={flow.isSubmitting}
          activeOpacity={0.8}
        >
          <IconComponent name="qr-code-outline" size={22} color={theme.colors.text} />
          <View style={styles.methodTextWrap}>
            <Text style={styles.methodTitle}>{t('bridge.telegram.methodQr')}</Text>
            <Text style={styles.methodDescription}>{t('bridge.telegram.methodQrDescription')}</Text>
          </View>
          {flow.isSubmitting && flow.method === 'qr' && (
            <ActivityIndicator size="small" color={theme.colors.primary} />
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.methodRow}
          onPress={() => void flow.chooseMethod('phone')}
          disabled={flow.isSubmitting}
          activeOpacity={0.8}
        >
          <IconComponent name="call-outline" size={22} color={theme.colors.text} />
          <View style={styles.methodTextWrap}>
            <Text style={styles.methodTitle}>{t('bridge.telegram.methodPhone')}</Text>
            <Text style={styles.methodDescription}>
              {t('bridge.telegram.methodPhoneDescription')}
            </Text>
          </View>
        </TouchableOpacity>
        {errorText && <Text style={styles.errorText}>{errorText}</Text>}
        <CancelLink styles={styles} t={t} onPress={flow.cancel} />
      </View>
    );
  }

  // Step: QR pending — show the login URL as a copyable code block + open attempt.
  if (flow.step === 'qr_pending') {
    return (
      <View style={styles.cardBody}>
        <Text style={styles.stepTitle}>{t('bridge.telegram.qrTitle')}</Text>
        <Text style={styles.stepHint}>{t('bridge.telegram.qrInstructions')}</Text>
        {flow.loginUrl ? (
          <>
            <View style={styles.codeBlock}>
              <Text style={styles.codeBlockText} selectable numberOfLines={4}>
                {flow.loginUrl}
              </Text>
            </View>
            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.button, styles.primaryButton, styles.buttonFlex]}
                onPress={onOpenTelegram}
                activeOpacity={0.8}
              >
                <Text style={[styles.buttonText, styles.primaryButtonText]}>
                  {t('bridge.telegram.qrOpen')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.secondaryButton, styles.buttonFlex]}
                onPress={onCopyLoginUrl}
                activeOpacity={0.8}
              >
                <Text style={[styles.buttonText, styles.secondaryButtonText]}>
                  {t('bridge.telegram.qrCopy')}
                </Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        )}
        <View style={styles.waitingRow}>
          <ActivityIndicator size="small" color={theme.colors.textSecondary} />
          <Text style={styles.stepHint}>{t('bridge.telegram.qrWaiting')}</Text>
        </View>
        <CancelLink styles={styles} t={t} onPress={flow.cancel} />
      </View>
    );
  }

  // Step: QR login failed/timed out — retryable.
  if (flow.step === 'qr_failed') {
    return (
      <View style={styles.cardBody}>
        <View style={styles.waitingRow}>
          <IconComponent name="alert-circle-outline" size={18} color={theme.colors.error} />
          <Text style={styles.errorText}>
            {errorText ?? t('bridge.telegram.linkStartError')}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.button, styles.primaryButton]}
          onPress={() => void flow.retryQr()}
          disabled={flow.isSubmitting}
          activeOpacity={0.8}
        >
          {flow.isSubmitting ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={[styles.buttonText, styles.primaryButtonText]}>
              {t('bridge.telegram.linkRetry')}
            </Text>
          )}
        </TouchableOpacity>
        <CancelLink styles={styles} t={t} onPress={flow.cancel} />
      </View>
    );
  }

  // Step: phone number input.
  if (flow.step === 'phone_number') {
    return (
      <View style={styles.cardBody}>
        <Text style={styles.stepTitle}>{t('bridge.telegram.phoneTitle')}</Text>
        <Text style={styles.inputLabel}>{t('bridge.telegram.phoneNumberLabel')}</Text>
        <TextInput
          style={styles.input}
          value={flow.phoneNumber}
          onChangeText={flow.setPhoneNumber}
          placeholder={t('bridge.telegram.phoneNumberPlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          keyboardType="phone-pad"
          autoFocus
          editable={!flow.isSubmitting}
        />
        {errorText && <Text style={styles.errorText}>{errorText}</Text>}
        <TouchableOpacity
          style={[styles.button, styles.primaryButton]}
          onPress={() => void flow.submitPhone()}
          disabled={flow.isSubmitting}
          activeOpacity={0.8}
        >
          {flow.isSubmitting ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={[styles.buttonText, styles.primaryButtonText]}>
              {t('bridge.telegram.phoneSubmit')}
            </Text>
          )}
        </TouchableOpacity>
        <CancelLink styles={styles} t={t} onPress={flow.cancel} />
      </View>
    );
  }

  // Step: phone code input.
  if (flow.step === 'phone_code') {
    return (
      <View style={styles.cardBody}>
        <Text style={styles.inputLabel}>{t('bridge.telegram.codeLabel')}</Text>
        <TextInput
          style={styles.input}
          value={codeInput}
          onChangeText={setCodeInput}
          placeholder={t('bridge.telegram.codePlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          keyboardType="number-pad"
          autoFocus
          editable={!flow.isSubmitting}
        />
        {errorText && <Text style={styles.errorText}>{errorText}</Text>}
        <TouchableOpacity
          style={[styles.button, styles.primaryButton]}
          onPress={onSubmitCode}
          disabled={flow.isSubmitting}
          activeOpacity={0.8}
        >
          {flow.isSubmitting ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={[styles.buttonText, styles.primaryButtonText]}>
              {t('bridge.telegram.codeSubmit')}
            </Text>
          )}
        </TouchableOpacity>
        <CancelLink styles={styles} t={t} onPress={flow.cancel} />
      </View>
    );
  }

  // Step: 2FA password input.
  if (flow.step === 'phone_password') {
    return (
      <View style={styles.cardBody}>
        <Text style={styles.inputLabel}>{t('bridge.telegram.passwordLabel')}</Text>
        <Text style={styles.stepHint}>{t('bridge.telegram.passwordHint')}</Text>
        <TextInput
          style={styles.input}
          value={passwordInput}
          onChangeText={setPasswordInput}
          placeholder={t('bridge.telegram.passwordPlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          secureTextEntry
          autoFocus
          editable={!flow.isSubmitting}
        />
        {errorText && <Text style={styles.errorText}>{errorText}</Text>}
        <TouchableOpacity
          style={[styles.button, styles.primaryButton]}
          onPress={onSubmitPassword}
          disabled={flow.isSubmitting}
          activeOpacity={0.8}
        >
          {flow.isSubmitting ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={[styles.buttonText, styles.primaryButtonText]}>
              {t('bridge.telegram.passwordSubmit')}
            </Text>
          )}
        </TouchableOpacity>
        <CancelLink styles={styles} t={t} onPress={flow.cancel} />
      </View>
    );
  }

  return null;
}

/** Small "cancel" text affordance shared by every in-progress step. */
function CancelLink({
  styles,
  t,
  onPress,
}: {
  styles: Styles;
  t: Translate;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={styles.cancelLink}>
      <Text style={styles.cancelLinkText}>{t('common.cancel')}</Text>
    </TouchableOpacity>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    screen: {
      flex: 1,
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: 16,
      paddingTop: SPACING.screen.vertical,
      paddingBottom: 32,
    },
    intro: {
      fontSize: 13,
      lineHeight: 18,
      color: theme.colors.textSecondary,
      marginBottom: 16,
    },
    card: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.card,
      overflow: 'hidden',
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    cardHeaderText: {
      flex: 1,
    },
    networkIcon: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
    },
    networkName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    networkStatus: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    cardBody: {
      paddingHorizontal: 16,
      paddingBottom: 16,
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
      paddingTop: 14,
    },
    identity: {
      fontSize: 14,
      color: theme.colors.text,
    },
    stepTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
    },
    stepHint: {
      fontSize: 13,
      lineHeight: 18,
      color: theme.colors.textSecondary,
      flexShrink: 1,
    },
    inputLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.text,
    },
    input: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: theme.colors.text,
      backgroundColor: theme.colors.background,
    },
    codeBlock: {
      borderRadius: 12,
      backgroundColor: theme.colors.background,
      borderWidth: 1,
      borderColor: theme.colors.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    codeBlockText: {
      fontSize: 13,
      color: theme.colors.text,
      fontFamily: 'monospace',
    },
    button: {
      minHeight: 46,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
    },
    buttonRow: {
      flexDirection: 'row',
      gap: 12,
    },
    buttonFlex: {
      flex: 1,
    },
    buttonText: {
      fontSize: 15,
      fontWeight: '600',
    },
    primaryButton: {
      backgroundColor: theme.colors.primary,
    },
    primaryButtonText: {
      color: '#FFFFFF',
    },
    secondaryButton: {
      backgroundColor: theme.colors.backgroundSecondary,
    },
    secondaryButtonText: {
      color: theme.colors.text,
    },
    dangerButton: {
      borderWidth: 1,
      borderColor: theme.colors.error,
      backgroundColor: 'transparent',
    },
    dangerButtonText: {
      color: theme.colors.error,
    },
    methodRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    methodTextWrap: {
      flex: 1,
    },
    methodTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
    },
    methodDescription: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    waitingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    errorText: {
      fontSize: 13,
      color: theme.colors.error,
    },
    cancelLink: {
      alignSelf: 'center',
      paddingVertical: 6,
    },
    cancelLinkText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      fontWeight: '500',
    },
    centeredState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      gap: 12,
    },
    stateTitle: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text,
    },
    stateBody: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
  });
}
