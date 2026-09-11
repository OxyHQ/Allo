import { useCallback, useMemo } from 'react';
import { StyleSheet, View, Vibration } from 'react-native';
import { usePathname, useRouter, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { TabBar, TabBarButton, type TabBarItem } from '@oxy.so/bloom/tab-bar';
import { useAuth, useOxy } from '@oxy.so/services';

import Avatar from '@/components/Avatar';
import { CallIcon, CallIconActive } from '@/assets/icons/call-icon';
import { Gear, GearActive } from '@/assets/icons/gear-icon';
import { Home, HomeActive } from '@/assets/icons/home-icon';
import { StatusIcon, StatusIconActive } from '@/assets/icons/status-icon';
import { useBottomChrome } from '@/context/BottomChromeContext';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { useTheme } from '@/hooks/useTheme';
import { isAuthCancellation } from '@/utils/errors';
import { ROUTES, routeMatchers } from '@/utils/routeUtils';

const MAX_WIDTH = 440;

export function BottomBar() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const theme = useTheme();
  const { visible } = useBottomChrome();
  const { user, isAuthenticated, oxyServices } = useOxy();
  const { signIn } = useAuth();
  const { triggerHomeRefresh } = useHomeRefresh();

  const profileRoute: Href = user?.username ? `/@${user.username}` : '/';
  const routes = useMemo<Href[]>(
    () => [ROUTES.HOME, ROUTES.STATUS, ROUTES.CALLS, ROUTES.SETTINGS, profileRoute],
    [profileRoute],
  );
  const avatarUri = user?.avatar
    ? oxyServices.getFileDownloadUrl(user.avatar, 'thumb')
    : undefined;
  const items = useMemo<TabBarItem[]>(
    () => [
      {
        name: 'home',
        label: t('Home'),
        icon: <Home color={theme.colors.textSecondary} size={24} />,
        activeIcon: <HomeActive color={theme.colors.primary} size={24} />,
      },
      {
        name: 'status',
        label: t('Status'),
        icon: <StatusIcon color={theme.colors.textSecondary} size={24} />,
        activeIcon: <StatusIconActive color={theme.colors.primary} size={24} />,
      },
      {
        name: 'calls',
        label: t('Calls'),
        icon: <CallIcon color={theme.colors.textSecondary} size={24} />,
        activeIcon: <CallIconActive color={theme.colors.primary} size={24} />,
      },
      {
        name: 'settings',
        label: t('Settings'),
        icon: <Gear color={theme.colors.textSecondary} size={24} />,
        activeIcon: <GearActive color={theme.colors.primary} size={24} />,
      },
      {
        name: 'profile',
        label: user?.username ? t('Profile') : t('Sign In'),
        icon: <Avatar size={24} source={avatarUri ? { uri: avatarUri } : undefined} />,
      },
    ],
    [avatarUri, t, theme.colors.primary, theme.colors.textSecondary, user?.username],
  );

  const activeIndex = routeMatchers.isHomeRoute(pathname)
    ? 0
    : routeMatchers.isStatusRoute(pathname)
      ? 1
      : pathname === '/calls'
        ? 2
        : routeMatchers.isSettingsRoute(pathname)
          ? 3
          : routeMatchers.isProfileRoute(pathname)
            ? 4
            : -1;

  const handleIndexChange = useCallback(
    async (index: number) => {
      if (index === 0 && routeMatchers.isHomeRoute(pathname)) {
        triggerHomeRefresh();
        return;
      }
      if (index === 4 && (!isAuthenticated || !user?.username)) {
        try {
          await signIn();
        } catch (error: unknown) {
          if (!isAuthCancellation(error)) console.error('Authentication error:', error);
        }
        return;
      }
      const route = routes[index];
      if (route !== undefined) router.navigate(route);
    },
    [isAuthenticated, pathname, router, routes, signIn, triggerHomeRefresh, user?.username],
  );

  const handleIndexLongPress = useCallback(
    (index: number) => {
      if (index === 4 && isAuthenticated) Vibration.vibrate(50);
    },
    [isAuthenticated],
  );

  if (!visible) return null;

  return (
    <View pointerEvents="box-none" style={styles.host}>
      <TabBar
        activeIndex={activeIndex}
        blur={false}
        maxWidth={MAX_WIDTH}
        onIndexChange={handleIndexChange}
        onIndexLongPress={handleIndexLongPress}
      >
        {items.map((item, index) => (
          <TabBarButton key={item.name} item={item} index={index} />
        ))}
      </TabBar>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    pointerEvents: 'box-none',
  },
});
