import React, { useCallback, useMemo, useRef, useState } from "react";
import {
    Dimensions,
    Platform,
    View,
    ViewStyle,
    StyleSheet,
} from "react-native";
import { Pressable } from "react-native-web-hover";
import { usePathname, useRouter } from "expo-router";
import { useMediaQuery } from "react-responsive";
import { useTranslation } from "react-i18next";

// Components
import { SideBarItem } from "./SideBarItem";
import { Logo } from "@/components/Logo";
import Avatar from "@/components/Avatar";

// Icons
import { Home, HomeActive } from "@/assets/icons/home-icon";
import { Gear, GearActive } from "@/assets/icons/gear-icon";
import { StatusIcon, StatusIconActive } from '@/assets/icons/status-icon';

// Hooks
import { useTheme } from "@/hooks/useTheme";
import { useOxy, useAuth, ProfileButton } from "@oxyhq/services";
import { useMyAvatarShape } from "@/hooks/useAvatarShape";

/** Hover handlers supported by react-native-web-hover's Pressable on web. */
interface HoverHandlers {
    onHoverIn?: () => void;
    onHoverOut?: () => void;
}

// Utils
import { ROUTES, routeMatchers, isRouteActive } from "@/utils/routeUtils";

// Types
import type { NavigationItem } from "@/types/navigation";

const WindowHeight = Dimensions.get('window').height;

export function SideBar() {
    const { t } = useTranslation();
    const router = useRouter();
    const { user, oxyServices } = useOxy();
    const { signIn } = useAuth();
    const theme = useTheme();

    const avatarUri = user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') : undefined;
    const myAvatarShape = useMyAvatarShape();

    const handleManageAccount = useCallback(() => router.push(ROUTES.SETTINGS), [router]);
    const handleOpenProfile = useCallback(() => {
        if (user?.username) router.push(`/@${user.username}`);
    }, [router, user?.username]);
    const handleAddAccount = useCallback(() => {
        void signIn();
    }, [signIn]);

    const pathname = usePathname();
    const isSideBarVisible = useMediaQuery({ minWidth: 500 });
    const [isExpanded, setIsExpanded] = useState(false);
    const hoverCollapseTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Build navigation items with theme-aware icons
    const navigationItems = useMemo<NavigationItem[]>(() => {
        const items: NavigationItem[] = [
            {
                title: t("Home"),
                icon: <Home color={theme.colors.text} />,
                iconActive: <HomeActive color={theme.colors.primary} />,
                route: ROUTES.HOME,
            },
        ];

        // Add profile item if user is authenticated
        if (user?.username) {
            items.push({
                title: t("Profile"),
                icon: <Avatar source={avatarUri} size={24} shape={myAvatarShape} />,
                iconActive: <Avatar source={avatarUri} size={24} shape={myAvatarShape} />,
                route: `/@${user.username}`,
            });
        }

        // Add status and settings
        items.push(
            {
                title: t("Status"),
                icon: <StatusIcon color={theme.colors.text} />,
                iconActive: <StatusIconActive color={theme.colors.primary} />,
                route: ROUTES.STATUS,
            },
            {
                title: t("Settings"),
                icon: <Gear color={theme.colors.text} />,
                iconActive: <GearActive color={theme.colors.primary} />,
                route: ROUTES.SETTINGS,
            }
        );

        return items;
    }, [user, avatarUri, theme.colors, t]);

    const handleHoverIn = useCallback(() => {
        if (hoverCollapseTimeout.current) {
            clearTimeout(hoverCollapseTimeout.current);
            hoverCollapseTimeout.current = null;
        }
        setIsExpanded(true);
    }, []);

    const handleHoverOut = useCallback(() => {
        if (hoverCollapseTimeout.current) {
            clearTimeout(hoverCollapseTimeout.current);
        }
        hoverCollapseTimeout.current = setTimeout(() => setIsExpanded(false), 200);
    }, []);

    /**
     * Determines if a route is currently active
     */
    const getIsRouteActive = useCallback((route: string): boolean => {
        if (route === ROUTES.HOME) {
            return routeMatchers.isHomeRoute(pathname);
        }
        if (route === ROUTES.STATUS) {
            return routeMatchers.isStatusRoute(pathname);
        }
        if (route === ROUTES.SETTINGS) {
            return routeMatchers.isSettingsRoute(pathname);
        }
        // For profile routes, check exact match or starts with
        if (route.startsWith('/@')) {
            return isRouteActive(pathname, route, { exact: true, startsWith: true });
        }
        // Default: check starts with or includes
        return isRouteActive(pathname, route, { startsWith: true, includes: true });
    }, [pathname]);

    if (!isSideBarVisible) return null;

    if (isSideBarVisible) {
        return (
            <Pressable
                {...({ onHoverIn: handleHoverIn, onHoverOut: handleHoverOut } satisfies HoverHandlers)}
                style={[
                    styles.container,
                    { backgroundColor: theme.colors.background },
                    {
                        width: isExpanded ? 240 : 60,
                        padding: 6,
                        ...(Platform.select({
                            web: {
                                transition: 'width 220ms cubic-bezier(0.2, 0, 0, 1)',
                                willChange: 'width',
                            },
                        }) as ViewStyle),
                        ...(pathname === '/search' ? {
                            shadowColor: theme.colors.shadow,
                            shadowOffset: { width: 0, height: 2 },
                            shadowOpacity: 0.25,
                            shadowRadius: 3.84,
                            elevation: 5,
                        } : {}),
                    },
                ]}
            >
                <View style={styles.inner}>
                    <View style={styles.headerSection}>
                        <Logo />
                    </View>
                    <View style={styles.navigationSection}>
                        {navigationItems.map(({ title, icon, iconActive, route }) => {
                            const isActive = getIsRouteActive(route);
                            
                            return (
                                <SideBarItem
                                    key={`${route}-${title}`}
                                    href={route}
                                    icon={isActive ? iconActive : icon}
                                    text={title}
                                    isActive={isActive}
                                    isExpanded={isExpanded}
                                    onHoverExpand={handleHoverIn}
                                />
                            );
                        })}
                    </View>

                    <View style={styles.footer}>
                        <ProfileButton
                            expanded={isExpanded}
                            onNavigateManage={handleManageAccount}
                            onNavigateProfile={handleOpenProfile}
                            onAddAccount={handleAddAccount}
                        />
                    </View>
                </View>
            </Pressable>
        );
    }

    return null;
}

const styles = StyleSheet.create({
    container: {
        padding: 12,
        ...(Platform.select({
            web: {
                position: 'sticky',
                overflow: 'hidden',
                height: '100vh',
                cursor: 'initial',
            },
            default: {
                height: WindowHeight,
            },
        }) as ViewStyle),
        top: 0,
        zIndex: 1000,
    },
    inner: {
        flex: 1,
        width: '100%',
        justifyContent: 'flex-start',
        alignItems: 'flex-start',
    },
    headerSection: {
        marginBottom: 16,
    },
    content: {
        justifyContent: 'flex-start',
        alignItems: 'flex-start',
        width: '100%',
    },
    heroSection: {
        marginTop: 8,
    },
    heroTagline: {
        fontSize: 20,
        fontWeight: 'bold',
        flexWrap: 'wrap',
        textAlign: 'left',
        maxWidth: 200,
        lineHeight: 24,
    },
    authButtonsContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginVertical: 12,
        gap: 8,
    },
    signUpButton: {
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 25,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    signUpButtonText: {
        fontSize: 13,
        fontWeight: "bold",
    },
    signInButton: {
        justifyContent: "center",
        alignItems: "center",
        borderRadius: 25,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    signInButtonText: {
        fontSize: 13,
        fontWeight: "bold",
    },
    navigationSection: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'flex-start',
        width: '100%',
        gap: 2,
        paddingLeft: 0,
        paddingRight: 0,
    },
    addPropertyButton: {
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 100,
        display: 'flex',
        alignSelf: 'flex-start',
        marginTop: 4,
    },
    addPropertyButtonContainer: {
        minHeight: 60,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    addPostButtonText: {
        fontSize: 16,
        fontWeight: 'bold',
        textAlign: 'center',
        margin: 0,
    },
    footer: {
        flexDirection: 'column',
        justifyContent: 'flex-end',
        alignItems: 'flex-start',
        width: '100%',
        marginTop: 'auto',
    },
    title: {
        fontSize: 24,
        marginBottom: 16,
    },
    menuItemText: {
        fontSize: 16,
        marginLeft: 12,
    },
    footerText: {
        fontSize: 14,
        textAlign: 'center',
    },
});

