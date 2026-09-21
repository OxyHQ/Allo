import { useAvatarUrl } from '@/hooks/usePerson';
import { signOutOfAllo } from '@/lib/allo/signOut';
import { profileHref } from '@/lib/profile/handle';
import { logger } from '@/utils/logger';
import { useAlloClient } from '@allo/react';
import { Button } from '@oxy.so/bloom/button';
import { ContactRow } from '@oxy.so/bloom/chat-people';
import { SettingsGeneralPage, SettingsValueField } from '@oxy.so/bloom/settings-modal';
import { confirm } from '@oxy.so/bloom/surfaces';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '@oxy.so/services';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { useAlloSettings } from './context';
import { useNotificationPermission } from './use-notification-permission';

export function GeneralSettings() {
  const { t } = useTranslation();
  const router = useRouter();
  const settings = useAlloSettings();
  const { user, logout, showBottomSheet } = useOxy();
  const client = useAlloClient();
  const avatar = useAvatarUrl(user?.avatar ?? undefined);
  const notifications = useNotificationPermission();
  const name = user ? (typeof user.name === 'string' ? user.name : user.name?.displayName) || user.username : '';
  const ownProfile = profileHref(user?.username);
  const build = Constants.expoConfig?.runtimeVersion;
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
                      <ContactRow
                        id={user.id}
                        name={name}
                        avatar={avatar}
                        subtitle={user.username ? `@${user.username}` : undefined}
                        size="small"
                        horizontalInset={0}
                        trailing={ownProfile ? 'chevron' : 'none'}
                        onPress={ownProfile ? () => settings.close(() => router.push(ownProfile)) : undefined}
                      />
                    ),
                  },
                  {
                    key: 'manage',
                    label: t('settings.account.manage'),
                    control: (
                      <Button variant="secondary" onPress={() => settings.close(() => showBottomSheet?.('ManageAccount'))}>
                        {t('settings.account.manage')}
                      </Button>
                    ),
                  },
                ],
              },
            ]
          : []),
        ...(Platform.OS !== 'web'
          ? [
              {
                key: 'notifications',
                label: t('settings.sections.preferences'),
                rows: [
                  {
                    key: 'permission',
                    label: t('settings.preferences.notifications'),
                    description: notifications.granted === false ? t('settings.notifications.allow') : undefined,
                    control:
                      notifications.granted === false ? (
                        <Button variant="secondary" onPress={notifications.request}>
                          {t('settings.notifications.allow')}
                        </Button>
                      ) : (
                        <SettingsValueField>{notifications.granted === null ? '' : t('settings.notifications.on')}</SettingsValueField>
                      ),
                  },
                ],
              },
            ]
          : []),
        {
          key: 'about',
          label: t('settings.sections.aboutallo'),
          rows: [
            {
              key: 'version',
              label: t('settings.aboutallo.appName'),
              control: (
                <SettingsValueField>
                  {t('settings.aboutallo.version', {
                    version: Constants.expoConfig?.version ?? '',
                  })}
                </SettingsValueField>
              ),
            },
            {
              key: 'build',
              label: t('settings.aboutallo.build'),
              control: (
                <SettingsValueField muted>{typeof build === 'string' ? build : t('settings.aboutallo.buildVersion')}</SettingsValueField>
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
                    label: t('settings.signOut'),
                    control: (
                      <Button variant="secondary" tone="danger" onPress={() => void signOut()}>
                        {t('settings.signOut')}
                      </Button>
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
