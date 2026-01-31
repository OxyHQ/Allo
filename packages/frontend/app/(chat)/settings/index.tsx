import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import { View, Text, TouchableOpacity, Alert, Platform, ScrollView, Animated } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/layout/Header";
import { HeaderIconButton } from "@/components/layout/HeaderIconButton";
import { Toggle } from "@/components/Toggle";
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useOxy } from "@oxyhq/services";
import { useTranslation } from "react-i18next";

import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { LogoIcon } from "@/assets/logo";
import { authenticatedClient } from "@/utils/api";
import { confirmDialog, alertDialog } from "@/utils/alerts";
import { getData, storeData } from "@/utils/storage";
// (already imported above)
import { hasNotificationPermission, requestNotificationPermissions, getDevicePushToken } from "@/utils/notifications";
import { useTheme } from "@/hooks/useTheme";
import { getThemedBorder, getThemedShadow } from "@/utils/theme";
import { useAppearanceStore } from "@/store/appearanceStore";
import { useColorScheme } from "@/hooks/useColorScheme";
import i18n from 'i18next';
import {
    useConversationSwipePreferencesStore,
    SwipeActionType,
} from '@/stores';
import { useMessagesStore } from '@/stores/messagesStore';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import { SPACING, SPACING_CLASSES } from '@/constants/spacing';

// Type assertion for Ionicons compatibility with React 19
const IconComponent = Ionicons as any;

export default function SettingsScreen() {
    const { t } = useTranslation();
    const router = useRouter();
    const { user, showBottomSheet } = useOxy();
    const theme = useTheme();
    const leftSwipeAction = useConversationSwipePreferencesStore((state) => state.leftSwipeAction);
    const rightSwipeAction = useConversationSwipePreferencesStore((state) => state.rightSwipeAction);
    const setLeftSwipeAction = useConversationSwipePreferencesStore((state) => state.setLeftSwipeAction);
    const setRightSwipeAction = useConversationSwipePreferencesStore((state) => state.setRightSwipeAction);
    const swipeActionOptions = useMemo(
        () => ([
            {
                value: 'archive',
                label: t('settings.conversations.archiveLabel', 'Archive'),
                description: t(
                    'settings.conversations.archiveDescription',
                    'Hide the chat but keep its history.',
                ),
            },
            {
                value: 'delete',
                label: t('settings.conversations.deleteLabel', 'Delete'),
                description: t(
                    'settings.conversations.deleteDescription',
                    'Remove the chat from your list.',
                ),
            },
            {
                value: 'none',
                label: t('settings.conversations.disabledLabel', 'Disabled'),
                description: t(
                    'settings.conversations.disabledDescription',
                    'Do nothing when swiping this direction.',
                ),
            },
        ] satisfies { value: SwipeActionType; label: string; description: string }[]),
        [t],
    );
    const leftActionDescription = swipeActionOptions.find(option => option.value === leftSwipeAction)?.description;
    const rightActionDescription = swipeActionOptions.find(option => option.value === rightSwipeAction)?.description;

    // Determine Expo SDK/version information with safe fallbacks
    const expoSdkVersion =
        // Newer Expo exposes sdkVersion in expoConfig or manifest
        (Constants.expoConfig && (Constants.expoConfig.sdkVersion || Constants.expoConfig.runtimeVersion)) ||
        // Older Expo versions may have manifest.sdkVersion
        (Constants.manifest && (Constants.manifest.sdkVersion || Constants.manifest.releaseChannel)) ||
        // Expo runtime/version fields
        Constants.expoRuntimeVersion || Constants.expoVersion ||
        // final fallback
        'Unknown';

    // Determine Oxy SDK version from known locations (Constants, expoConfig extras, manifest extras, or oxyServices)
    const oxySdkVersion =
        Constants.oxyVersion ||
        (Constants.expoConfig &&
            (Constants.expoConfig.extra?.oxyVersion || Constants.expoConfig.extra?.oxySDKVersion)) ||
        (Constants.manifest &&
            (Constants.manifest.extra?.oxyVersion || Constants.manifest.extra?.oxySDKVersion)) ||
        // (No oxyServices fallback here; prefer build-time constants and manifest extras)
        'Unknown';

    // Determine API URL from build/runtime config or environment fallbacks
    const apiUrl = process.env.EXPO_PUBLIC_API_URL || process.env.API_URL ||
        // final fallback
        'Not set';

    // Settings state
    const [notifications, setNotifications] = useState(true);
    const unregisterPushToken = useCallback(async () => {
        try {
            const tokenInfo = await getDevicePushToken();
            if (!tokenInfo?.token) return;
            await authenticatedClient.delete('/notifications/push-token', { data: { token: tokenInfo.token } });
        } catch (e) {
            console.warn('Failed to unregister push token:', e);
        }
    }, []);

    const registerPushIfPermitted = useCallback(async () => {
        if (Constants.appOwnership === 'expo') {
            console.warn('expo-notifications: Remote push is unavailable in Expo Go. Use a development build.');
            return false;
        }
        const granted = await hasNotificationPermission() || await requestNotificationPermissions();
        if (!granted) return false;
        try {
            const tokenInfo = await getDevicePushToken();
            if (!tokenInfo?.token) return false;
            await authenticatedClient.post('/notifications/push-token', {
                token: tokenInfo.token,
                type: tokenInfo.type || (Platform.OS === 'ios' ? 'apns' : 'fcm'),
                platform: Platform.OS,
                locale: (Constants as any).locale || 'en-US',
            });
            return true;
        } catch (e) {
            console.warn('Failed to (re)register push token:', e);
            return false;
        }
    }, []);

    const onToggleNotifications = useCallback(async (value: boolean) => {
        setNotifications(value);
        const storageKey = `pref:${user?.id || 'global'}:notificationsEnabled`;
        await storeData(storageKey, value);
        if (value) {
            await registerPushIfPermitted();
        } else {
            await unregisterPushToken();
        }
    }, [registerPushIfPermitted, unregisterPushToken, user?.id]);

    // Load initial notifications toggle from storage
    useEffect(() => {
        let mounted = true;
        const load = async () => {
            const storageKey = `pref:${user?.id || 'global'}:notificationsEnabled`;
            const saved = await getData<boolean>(storageKey);
            if (!mounted) return;
            if (typeof saved === 'boolean') {
                setNotifications(saved);
            }
        };
        load();
        return () => { mounted = false; };
    }, [user?.id]);

    // Get theme mode from appearance store
    const mySettings = useAppearanceStore((state) => state.mySettings);
    const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
    const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
    const currentColorScheme = useColorScheme();

    // Load settings on mount if not already loaded
    useEffect(() => {
        if (!mySettings) {
            loadMySettings();
        }
    }, [mySettings, loadMySettings]);

    // Determine if dark mode is currently active (useColorScheme already handles system preference)
    const isDarkModeActive = currentColorScheme === 'dark';

    const handleDarkModeToggle = useCallback(async (value: boolean) => {
        const newThemeMode = value ? 'dark' : 'light';
        await updateMySettings({
            appearance: {
                themeMode: newThemeMode,
                primaryColor: mySettings?.appearance?.primaryColor,
            },
        } as any);
    }, [updateMySettings, mySettings?.appearance?.primaryColor]);

    // Get current language
    const [currentLanguage, setCurrentLanguage] = useState<string>('en-US');
    useEffect(() => {
        const loadLanguage = async () => {
            try {
                const LANGUAGE_STORAGE_KEY = 'user_language_preference';
                const savedLanguage = await getData<string>(LANGUAGE_STORAGE_KEY);
                const language = savedLanguage || i18n.language || 'en-US';
                setCurrentLanguage(language);
            } catch (error) {
                setCurrentLanguage(i18n.language || 'en-US');
            }
        };
        loadLanguage();

        // Listen for language changes
        const handleLanguageChanged = (lng: string) => {
            setCurrentLanguage(lng);
        };
        i18n.on('languageChanged', handleLanguageChanged);

        return () => {
            i18n.off('languageChanged', handleLanguageChanged);
        };
    }, []);

    const getLanguageDisplayName = useCallback((code: string) => {
        const languages: Record<string, string> = {
            'en-US': 'English',
            'es-ES': 'Español',
            'it-IT': 'Italiano',
        };
        return languages[code] || code;
    }, []);

    const handleSignOut = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.signOut'),
            message: t('settings.signOutMessage'),
            okText: t('settings.signOut'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;
        // For now, just navigate back - the actual sign out would depend on your auth system
        router.replace('/');
    };

    const handleClearCache = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.data.clearCache'),
            message: t('settings.data.clearCacheMessage'),
            okText: t('common.clear'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;
        // Implementation would clear app cache
        await alertDialog({ title: t('common.success'), message: t('settings.data.clearCacheSuccess') });
    };

    const handleResetPersonalization = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.data.resetPersonalization'),
            message: t('settings.data.resetPersonalizationMessage'),
            okText: t('common.reset'),
            cancelText: t('common.cancel'),
            destructive: true,
        });
        if (!confirmed) return;

        try {
            await authenticatedClient.delete('/profile/settings/behavior');
            await alertDialog({
                title: t('common.success'),
                message: t('settings.data.resetPersonalizationSuccess')
            });
        } catch (error) {
            console.error('Error resetting personalization:', error);
            await alertDialog({
                title: t('common.error'),
                message: t('settings.data.resetPersonalizationError')
            });
        }
    };

    const handleExportData = async () => {
        const confirmed = await confirmDialog({
            title: t('settings.data.exportData'),
            message: t('settings.data.exportDataMessage'),
            okText: t('common.export'),
            cancelText: t('common.cancel'),
        });
        if (!confirmed) return;
        await alertDialog({ title: t('common.success'), message: t('settings.data.exportDataSuccess') });
    };

    return (
        <ThemedView className="flex-1">
            {/* Header */}
            <Header
                options={{
                    title: t("settings.title"),
                    leftComponents: [
                        <HeaderIconButton
                            key="back"
                            onPress={() => router.back()}
                        >
                            <BackArrowIcon size={20} color={theme.colors.text} />
                        </HeaderIconButton>,
                    ],
                }}
                hideBottomBorder={true}
                disableSticky={true}
            />

            <Animated.ScrollView
                className="flex-1"
                contentContainerClassName={`px-${SPACING.screen.horizontal} pt-${SPACING.screen.vertical} pb-${SPACING.content.gapLarge}`}
                showsVerticalScrollIndicator={false}
            >
                {/* User Info */}
                <View className={`mb-${SPACING.section.gap}`}>
                    <Text className={SPACING_CLASSES.sectionTitle} style={{ color: theme.colors.text }}>{t("settings.sections.account")}</Text>

                    <View className="rounded-2xl border overflow-hidden" style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}>
                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} pt-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}
                            onPress={() => showBottomSheet?.("AccountSettings")}
                        >
                            <View className={`w-10 h-10 rounded-full items-center justify-center mr-${SPACING.item.iconMargin}`} style={{ backgroundColor: theme.colors.primary }}>
                                <IconComponent name="person" size={24} color={theme.colors.card} />
                            </View>
                            <View className="flex-row items-center flex-1">
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>
                                        {user
                                            ? typeof user.name === 'string'
                                                ? user.name
                                                : user.name?.full || user.name?.first || user.username
                                            : 'User'}
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>{user?.username || 'Username'}</Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>
                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />
                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} pb-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}
                            onPress={() => showBottomSheet?.("FileManagement")}
                        >
                            <View className={`w-10 h-10 rounded-full items-center justify-center mr-${SPACING.item.iconMargin}`} style={{ backgroundColor: theme.colors.primary }}>
                                <IconComponent name="person" size={24} color={theme.colors.card} />
                            </View>
                            <View className="flex-row items-center flex-1">
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>
                                        {user
                                            ? typeof user.name === 'string'
                                                ? user.name
                                                : user.name?.full || user.name?.first || user.username
                                            : 'User'}
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>{user?.username || 'Username'}</Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* About allo */}
                <View className={`mb-${SPACING.section.gap}`}>
                    <Text className={SPACING_CLASSES.sectionTitle} style={{ color: theme.colors.text }}>{t('settings.sections.aboutallo')}</Text>

                    <View className="rounded-2xl border overflow-hidden" style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}>
                        {/* App Title and Version */}
                        <View className={`${SPACING_CLASSES.listItem} pt-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <LogoIcon size={20} color={theme.colors.primary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.aboutallo.appName')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t('settings.aboutallo.version', {
                                            version: Constants.expoConfig?.version || '1.0.0',
                                        })}
                                    </Text>
                                </View>
                            </View>
                        </View>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        {/* Build Info */}
                        <View className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="hammer" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.aboutallo.build')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {typeof Constants.expoConfig?.runtimeVersion === 'string'
                                            ? Constants.expoConfig.runtimeVersion
                                            : t('settings.aboutallo.buildVersion')}
                                    </Text>
                                </View>
                            </View>
                        </View>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        {/* Platform Info */}
                        <View className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent
                                        name="phone-portrait"
                                        size={20}
                                        color={theme.colors.textSecondary}
                                    />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.aboutallo.platform')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {Constants.platform?.ios
                                            ? 'iOS'
                                            : Constants.platform?.android
                                                ? 'Android'
                                                : 'Web'}
                                    </Text>
                                </View>
                            </View>
                        </View>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        {/* Oxy SDK */}
                        <TouchableOpacity className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`} onPress={() => showBottomSheet?.('AppInfo')}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="code-slash" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.aboutallo.oxySDK')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>{oxySdkVersion}</Text>
                                </View>
                            </View>
                        </TouchableOpacity>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        {/* Expo SDK */}
                        <View className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="code-slash" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.aboutallo.expoSDK')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>{expoSdkVersion}</Text>
                                </View>
                            </View>
                        </View>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        {/* API URL (from env/config) */}
                        <View className={`${SPACING_CLASSES.listItem} pb-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="globe" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.aboutallo.apiUrl')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>{apiUrl}</Text>
                                </View>
                            </View>
                        </View>
                    </View>
                </View>

                {/* Conversation Swipes */}
                <View className={`mb-${SPACING.section.gap}`}>
                    <Text className={SPACING_CLASSES.sectionTitle} style={{ color: theme.colors.text }}>
                        {t('settings.sections.conversations', 'Conversations')}
                    </Text>

                    <View className="rounded-2xl border overflow-hidden" style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}>
                        <View className={`${SPACING_CLASSES.listItem} pt-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="swap-horizontal" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>
                                        {t('settings.conversations.swipeTitle', 'Swipe actions')}
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t('settings.conversations.swipeSubtitle', 'Choose what happens when you swipe chats.')}
                                    </Text>
                                </View>
                            </View>
                        </View>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        <View className={`px-${SPACING.item.paddingHorizontal} py-${SPACING.item.paddingVertical}`}>
                            <Text className={`text-[13px] font-semibold mb-${SPACING.content.gap} uppercase`} style={{ color: theme.colors.text }}>
                                {t('settings.conversations.leftSwipe', 'Left swipe')}
                            </Text>
                            <View className="flex-row">
                                {swipeActionOptions.map((option, index) => {
                                    const isSelected = leftSwipeAction === option.value;
                                    const isLast = index === swipeActionOptions.length - 1;
                                    return (
                                        <TouchableOpacity
                                            key={`left-${option.value}`}
                                            className={`flex-1 py-2.5 rounded-[18px] border items-center ${!isLast ? `mr-${SPACING.content.gap}` : ''}`}
                                            style={{
                                                backgroundColor: isSelected ? '#005c67' : 'transparent',
                                                borderColor: isSelected ? '#005c67' : '#E2E8F0',
                                            }}
                                            onPress={() => setLeftSwipeAction(option.value)}
                                            activeOpacity={0.9}
                                        >
                                            <Text
                                                className="text-[13px] font-medium"
                                                style={{ color: isSelected ? '#FFFFFF' : '#4A5568' }}
                                            >
                                                {option.label}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                            {leftActionDescription && (
                                <Text className="text-xs mt-2" style={{ color: theme.colors.textSecondary }}>
                                    {leftActionDescription}
                                </Text>
                            )}
                        </View>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        <View className={`px-${SPACING.item.paddingHorizontal} py-${SPACING.item.paddingVertical} pb-${SPACING.item.paddingVertical}`}>
                            <Text className={`text-[13px] font-semibold mb-${SPACING.content.gap} uppercase`} style={{ color: theme.colors.text }}>
                                {t('settings.conversations.rightSwipe', 'Right swipe')}
                            </Text>
                            <View className="flex-row">
                                {swipeActionOptions.map((option, index) => {
                                    const isSelected = rightSwipeAction === option.value;
                                    const isLast = index === swipeActionOptions.length - 1;
                                    return (
                                        <TouchableOpacity
                                            key={`right-${option.value}`}
                                            className={`flex-1 py-2.5 rounded-[18px] border items-center ${!isLast ? `mr-${SPACING.content.gap}` : ''}`}
                                            style={{
                                                backgroundColor: isSelected ? '#005c67' : 'transparent',
                                                borderColor: isSelected ? '#005c67' : '#E2E8F0',
                                            }}
                                            onPress={() => setRightSwipeAction(option.value)}
                                            activeOpacity={0.9}
                                        >
                                            <Text
                                                className="text-[13px] font-medium"
                                                style={{ color: isSelected ? '#FFFFFF' : '#4A5568' }}
                                            >
                                                {option.label}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}
                            </View>
                            {rightActionDescription && (
                                <Text className="text-xs mt-2" style={{ color: theme.colors.textSecondary }}>
                                    {rightActionDescription}
                                </Text>
                            )}
                        </View>
                    </View>
                </View>

                {/* Support & Feedback */}
                <View className={`mb-${SPACING.section.gap}`}>
                    <Text className={SPACING_CLASSES.sectionTitle} style={{ color: theme.colors.text }}>{t('settings.sections.supportFeedback')}</Text>

                    <View className="rounded-2xl border overflow-hidden" style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}>
                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} pt-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}
                            onPress={() => {
                                Alert.alert(
                                    t('settings.supportFeedback.helpSupport'),
                                    t('settings.supportFeedback.helpSupportMessage'),
                                    [{ text: t('common.ok') }],
                                );
                            }}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="help-circle" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.supportFeedback.helpSupport')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t('settings.supportFeedback.helpSupportDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}
                            onPress={() => {
                                Alert.alert(
                                    t('settings.supportFeedback.sendFeedback'),
                                    t('settings.supportFeedback.sendFeedbackMessage'),
                                    [
                                        { text: t('common.cancel'), style: 'cancel' },
                                        {
                                            text: t('common.sendFeedback'),
                                            onPress: () => {
                                                Alert.alert(
                                                    t('common.success'),
                                                    t('settings.supportFeedback.sendFeedbackThankYou'),
                                                );
                                            },
                                        },
                                    ],
                                );
                            }}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="chatbubble" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>
                                        {t('settings.supportFeedback.sendFeedback')}
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t('settings.supportFeedback.sendFeedbackDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} pb-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}
                            onPress={() => {
                                Alert.alert(
                                    t('settings.supportFeedback.rateApp'),
                                    t('settings.supportFeedback.rateAppMessage'),
                                    [
                                        { text: t('common.maybeLater'), style: 'cancel' },
                                        {
                                            text: t('common.rateNow'),
                                            onPress: () => {
                                                Alert.alert(
                                                    t('common.success'),
                                                    t('settings.supportFeedback.rateAppThankYou'),
                                                );
                                            },
                                        },
                                    ],
                                );
                            }}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="star" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.supportFeedback.rateApp')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t('settings.supportFeedback.rateAppDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Privacy */}
                <View className={`mb-${SPACING.section.gap}`}>
                    <Text className={SPACING_CLASSES.sectionTitle} style={{ color: theme.colors.text }}>{t('settings.sections.privacy')}</Text>

                    <View className="rounded-2xl border overflow-hidden" style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}>
                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}
                            onPress={() => router.push('/settings/privacy')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="lock-closed" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>
                                        {t('settings.privacy.title')}
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t('settings.privacy.description')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Security & Encryption */}
                <View className={`mb-${SPACING.section.gap}`}>
                    <Text className={SPACING_CLASSES.sectionTitle} style={{ color: theme.colors.text }}>Security & Encryption</Text>

                    <View className="rounded-2xl border overflow-hidden" style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}>
                        {/* Cloud Sync */}
                        <View className={`${SPACING_CLASSES.listItem} pt-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="cloud-outline" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>
                                        Cloud Sync
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        Enable cloud backup and sync (device-first by default)
                                    </Text>
                                </View>
                            </View>
                            <Toggle
                                value={useMessagesStore((state) => state.cloudSyncEnabled)}
                                onValueChange={async (enabled) => {
                                    useMessagesStore.getState().setCloudSyncEnabled(enabled);
                                    try {
                                        await authenticatedClient.put('/profile/settings', {
                                            security: {
                                                cloudSyncEnabled: enabled,
                                            },
                                        });
                                    } catch (error) {
                                        console.error('Error updating cloud sync setting:', error);
                                    }
                                }}
                            />
                        </View>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        {/* Encryption Status */}
                        <View className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="lock-closed" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>
                                        Signal Protocol Encryption
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {useDeviceKeysStore((state) => state.isInitialized)
                                            ? 'End-to-end encryption enabled'
                                            : 'Initializing encryption...'}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent
                                name={useDeviceKeysStore((state) => state.isInitialized) ? 'checkmark-circle' : 'time-outline'}
                                size={20}
                                color={useDeviceKeysStore((state) => state.isInitialized) ? '#4CAF50' : theme.colors.textSecondary}
                            />
                        </View>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        {/* Device Info */}
                        <View className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="phone-portrait-outline" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>
                                        Device ID
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {useDeviceKeysStore((state) => state.deviceKeys?.deviceId || 'Not initialized')}
                                    </Text>
                                </View>
                            </View>
                        </View>
                    </View>
                </View>

                {/* App Preferences */}
                <View className={`mb-${SPACING.section.gap}`}>
                    <Text className={SPACING_CLASSES.sectionTitle} style={{ color: theme.colors.text }}>{t('settings.sections.preferences')}</Text>

                    <View className="rounded-2xl border overflow-hidden" style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}>
                        {/* Appearance */}
                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} pt-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}
                            onPress={() => router.push('/settings/appearance')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="color-palette" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.preferences.appearance')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t('settings.preferences.appearanceDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        {/* Language Selection */}
                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}
                            onPress={() => router.push('/settings/language')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="language" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('Language')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {getLanguageDisplayName(currentLanguage)}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>

                        {/* Font Size */}
                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}
                            onPress={() => router.push('/settings/font-size')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="text" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>
                                        {t('settings.preferences.fontSize')}
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t('settings.preferences.fontSizeDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        {/* Profile Customization */}
                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}
                            onPress={() => router.push('/settings/profile-customization')}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="person-circle-outline" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>
                                        {t('settings.preferences.profileCustomization')}
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t('settings.preferences.profileCustomizationDesc')}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        <View className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent
                                        name="notifications"
                                        size={20}
                                        color={theme.colors.textSecondary}
                                    />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.preferences.notifications')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t('settings.preferences.notificationsDesc')}
                                    </Text>
                                </View>
                            </View>
                            <Toggle
                                value={notifications}
                                onValueChange={onToggleNotifications}
                            />
                        </View>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        <View className={`${SPACING_CLASSES.listItem} pb-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}>
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="moon" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.preferences.darkMode')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t('settings.preferences.darkModeDesc')}
                                    </Text>
                                </View>
                            </View>
                            <Toggle
                                value={isDarkModeActive}
                                onValueChange={handleDarkModeToggle}
                            />
                        </View>
                    </View>
                </View>

                {/* Data Management */}
                <View className={`mb-${SPACING.section.gap}`}>
                    <Text className={SPACING_CLASSES.sectionTitle} style={{ color: theme.colors.text }}>{t('settings.sections.data')}</Text>

                    <View className="rounded-2xl border overflow-hidden" style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}>
                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} pt-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}
                            onPress={handleExportData}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="download" size={20} color={theme.colors.textSecondary} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.text }}>{t('settings.data.exportData')}</Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>{t('settings.data.exportDataDesc')}</Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}
                            onPress={handleClearCache}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="trash" size={20} color={theme.colors.error} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.error }}>
                                        {t("settings.data.clearCache")}
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>{t("settings.data.clearCacheDesc")}</Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>

                        <View className={`h-[1px] mx-${SPACING.item.paddingHorizontal}`} style={{ backgroundColor: theme.colors.border }} />

                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} pb-${SPACING.item.paddingHorizontal} flex-row items-center justify-between`}
                            onPress={handleResetPersonalization}
                        >
                            <View className="flex-row items-center flex-1">
                                <View className={`mr-${SPACING.item.iconMargin} items-center justify-center`}>
                                    <IconComponent name="refresh" size={20} color={theme.colors.error} />
                                </View>
                                <View>
                                    <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.error }}>
                                        {t("settings.data.resetPersonalization")}
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>
                                        {t("settings.data.resetPersonalizationDesc")}
                                    </Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Sign Out */}
                <View className={`mb-${SPACING.section.gap}`}>
                    <TouchableOpacity
                        className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between rounded-2xl border overflow-hidden`}
                        style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.error }}
                        onPress={handleSignOut}
                    >
                        <View className="flex-row items-center flex-1">
                            <View className="mr-3 items-center justify-center">
                                <IconComponent name="log-out" size={20} color={theme.colors.error} />
                            </View>
                            <View>
                                <Text className="text-[15px] font-medium mb-0.5" style={{ color: theme.colors.error }}>
                                    {t("settings.signOut")}
                                </Text>
                                <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>{t("settings.signOutDesc")}</Text>
                            </View>
                        </View>
                    </TouchableOpacity>
                </View>
            </Animated.ScrollView>
        </ThemedView>
    );
}
