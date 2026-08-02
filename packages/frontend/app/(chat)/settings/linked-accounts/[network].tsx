import React, { useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Button } from '@oxyhq/bloom/button';
import { TextFieldInput } from '@oxyhq/bloom';
import { useTranslation } from 'react-i18next';

import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { BanRiskWarning } from '@/components/bridges/BanRiskWarning';
import { LoginStepDisplay } from '@/components/bridges/LoginStepDisplay';
import { LoginStepForm } from '@/components/bridges/LoginStepForm';
import { NetworkGlyph } from '@/components/bridges/NetworkGlyph';
import { useTheme } from '@/hooks/useTheme';
import { useBridgeLinkAttempt } from '@/hooks/useBridgeLinkAttempt';
import { useBridgeNetworks } from '@/hooks/useBridges';
import type { BridgeNetwork } from '@/lib/bridges/contract';
import {
  missingCapabilities,
  requiresBanWarning,
  wantsPhoneNumberHint,
} from '@/lib/bridges/networkPresentation';

/**
 * Linking one network, one server-driven step at a time
 * (`docs/matrix/bridges.md` §5.2, §6).
 *
 * ## Nothing here knows what Telegram asks for
 *
 * §6.2 documents Telegram's flow as phone → code → optional password → complete,
 * and §6.3 documents WhatsApp's as a QR that refreshes five times inside about
 * 2m40s. Neither sequence appears in this file. The bridge sends a step, the app
 * draws it, the answer goes back, another step arrives. That is the only way a
 * client survives a bridge release — mautrix ships monthly, and §10.1 rates
 * breakage-by-bridge-update as near certain.
 *
 * ## What the user is told, before anything is sent
 *
 * Two things, and both are gates rather than footnotes:
 *
 * 1. **The account-ban warning**, for any network whose `requiresProxy` is true.
 *    Those networks ban accounts caught on unofficial clients; the residential
 *    proxy reduces one signal and does not make the client official. The account
 *    at stake is the user's.
 * 2. **What the network cannot do once linked** — §11's Telegram secret chats,
 *    which are architecturally unbridgeable and which a user who is not warned
 *    will report as Allo being broken.
 *
 * Neither names a network. Both read what the catalogue said, so a network turned
 * on next month is covered without an app release.
 */

export default function LinkNetworkScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const params = useLocalSearchParams<{ network?: string }>();
  const networkId = typeof params.network === 'string' ? params.network : '';

  const networks = useBridgeNetworks();
  /**
   * The network as the SERVER describes it. A screen reached with an id the
   * catalogue does not contain has nothing to draw and no flow to start — which
   * is the same answer the API gives for a disabled network, and for the same
   * reason: it does not exist here.
   */
  const network = networks.data?.find((candidate) => candidate.id === networkId);

  const attempt = useBridgeLinkAttempt(networkId);

  const title = network?.displayName ?? networkId;

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title,
          leftComponents: [
            <HeaderIconButton
              key="back"
              onPress={() => {
                attempt.cancel();
                router.back();
              }}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-5 pb-10"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {networks.isLoading ? (
          <View className="py-10 items-center">
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : network === undefined ? (
          <ThemedText style={{ color: theme.colors.textSecondary }}>
            {t('bridges.link.unavailable', {
              defaultValue: 'This network is not available on this server.',
            })}
          </ThemedText>
        ) : attempt.attempt === undefined ? (
          <BeforeLinking network={network} onStart={attempt.start} busy={attempt.isStarting} />
        ) : (
          <DuringLinking network={network} attempt={attempt} />
        )}

        {attempt.error !== undefined && (
          <ThemedText className="mt-4 text-sm" style={{ color: theme.colors.error }}>
            {attempt.error.message}
          </ThemedText>
        )}
      </ScrollView>
    </ThemedView>
  );
}

interface BeforeLinkingProps {
  readonly network: BridgeNetwork;
  readonly busy: boolean;
  readonly onStart: (input: { flowId: string; phoneNumberHint?: string }) => void;
}

/**
 * Everything the user should know, and the choice of how to sign in.
 *
 * The flow picker is only drawn when there is a choice. §5.2 already filters the
 * flows nobody should be offered — Telegram's `bot` and `manual`, the latter
 * described by the bridge itself as "advanced, do not use" — so what arrives here
 * is a list of ways a person can legitimately sign in, and a list of one is not a
 * question worth asking.
 */
function BeforeLinking({ network, busy, onStart }: BeforeLinkingProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [flowId, setFlowId] = useState<string>(network.loginFlows[0]?.id ?? '');
  const [phoneNumberHint, setPhoneNumberHint] = useState('');

  const needsWarning = requiresBanWarning(network);
  const wantsHint = wantsPhoneNumberHint(network);
  const gaps = missingCapabilities(network);
  const selected = network.loginFlows.find((flow) => flow.id === flowId);

  return (
    <View>
      <View className="items-center py-4">
        <NetworkGlyph
          networkId={network.id}
          displayName={network.displayName}
          size={44}
          color={theme.colors.text}
        />
      </View>

      {needsWarning && <BanRiskWarning networkDisplayName={network.displayName} />}

      {gaps.map((capability) => (
        <View
          key={capability}
          className="mb-4 rounded-2xl p-4"
          style={{ backgroundColor: theme.colors.backgroundSecondary }}
        >
          <ThemedText className="text-sm" style={{ color: theme.colors.textSecondary }}>
            {t(`bridges.capability.${capability}`, {
              network: network.displayName,
              defaultValue: CAPABILITY_FALLBACKS[capability] ?? capability,
            })}
          </ThemedText>
        </View>
      ))}

      {network.loginFlows.length > 1 && (
        <View className="mb-4">
          <ThemedText className="mb-2 text-sm" style={{ color: theme.colors.textSecondary }}>
            {t('bridges.link.chooseFlow', { defaultValue: 'How do you want to sign in?' })}
          </ThemedText>
          {network.loginFlows.map((flow) => {
            const isSelected = flow.id === flowId;
            return (
              <Button
                key={flow.id}
                variant={isSelected ? 'primary' : 'secondary'}
                onPress={() => setFlowId(flow.id)}
                style={{ marginBottom: 8 }}
              >
                {flow.name}
              </Button>
            );
          })}
        </View>
      )}

      {selected?.description !== undefined && (
        <ThemedText className="mb-4 text-sm" style={{ color: theme.colors.textSecondary }}>
          {selected.description}
        </ThemedText>
      )}

      {wantsHint && (
        <View className="mb-4">
          <TextFieldInput
            label={t('bridges.link.phoneHint', {
              defaultValue: 'Your phone number, with country code',
            })}
            value={phoneNumberHint}
            onChangeText={setPhoneNumberHint}
            keyboardType="phone-pad"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {/*
            * §5.5 and §8.3 rule 2: this number is used only to choose which
            * country the connection to the remote network leaves from, and is
            * never stored. Saying so is the point — asking for a phone number
            * before a login has started otherwise looks like collection.
            */}
          <ThemedText className="mt-1 text-xs" style={{ color: theme.colors.textSecondary }}>
            {t('bridges.link.phoneHintExplainer', {
              defaultValue:
                'Used only to pick which country Allo connects from, so the network does not see the login as coming from a data centre. It is not stored.',
            })}
          </ThemedText>
        </View>
      )}

      <Button
        variant="primary"
        disabled={flowId.length === 0}
        loading={busy}
        onPress={() =>
          onStart({
            flowId,
            ...(wantsHint && phoneNumberHint.trim().length > 0
              ? { phoneNumberHint: phoneNumberHint.trim() }
              : {}),
          })
        }
      >
        {needsWarning
          ? t('bridges.link.startAccepting', {
              defaultValue: 'I understand the risk — continue',
            })
          : t('bridges.link.start', { defaultValue: 'Continue' })}
      </Button>
    </View>
  );
}

/** English fallbacks for capabilities the catalogue can report as missing. */
const CAPABILITY_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  secretChats:
    'Secret chats cannot be brought into Allo. They are tied to the device that started them, so no other client can open them — including this one.',
});

interface DuringLinkingProps {
  readonly network: BridgeNetwork;
  readonly attempt: ReturnType<typeof useBridgeLinkAttempt>;
}

function DuringLinking({ network, attempt }: DuringLinkingProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const state = attempt.attempt;
  if (state === undefined) return null;
  const step = state.step;

  if (step.type === 'complete') {
    return (
      <View className="py-6">
        <ThemedText className="text-lg font-semibold" style={{ color: theme.colors.text }}>
          {t('bridges.link.done', {
            network: network.displayName,
            defaultValue: '{{network}} is linked',
          })}
        </ThemedText>
        <ThemedText className="mt-2 text-sm" style={{ color: theme.colors.textSecondary }}>
          {t('bridges.link.doneBody', {
            defaultValue:
              'Your conversations will appear as they sync. They are marked as carried by a bridge, because they are not end-to-end encrypted.',
          })}
        </ThemedText>
        <Button variant="primary" style={{ marginTop: 20 }} onPress={() => router.back()}>
          {t('common.done', { defaultValue: 'Done' })}
        </Button>
      </View>
    );
  }

  return (
    <View>
      {step.instructions !== undefined && (
        <ThemedText className="mb-4 text-sm" style={{ color: theme.colors.textSecondary }}>
          {step.instructions}
        </ThemedText>
      )}

      {step.type === 'display_and_wait' && step.display !== undefined && (
        <LoginStepDisplay display={step.display} />
      )}

      {step.type === 'user_input' && step.fields !== undefined && (
        <LoginStepForm
          /*
           * Re-keyed per step so that a new step starts with empty fields. Without
           * it, Telegram's "code.incorrect" step — a different step id carrying
           * the same field — would arrive pre-filled with the code that was just
           * rejected.
           */
          key={step.stepId}
          fields={step.fields}
          submitLabel={t('bridges.link.submit', { defaultValue: 'Continue' })}
          isSubmitting={attempt.isSubmitting}
          onSubmit={attempt.submit}
        />
      )}

      <Button variant="secondary" style={{ marginTop: 20 }} onPress={attempt.cancel}>
        {t('common.cancel', { defaultValue: 'Cancel' })}
      </Button>
    </View>
  );
}
