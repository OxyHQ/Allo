import React, { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Constants from 'expo-constants';
import { usePathname, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { getNativeLanguageName } from '@oxy.so/core';
import { ContactRow } from '@oxy.so/bloom/chat-people';
import {
  RiAccountCircleLine,
  RiUploadCloud2Line,
  RiHammerLine,
  RiInformationLine,
  RiLockLine,
  RiLogoutBoxRLine,
  RiNotification3Line,
  RiPaletteLine,
  RiSmartphoneLine,
  RiTranslate2,
  type BloomIconComponent,
} from '@oxy.so/bloom/icons';
import { SettingsListGroup, SettingsListItem, type SettingsListItemProps } from '@oxy.so/bloom/settings-list';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';

import { Page } from '@/components/shell/Page';
import { useAvatarUrl } from '@/hooks/usePerson';
import { useSplitLayout } from '@/hooks/useSplitLayout';
import { announcePushPermissionGranted } from '@/lib/allo/push';
import { profileHref } from '@/lib/profile/handle';
import { alertDialog, confirmDialog } from '@/utils/alerts';
import { logger } from '@/utils/logger';
import { hasNotificationPermission, requestNotificationPermissions } from '@/utils/notifications';

/**
 * THE SETTINGS LIST, as one self-contained pane.
 *
 * Drawn in two places: beside the detail on a wide window (the chat layout
 * puts it in the list pane for every `/settings…` path), and as the whole
 * screen on a narrow one (`app/(chat)/settings/index.tsx`). So it owns its
 * header and its scrolling, and on a wide window it marks the row whose screen
 * is open beside it.
 */
export function SettingsMenu() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const split = useSplitLayout();
  const { user, logout, showBottomSheet, currentLanguage, currentLanguages } = useOxy();
  const avatarUrl = useAvatarUrl(user?.avatar ?? undefined);
  const notifications = useNotificationPermission();

  const name = user ? (typeof user.name === 'string' ? user.name : user.name?.displayName) || user.username : '';
  const ownProfile = profileHref(user?.username);
  const languages = currentLanguages.length > 0 ? currentLanguages : [currentLanguage];
  const build = Constants.expoConfig?.runtimeVersion;

  // `usePathname()` sometimes carries the `(chat)` group; compare without it.
  const path = pathname.replace(/\/\([^)/]*\)/g, '');
  const isActive = (target: string) => split && (path === target || path.startsWith(`${target}/`));

  const signOut = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t('settings.signOut'),
      message: t('settings.signOutMessage'),
      okText: t('settings.signOut'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      // `AlloRoot` sees the account go and wipes this device's client.
      await logout();
      router.replace('/');
    } catch (error: unknown) {
      logger.error('[Settings] sign-out failed', error);
      toast.error(t('settings.signOutFailed'));
    }
  }, [logout, router, t]);

  return (
    <Page title={t('settings.title')}>
      {user ? (
        <SettingsListGroup title={t('settings.sections.account')}>
          <ContactRow
            id={user.id}
            name={name}
            avatar={avatarUrl}
            subtitle={user.username ? `@${user.username}` : undefined}
            trailing={ownProfile ? 'chevron' : 'none'}
            onPress={ownProfile ? () => router.push(ownProfile) : undefined}
          />
          <MenuRow
            icon={RiAccountCircleLine}
            title={t('settings.account.manage')}
            onPress={() => showBottomSheet?.('ManageAccount')}
          />
        </SettingsListGroup>
      ) : null}

      <SettingsListGroup title={t('settings.sections.preferences')}>
        <MenuRow
          icon={RiPaletteLine}
          title={t('settings.preferences.appearance')}
          active={isActive('/settings/appearance')}
          onPress={() => router.push('/settings/appearance')}
        />
        <MenuRow
          icon={RiTranslate2}
          title={t('settings.preferences.language')}
          value={languages.map((code) => getNativeLanguageName(code)).join(', ')}
          active={isActive('/settings/language')}
          onPress={() => router.push('/settings/language')}
        />
        {Platform.OS !== 'web' ? (
          <MenuRow
            icon={RiNotification3Line}
            title={t('settings.preferences.notifications')}
            description={notifications.granted === false ? t('settings.notifications.allow') : undefined}
            value={
              notifications.granted === null
                ? undefined
                : notifications.granted
                  ? t('settings.notifications.on')
                  : t('settings.notifications.off')
            }
            onPress={notifications.granted === false ? notifications.request : undefined}
          />
        ) : null}
      </SettingsListGroup>

      <SettingsListGroup title={t('settings.sections.security')}>
        <MenuRow
          icon={RiLockLine}
          title={t('settings.privacy.title')}
          active={isActive('/settings/privacy')}
          onPress={() => router.push('/settings/privacy')}
        />
        <MenuRow
          icon={RiSmartphoneLine}
          title={t('devices.title')}
          description={t('settings.devicesDesc')}
          active={isActive('/settings/devices')}
          onPress={() => router.push('/settings/devices')}
        />
        <MenuRow
          icon={RiUploadCloud2Line}
          title={t('backup.title')}
          description={t('settings.backupDesc')}
          active={isActive('/settings/backup')}
          onPress={() => router.push('/settings/backup')}
        />
      </SettingsListGroup>

      <SettingsListGroup title={t('settings.sections.aboutallo')}>
        <MenuRow
          icon={RiInformationLine}
          title={t('settings.aboutallo.appName')}
          value={t('settings.aboutallo.version', { version: Constants.expoConfig?.version ?? '' })}
        />
        <MenuRow
          icon={RiHammerLine}
          title={t('settings.aboutallo.build')}
          value={typeof build === 'string' ? build : t('settings.aboutallo.buildVersion')}
        />
      </SettingsListGroup>

      {user ? (
        <SettingsListGroup>
          <MenuRow
            icon={RiLogoutBoxRLine}
            title={t('settings.signOut')}
            destructive
            showChevron={false}
            onPress={() => {
              void signOut();
            }}
          />
        </SettingsListGroup>
      ) : null}
    </Page>
  );
}

interface MenuRowProps extends Omit<SettingsListItemProps, 'icon'> {
  icon: BloomIconComponent;
  /** The row whose screen is open beside the list. */
  active?: boolean;
}

/**
 * A settings row with its icon tinted, and a wash when it is the open one.
 * Bloom's item has no selected state, so the wash is a wrapper behind it.
 */
function MenuRow({ icon: Icon, active = false, destructive, ...item }: MenuRowProps) {
  const theme = useTheme();
  const tint = destructive ? theme.colors.error : active ? theme.colors.primary : theme.colors.textSecondary;
  const row: ReactNode = <SettingsListItem {...item} destructive={destructive} icon={<Icon width={20} height={20} fill={tint} />} />;
  if (!active) return row;
  return (
    <View style={[styles.active, { backgroundColor: theme.colors.primarySubtle }]}>
      {row}
    </View>
  );
}

/**
 * Whether the OS lets Allo notify, and a way to ask. `null` until known.
 *
 * Permission is the only switch that does anything: the push token is
 * registered whenever it is granted, so there is no in-app "off" to offer.
 */
function useNotificationPermission() {
  const { t } = useTranslation();
  const [granted, setGranted] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    void hasNotificationPermission().then((value) => {
      if (mounted) setGranted(value);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const request = useCallback(async () => {
    const allowed = await requestNotificationPermissions();
    setGranted(allowed);
    if (allowed) {
      // The messaging client registers the push token on this signal.
      announcePushPermissionGranted();
    } else {
      await alertDialog({ title: t('settings.preferences.notifications'), message: t('notification.permission.denied') });
    }
  }, [t]);

  return { granted, request: () => void request() };
}

const styles = StyleSheet.create({
  active: { borderRadius: 12 },
});
