import { StyleSheet, View, Text, ViewStyle, Platform, Vibration } from 'react-native';
import { Link, usePathname } from 'expo-router';
import React from 'react';
import { Pressable } from 'react-native-web-hover';
import { useTranslation } from 'react-i18next';
import Avatar from './Avatar';
import { useOxy } from '@oxyhq/services';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { Home, HomeActive } from '@/assets/icons/home-icon';
import { StatusIcon, StatusIconActive } from '@/assets/icons/status-icon';
import { Gear, GearActive } from '@/assets/icons/gear-icon';
import { CallIcon, CallIconActive } from '@/assets/icons/call-icon';

export const BottomBar = () => {
    const { t } = useTranslation();
    const pathname = usePathname();
    const { showBottomSheet, user, isAuthenticated, oxyServices } = useOxy();
    const insets = useSafeAreaInsets();
    const theme = useTheme();
    const { triggerHomeRefresh } = useHomeRefresh();

    const avatarUri = user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') : undefined;

    const handleHomePress = () => {
        // If already on home page - scroll to top and refresh
        if (pathname === '/') {
            triggerHomeRefresh();
        }
    };

    // Bottom bar navigation items - similar to SideBar structure
    const bottomBarItems: {
        title: string;
        icon: React.ReactNode;
        iconActive: React.ReactNode;
        route: string;
        onPress?: () => void;
    }[] = [
        {
            title: t("Home"),
            icon: <Home color={theme.colors.text} size={24} />,
            iconActive: <HomeActive color={theme.colors.primary} size={24} />,
            route: '/',
            onPress: handleHomePress,
        },
        {
            title: t("Status"),
            icon: <StatusIcon color={theme.colors.text} size={24} />,
            iconActive: <StatusIconActive color={theme.colors.primary} size={24} />,
            route: '/(chat)',
        },
        {
            title: t("Calls"),
            icon: <CallIcon color={theme.colors.text} size={24} />,
            iconActive: <CallIconActive color={theme.colors.primary} size={24} />,
            route: '/calls',
        },
        {
            title: t("Settings"),
            icon: <Gear color={theme.colors.text} />,
            iconActive: <GearActive color={theme.colors.primary} />,
            route: '/(chat)/settings',
        },
    ];

    const isActiveRoute = (route: string) => {
        if (route === '/') {
            return pathname === '/' || pathname === '';
        }
        return pathname?.startsWith(route) || pathname?.includes(route);
    };

    const styles = StyleSheet.create({
        bottomBar: {
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            width: '100%',
            height: 60 + insets.bottom,
            backgroundColor: theme.colors.card,
            flexDirection: 'row',
            justifyContent: 'space-around',
            alignItems: 'center',
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            elevation: 8,
            paddingBottom: insets.bottom,
            paddingTop: 8,
            zIndex: 1000,
            ...Platform.select({
                web: {
                    position: 'fixed',
                    height: 60,
                    paddingBottom: 8,
                },
            }),
        } as ViewStyle,
        tab: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            paddingVertical: 8,
            minHeight: 48,
        },
        tabContent: {
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
        },
        tabIcon: {
            alignItems: 'center',
            justifyContent: 'center',
        },
        tabText: {
            fontSize: 11,
            fontWeight: '500',
            marginTop: 2,
            color: theme.colors.textSecondary,
        },
        tabTextActive: {
            color: theme.colors.primary,
            fontWeight: '600',
        },
    });

    return (
        <View style={styles.bottomBar}>
            {bottomBarItems.map(({ title, icon, iconActive, route, onPress }) => {
                const isActive = isActiveRoute(route);
                const tabContent = (
                    <View style={styles.tabContent}>
                        <View style={styles.tabIcon}>
                            {isActive ? iconActive : icon}
                        </View>
                        <Text style={[
                            styles.tabText,
                            isActive && styles.tabTextActive,
                            {
                                color: isActive ? theme.colors.primary : theme.colors.textSecondary,
                            }
                        ]}>
                            {title}
                        </Text>
                    </View>
                );

                return (
                    <Link
                        key={title}
                        href={route as any}
                        style={styles.tab}
                        asChild
                    >
                        <Pressable
                            onPress={onPress}
                            style={({ pressed }: any) => [
                                styles.tab,
                                pressed && {
                                    backgroundColor: `${theme.colors.primary}10`,
                                    borderRadius: 8,
                                },
                            ]}
                        >
                            {tabContent}
                        </Pressable>
                    </Link>
                );
            })}
            
            {/* Profile/Avatar button */}
            <Link
                href={user?.username ? `/@${user.username}` as any : '#' as any}
                style={styles.tab}
                asChild
            >
                <Pressable
                    onPress={() => {
                        if (!isAuthenticated || !user?.username) {
                            showBottomSheet?.('SignIn');
                        }
                    }}
                    onLongPress={() => {
                        if (isAuthenticated) {
                            Vibration.vibrate(50);
                            showBottomSheet?.('AccountCenter');
                        }
                    }}
                    style={({ pressed }: any) => [
                        styles.tab,
                        pressed && {
                            backgroundColor: `${theme.colors.primary}10`,
                            borderRadius: 8,
                        },
                        pathname?.startsWith('/@') && {
                            backgroundColor: `${theme.colors.primary}15`,
                            borderRadius: 8,
                        },
                    ]}
                >
                    <View style={styles.tabContent}>
                        <View style={styles.tabIcon}>
                            <Avatar
                                size={24}
                                source={avatarUri ? { uri: avatarUri } : undefined}
                            />
                        </View>
                        <Text style={[
                            styles.tabText,
                            pathname?.startsWith('/@') && styles.tabTextActive,
                            {
                                color: pathname?.startsWith('/@') ? theme.colors.primary : theme.colors.textSecondary,
                            }
                        ]}>
                            {user?.username ? t("Profile") : t("Sign In")}
                        </Text>
                    </View>
                </Pressable>
            </Link>
        </View>
    );
};