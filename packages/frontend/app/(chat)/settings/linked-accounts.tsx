import React from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { NetworkGlyph } from '@/components/bridges/NetworkGlyph';
import { useTheme } from '@/hooks/useTheme';
import {
  accountsForNetwork,
  useBridgeAccounts,
  useBridgeNetworks,
  useReconnectBridgeAccount,
  useUnlinkBridgeAccount,
} from '@/hooks/useBridges';
import type { BridgeAccount, BridgeAccountState } from '@/lib/bridges/contract';
import { webAlert } from '@/utils/api';

/**
 * Linked accounts — the screen that says which remote networks this Allo account
 * carries (`docs/matrix/bridges.md` §5.2, §9.2).
 *
 * ## The list is the server's, entirely
 *
 * Every network offered here comes from `GET /api/bridges/networks`. The app has
 * no catalogue of its own, so a deployment that has not configured a network
 * shows nothing for it — not a greyed-out row, not "coming soon". §9.1 is
 * unusually blunt about this: *"Una red apagada no debe aparecer en la UI de
 * vincular cuenta. No 'aparece deshabilitada': no aparece."*
 *
 * That is also why WhatsApp, Instagram and Messenger are absent today. They are
 * implemented, and they declare `requiresProxy`, and §9.2 rule 2 makes a
 * proxy-requiring network impossible to enable without a configured residential
 * proxy provider — the backend refuses to boot rather than let every user egress
 * from one datacentre address, perfectly correlated for banning. With no provider
 * contracted, those networks cannot be enabled, so the catalogue never lists them
 * and nothing here has to remember to hide them.
 */

const IconComponent = Ionicons;

/** The six states §5.3 collapses the bridge's eleven into, and what each looks like. */
const STATE_APPEARANCE: Readonly<
  Record<BridgeAccountState, { readonly color: 'success' | 'warning' | 'error' | 'muted' }>
> = Object.freeze({
  linking: { color: 'muted' },
  connecting: { color: 'muted' },
  connected: { color: 'success' },
  degraded: { color: 'warning' },
  action_required: { color: 'warning' },
  failed: { color: 'error' },
});

export default function LinkedAccountsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();

  const networks = useBridgeNetworks();
  const accounts = useBridgeAccounts();
  const unlink = useUnlinkBridgeAccount();
  const reconnect = useReconnectBridgeAccount();

  const stateColor = (state: BridgeAccountState): string => {
    switch (STATE_APPEARANCE[state].color) {
      case 'success':
        return theme.colors.success;
      case 'warning':
        return theme.colors.warning;
      case 'error':
        return theme.colors.error;
      default:
        return theme.colors.textSecondary;
    }
  };

  const stateLabel = (account: BridgeAccount): string =>
    t(`bridges.state.${account.state}`, {
      defaultValue: DEFAULT_STATE_LABELS[account.state],
    });

  const confirmUnlink = (account: BridgeAccount) => {
    const name = account.remoteName ?? account.network;
    webAlert(
      t('bridges.unlink.title', {
        network: name,
        defaultValue: 'Unlink {{network}}?',
      }),
      t('bridges.unlink.body', {
        defaultValue:
          'Allo will sign out of that account and stop syncing its conversations. The messages already in Allo stay where they are.',
      }),
      [
        { text: t('common.cancel', { defaultValue: 'Cancel' }), style: 'cancel' },
        {
          text: t('bridges.unlink.confirm', { defaultValue: 'Unlink' }),
          style: 'destructive',
          onPress: () => unlink.mutate(account.id),
        },
      ],
    );
  };

  const isLoading = networks.isLoading || accounts.isLoading;
  const linked = accounts.data ?? [];

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.linkedAccounts.title', { defaultValue: 'Linked accounts' }),
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-4 pt-5 pb-6"
          showsVerticalScrollIndicator={false}
        >
          {/*
            * Said before anything else, because it is the honest summary of what
            * linking does and it must not be reachable only by scrolling past the
            * button. A bridged conversation is not end-to-end encrypted — the
            * bridge holds the remote network's keys, by definition.
            */}
          <ThemedText
            className="mb-4 text-sm"
            style={{ color: theme.colors.textSecondary }}
          >
            {t('bridges.intro', {
              defaultValue:
                'Conversations from a linked network are carried by a bridge, which can read them. They are not end-to-end encrypted, and Allo marks them so you can tell.',
            })}
          </ThemedText>

          {linked.length > 0 && (
            <SettingsListGroup
              title={t('bridges.section.linked', { defaultValue: 'Linked' })}
            >
              {linked.map((account) => (
                <SettingsListItem
                  key={account.id}
                  icon={
                    <NetworkGlyph
                      networkId={account.network}
                      displayName={account.network}
                      size={20}
                      color={theme.colors.textSecondary}
                    />
                  }
                  title={account.remoteName ?? account.network}
                  description={stateLabel(account)}
                  rightElement={
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: stateColor(account.state),
                      }}
                      accessibilityLabel={stateLabel(account)}
                    />
                  }
                  onPress={() =>
                    showAccountActions({
                      account,
                      t,
                      onReconnect: () => reconnect.mutate(account.id),
                      onUnlink: () => confirmUnlink(account),
                    })
                  }
                />
              ))}
            </SettingsListGroup>
          )}

          {networks.isError ? (
            <ThemedText className="mt-4 text-sm" style={{ color: theme.colors.error }}>
              {t('bridges.networksUnavailable', {
                defaultValue: 'The list of networks could not be loaded. Try again later.',
              })}
            </ThemedText>
          ) : networks.data === undefined || networks.data.length === 0 ? (
            /*
             * The end state for every deployment today, and it is stated rather
             * than left as an empty screen: no network is configured, so there is
             * nothing to link and nothing the user can do about it.
             */
            <ThemedText
              className="mt-4 text-sm"
              style={{ color: theme.colors.textSecondary }}
            >
              {t('bridges.noNetworks', {
                defaultValue: 'No networks are available to link on this server yet.',
              })}
            </ThemedText>
          ) : (
            <SettingsListGroup
              title={t('bridges.section.available', { defaultValue: 'Add a network' })}
            >
              {networks.data.map((network) => {
                const existing = accountsForNetwork(accounts.data, network.id);
                return (
                  <SettingsListItem
                    key={network.id}
                    icon={
                      <NetworkGlyph
                        networkId={network.id}
                        displayName={network.displayName}
                        size={20}
                        color={theme.colors.textSecondary}
                      />
                    }
                    title={network.displayName}
                    description={
                      existing.length > 0
                        ? t('bridges.alreadyLinked', {
                            count: existing.length,
                            /*
                             * Suffixed, because passing `count` makes i18next 26
                             * resolve through `Intl.PluralRules` and look for
                             * `_one`/`_other` — on the default too. A bare
                             * `defaultValue` would be found only for the plural
                             * category the locale happens to fall back on, and the
                             * visible symptom is "2 account already linked".
                             */
                            defaultValue_one: '1 account already linked',
                            defaultValue_other: '{{count}} accounts already linked',
                          })
                        : undefined
                    }
                    showChevron
                    onPress={() =>
                      router.push(`/settings/linked-accounts/${network.id}`)
                    }
                  />
                );
              })}
            </SettingsListGroup>
          )}

          {accounts.isError && (
            <ThemedText className="mt-4 text-sm" style={{ color: theme.colors.error }}>
              {t('bridges.accountsUnavailable', {
                defaultValue: 'Your linked accounts could not be loaded. Try again later.',
              })}
            </ThemedText>
          )}
        </ScrollView>
      )}

      <View className="px-4 pb-6">
        <SettingsListItem
          icon={
            <IconComponent
              name="information-circle-outline"
              size={20}
              color={theme.colors.textSecondary}
            />
          }
          title={t('bridges.disclosure.title', {
            defaultValue: 'How linked networks work',
          })}
          description={t('bridges.disclosure.body', {
            defaultValue:
              'Allo signs in to each network with an unofficial client and relays your messages. Some networks do not permit this.',
          })}
        />
      </View>
    </ThemedView>
  );
}

/** Fallbacks so a missing translation reads as English rather than as a key. */
const DEFAULT_STATE_LABELS: Readonly<Record<BridgeAccountState, string>> = Object.freeze({
  linking: 'Connecting your account…',
  connecting: 'Syncing…',
  connected: 'Connected',
  degraded: 'Reconnecting…',
  action_required: 'Sign in again',
  failed: 'There is a problem',
});

interface AccountActionsInput {
  readonly account: BridgeAccount;
  readonly t: (key: string, options?: Record<string, unknown>) => string;
  readonly onReconnect: () => void;
  readonly onUnlink: () => void;
}

/**
 * The two things that can be done to a linked account.
 *
 * `reconnect` is not a placeholder: bridgev2's provisioning API has no reconnect
 * call, so the backend re-reads `whoami` and reconciles the stored state from it
 * — which is exactly what clears an account the staleness sweep marked `failed`
 * while the bridge was in fact fine.
 */
function showAccountActions({ account, t, onReconnect, onUnlink }: AccountActionsInput) {
  webAlert(
    account.remoteName ?? account.network,
    t(`bridges.state.${account.state}`, {
      defaultValue: DEFAULT_STATE_LABELS[account.state],
    }),
    [
      { text: t('common.cancel', { defaultValue: 'Cancel' }), style: 'cancel' },
      {
        text: t('bridges.action.reconnect', { defaultValue: 'Refresh connection' }),
        onPress: onReconnect,
      },
      {
        text: t('bridges.action.unlink', { defaultValue: 'Unlink' }),
        style: 'destructive',
        onPress: onUnlink,
      },
    ],
  );
}
