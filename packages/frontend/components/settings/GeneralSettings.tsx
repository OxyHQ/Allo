import { signOutOfAllo } from '@/lib/allo/signOut';
import { profileHref } from '@/lib/profile/handle';
import { logger } from '@/utils/logger';
import { useAlloClient } from '@allo/react';
import { ListItem } from '@oxy.so/bloom/list';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { useHapticsSettingRow, useVideoAutoplaySettingRow } from '@oxy.so/bloom/preferences';
import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services/ui/client';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { useSoundStore } from '@/stores/soundStore';
import { useAlloSettings } from './context';
import { useNotificationPermission } from './use-notification-permission';

import { Button as LButton, Text, toElement } from '@oxy.so/bloom-language';
import { Toggle } from '@oxy.so/bloom-language/inputs';
import { SettingsValue } from '@oxy.so/bloom-language/settings';

export function GeneralSettings() {
  const { t } = useTranslation();
  const router = useRouter();
  const settings = useAlloSettings();
  const { user, logout, showBottomSheet } = useOxy();
  const client = useAlloClient();
  const notifications = useNotificationPermission();
  const conversationTones = useSoundStore((state) => state.conversationTones);
  const setConversationTones = useSoundStore((state) => state.setConversationTones);
  const haptics = useHapticsSettingRow();
  const autoplay = useVideoAutoplaySettingRow();
  const name = user
    ? (typeof user.name === 'string' ? user.name : user.name?.displayName) || user.username
    : '';
  const ownProfile = profileHref(user?.username);
  // The commit a release was built from, inlined by @oxy.so/app-preset's
  // Babel plugin; absent in development.
  const buildId: string | undefined = process.env.OXY_BUILD_ID;
  const build = buildId && buildId !== 'development' ? buildId.slice(0, 7) : undefined;
  const signOut = useCallback(async () => {
    const accepted = await confirm({
      title: t('settings.signOut'),
      description: t('settings.signOutMessage'),
      confirmLabel: t('settings.signOut'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!accepted) return;
    try {
      const outcome = await signOutOfAllo(client, logout);
      if (outcome.revoked === 'failed') toast.error(t('settings.signOutStillListed'));
      settings.close(() => router.replace('/'));
    } catch (error: unknown) {
      logger.error('[Settings] sign-out failed', error);
      toast.error(t('settings.signOutFailed'));
    }
  }, [client, logout, router, settings, t]);
  return (
    <SettingsGeneralPage
      sections={[
        ...(user
          ? [
              {
                key: 'account',
                label: t('settings.sections.account'),
                rows: [
                  {
                    key: 'identity',
                    label: t('profile.view'),
                    control: (
                      <ListItem
                        person={{
                          name,
                          avatar: user.avatar ?? undefined,
                          subtitle: user.username ? `@${user.username}` : undefined,
                        }}
                        trailing={ownProfile ? <RiArrowRightSLine /> : undefined}
                        onPress={
                          ownProfile
                            ? () => settings.close(() => router.push(ownProfile))
                            : undefined
                        }
                      />
                    ),
                  },
                  {
                    key: 'manage',
                    label: t('settings.account.oxyAccount'),
                    control: toElement(
                      LButton(Text(t('settings.account.manageAction')))
                        .onPress(() => settings.close(() => showBottomSheet?.('ManageAccount')))
                        .tint('neutral')
                        .style('outline'),
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          key: 'notifications',
          label: t('settings.sections.preferences'),
          rows: [
            ...(Platform.OS !== 'web'
              ? [
                  {
                    key: 'permission',
                    label: t('settings.preferences.notifications'),
                    description:
                      notifications.granted === false
                        ? t('settings.notifications.allow')
                        : undefined,
                    control:
                      notifications.granted === false
                        ? toElement(
                            LButton(Text(t('settings.notifications.allow')))
                              .onPress(notifications.request)
                              .tint('neutral')
                              .style('outline'),
                          )
                        : toElement(
                            SettingsValue(
                              notifications.granted === null ? '' : t('settings.notifications.on'),
                            ),
                          ),
                  },
                ]
              : []),
            {
              key: 'tones',
              label: t('settings.preferences.conversationTones'),
              description: t('settings.preferences.conversationTonesDesc'),
              control: toElement(
                Toggle([conversationTones, setConversationTones])
                  .label(t('settings.preferences.conversationTones'))
                  .testID('conversation-tones-switch'),
              ),
            },
            haptics,
            autoplay,
          ],
        },
        {
          key: 'about',
          label: t('settings.sections.aboutallo'),
          rows: [
            {
              key: 'version',
              label: t('settings.aboutallo.appName'),
              control: toElement(
                SettingsValue(
                  t('settings.aboutallo.version', {
                    version: Constants.expoConfig?.version ?? '',
                  }),
                ),
              ),
            },
            {
              key: 'build',
              label: t('settings.aboutallo.build'),
              control: toElement(
                SettingsValue(
                  typeof build === 'string' ? build : t('settings.aboutallo.buildVersion'),
                ).muted(),
              ),
            },
          ],
        },
        ...(user
          ? [
              {
                key: 'session',
                rows: [
                  {
                    key: 'signout',
                    label: t('settings.signOutOfDevice'),
                    control: toElement(
                      LButton(Text(t('settings.signOut')))
                        .tint('danger')
                        .onPress(() => void signOut())
                        .style('outline'),
                    ),
                  },
                ],
              },
            ]
          : []),
      ]}
    />
  );
}
