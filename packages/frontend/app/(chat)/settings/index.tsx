import { useCallback, useEffect, useState, useRef, useMemo } from "react";
import { View, Text, TouchableOpacity, Alert, ScrollView, Animated } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { Header } from "@/components/layout/Header";
import { HeaderIconButton } from "@/components/layout/HeaderIconButton";
import { Toggle } from "@/components/Toggle";
import { RecoveryDisclosure } from "@/components/matrix/RecoveryDisclosure";
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { useOxy } from "@oxyhq/services";
import { useTranslation } from "react-i18next";

import { Ionicons } from "@expo/vector-icons";
import { SettingsListGroup, SettingsListItem } from "@oxyhq/bloom/settings-list";
import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { LogoIcon } from "@/assets/logo";
import { authenticatedClient } from "@/utils/api";
import { confirmDialog, alertDialog } from "@/utils/alerts";
import { getData, storeData } from "@/utils/storage";
// (already imported above)
import { hasNotificationPermission, requestNotificationPermissions } from "@/utils/notifications";
import { isPushEnabled, NOTIFICATION_PREFERENCE_KEY } from "@/lib/chat/pushRegistration";
import { matrixRuntime } from "@/lib/chat/matrixRuntime";
import { signOutOfMatrix } from "@/hooks/useMatrixRuntime";
import { useTheme } from "@/hooks/useTheme";
import { getThemedBorder, getThemedShadow } from "@/utils/theme";
import { useAppearanceStore } from "@/stores/appearanceStore";
import { useColorScheme } from "@/hooks/useColorScheme";
import i18n from 'i18next';
import {
    useConversationSwipePreferencesStore,
    SwipeActionType,
} from '@/stores';
import { useMessagesStore } from '@/stores/messagesStore';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import { SPACING, SPACING_CLASSES } from '@/constants/spacing';

const IconComponent = Ionicons;

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

    const cloudSyncEnabled = useMessagesStore((state) => state.cloudSyncEnabled);
    const deviceKeysInitialized = useDeviceKeysStore((state) => state.isInitialized);
    // deviceId is a number; format it here because the row renders a string.
    // Compared against undefined rather than truthiness so device 0 still reads
    // as initialized.
    const deviceId = useDeviceKeysStore((state) =>
        state.deviceKeys?.deviceId !== undefined
            ? String(state.deviceKeys.deviceId)
            : 'Not initialized'
    );

    const onToggleCloudSync = useCallback(async (enabled: boolean) => {
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
    }, []);

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

    /**
     * Turning notifications on or off.
     *
     * The switch writes the preference and then asks the runtime to bring the
     * homeserver in line with it: on Matrix the pusher lives on the homeserver,
     * so "off" is a pusher deleted there rather than a token deleted here. Allo
     * keeps no device tokens of its own any more — see `docs/matrix/push.md`.
     *
     * Permission is requested only when switching **on**, because that is the
     * moment the user has asked for notifications. Being denied still leaves the
     * preference on: the pusher is registered either way and the notifications
     * start appearing the moment permission is granted in system settings, which
     * is better than a switch that silently flips itself back.
     */
    const onToggleNotifications = useCallback(async (value: boolean) => {
        setNotifications(value);
        await storeData(NOTIFICATION_PREFERENCE_KEY, value);
        if (value && Constants.appOwnership !== 'expo') {
            const granted = await hasNotificationPermission() || await requestNotificationPermissions();
            if (!granted) {
                await alertDialog({
                    title: t('Notifications'),
                    message: t('notification.permission.denied'),
                });
            }
        }
        await matrixRuntime.syncPushRegistration();
    }, [t]);

    // Load initial notifications toggle from storage
    useEffect(() => {
        let mounted = true;
        const load = async () => {
            const saved = await isPushEnabled();
            if (!mounted) return;
            setNotifications(saved);
        };
        load();
        return () => { mounted = false; };
    }, []);

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
        });
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
        // Ends the Matrix session — on the homeserver, and everywhere it was kept
        // on this device. Does nothing in a build talking to the Allo API, where
        // the account is Oxy's and signing out of it is not this screen's to do.
        await signOutOfMatrix();
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
                {/*
                  The two account rows keep their own markup: they lead with a
                  40px avatar disc, and SettingsListItem's icon slot is a fixed
                  20x20 box that a disc that size would spill out of. The group
                  around them is Bloom's, so the card matches every other section.
                */}
                <SettingsListGroup title={t("settings.sections.account")}>
                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}
                            onPress={() => showBottomSheet?.("ManageAccount")}
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
                                                : user.name?.displayName || user.username
                                            : 'User'}
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>{user?.username || 'Username'}</Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            className={`${SPACING_CLASSES.listItem} flex-row items-center justify-between`}
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
                                                : user.name?.displayName || user.username
                                            : 'User'}
                                    </Text>
                                    <Text className="text-[13px]" style={{ color: theme.colors.textSecondary }}>{user?.username || 'Username'}</Text>
                                </View>
                            </View>
                            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                        </TouchableOpacity>
                </SettingsListGroup>

                {/* About allo */}
                <SettingsListGroup title={t('settings.sections.aboutallo')}>
                    <SettingsListItem
                        icon={<LogoIcon size={20} color={theme.colors.primary} />}
                        title={t('settings.aboutallo.appName')}
                        description={t('settings.aboutallo.version', {
                            version: Constants.expoConfig?.version || '1.0.0',
                        })}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="hammer" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.aboutallo.build')}
                        description={
                            typeof Constants.expoConfig?.runtimeVersion === 'string'
                                ? Constants.expoConfig.runtimeVersion
                                : t('settings.aboutallo.buildVersion')
                        }
                    />
                    <SettingsListItem
                        icon={<IconComponent name="phone-portrait" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.aboutallo.platform')}
                        description={
                            Constants.platform?.ios
                                ? 'iOS'
                                : Constants.platform?.android
                                    ? 'Android'
                                    : 'Web'
                        }
                    />
                    <SettingsListItem
                        icon={<IconComponent name="code-slash" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.aboutallo.oxySDK')}
                        description={oxySdkVersion}
                        onPress={() => showBottomSheet?.('AppInfo')}
                        showChevron={false}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="code-slash" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.aboutallo.expoSDK')}
                        description={expoSdkVersion}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="globe" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.aboutallo.apiUrl')}
                        description={apiUrl}
                    />
                </SettingsListGroup>

                {/* Conversation Swipes */}
                <SettingsListGroup title={t('settings.sections.conversations', 'Conversations')}>
                        <SettingsListItem
                            icon={<IconComponent name="swap-horizontal" size={20} color={theme.colors.textSecondary} />}
                            title={t('settings.conversations.swipeTitle', 'Swipe actions')}
                            description={t('settings.conversations.swipeSubtitle', 'Choose what happens when you swipe chats.')}
                        />

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
                </SettingsListGroup>

                {/* Support & Feedback */}
                <SettingsListGroup title={t('settings.sections.supportFeedback')}>
                    <SettingsListItem
                        icon={<IconComponent name="help-circle" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.supportFeedback.helpSupport')}
                        description={t('settings.supportFeedback.helpSupportDesc')}
                        onPress={() => {
                            Alert.alert(
                                t('settings.supportFeedback.helpSupport'),
                                t('settings.supportFeedback.helpSupportMessage'),
                                [{ text: t('common.ok') }],
                            );
                        }}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="chatbubble" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.supportFeedback.sendFeedback')}
                        description={t('settings.supportFeedback.sendFeedbackDesc')}
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
                    />
                    <SettingsListItem
                        icon={<IconComponent name="star" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.supportFeedback.rateApp')}
                        description={t('settings.supportFeedback.rateAppDesc')}
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
                    />
                </SettingsListGroup>

                {/* Privacy */}
                <SettingsListGroup title={t('settings.sections.privacy')}>
                    <SettingsListItem
                        icon={<IconComponent name="lock-closed" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.privacy.title')}
                        description={t('settings.privacy.description')}
                        onPress={() => router.push('/settings/privacy')}
                    />
                </SettingsListGroup>

                {/* Linked accounts — conversations Allo carries from other networks */}
                <SettingsListGroup title={t('settings.sections.linkedAccounts', 'Other networks')}>
                    <SettingsListItem
                        icon={<IconComponent name="git-network-outline" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.linkedAccounts.title', 'Linked accounts')}
                        description={t('settings.linkedAccounts.description', 'Bring conversations from other messaging networks into Allo')}
                        onPress={() => router.push('/settings/linked-accounts')}
                    />
                </SettingsListGroup>

                {/* Security & Encryption */}
                <SettingsListGroup title="Security & Encryption">
                    <SettingsListItem
                        icon={<IconComponent name="cloud-outline" size={20} color={theme.colors.textSecondary} />}
                        title="Cloud Sync"
                        description="Enable cloud backup and sync (device-first by default)"
                        rightElement={
                            <Toggle
                                value={cloudSyncEnabled}
                                onValueChange={onToggleCloudSync}
                            />
                        }
                    />
                    <SettingsListItem
                        icon={<IconComponent name="lock-closed" size={20} color={theme.colors.textSecondary} />}
                        title="Signal Protocol Encryption"
                        description={
                            deviceKeysInitialized
                                ? 'End-to-end encryption enabled'
                                : 'Initializing encryption...'
                        }
                        rightElement={
                            <IconComponent
                                name={deviceKeysInitialized ? 'checkmark-circle' : 'time-outline'}
                                size={20}
                                color={deviceKeysInitialized ? '#4CAF50' : theme.colors.textSecondary}
                            />
                        }
                    />
                    <SettingsListItem
                        icon={<IconComponent name="phone-portrait-outline" size={20} color={theme.colors.textSecondary} />}
                        title="Device ID"
                        description={deviceId}
                    />
                    <RecoveryDisclosure />
                </SettingsListGroup>

                {/* App Preferences */}
                <SettingsListGroup title={t('settings.sections.preferences')}>
                    <SettingsListItem
                        icon={<IconComponent name="color-palette" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.preferences.appearance')}
                        description={t('settings.preferences.appearanceDesc')}
                        onPress={() => router.push('/settings/appearance')}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="language" size={20} color={theme.colors.textSecondary} />}
                        title={t('Language')}
                        description={getLanguageDisplayName(currentLanguage)}
                        onPress={() => router.push('/settings/language')}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="text" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.preferences.fontSize')}
                        description={t('settings.preferences.fontSizeDesc')}
                        onPress={() => router.push('/settings/font-size')}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="person-circle-outline" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.preferences.profileCustomization')}
                        description={t('settings.preferences.profileCustomizationDesc')}
                        onPress={() => router.push('/settings/profile-customization')}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="notifications" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.preferences.notifications')}
                        description={t('settings.preferences.notificationsDesc')}
                        rightElement={
                            <Toggle
                                value={notifications}
                                onValueChange={onToggleNotifications}
                            />
                        }
                    />
                    <SettingsListItem
                        icon={<IconComponent name="moon" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.preferences.darkMode')}
                        description={t('settings.preferences.darkModeDesc')}
                        rightElement={
                            <Toggle
                                value={isDarkModeActive}
                                onValueChange={handleDarkModeToggle}
                            />
                        }
                    />
                </SettingsListGroup>

                {/* Data Management */}
                <SettingsListGroup title={t('settings.sections.data')}>
                    <SettingsListItem
                        icon={<IconComponent name="download" size={20} color={theme.colors.textSecondary} />}
                        title={t('settings.data.exportData')}
                        description={t('settings.data.exportDataDesc')}
                        onPress={handleExportData}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="trash" size={20} color={theme.colors.error} />}
                        title={t('settings.data.clearCache')}
                        description={t('settings.data.clearCacheDesc')}
                        destructive
                        onPress={handleClearCache}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="refresh" size={20} color={theme.colors.error} />}
                        title={t('settings.data.resetPersonalization')}
                        description={t('settings.data.resetPersonalizationDesc')}
                        destructive
                        onPress={handleResetPersonalization}
                    />
                </SettingsListGroup>

                {/* Sign Out */}
                <SettingsListGroup>
                    <SettingsListItem
                        icon={<IconComponent name="log-out" size={20} color={theme.colors.error} />}
                        title={t('settings.signOut')}
                        description={t('settings.signOutDesc')}
                        destructive
                        showChevron={false}
                        onPress={handleSignOut}
                    />
                </SettingsListGroup>
            </Animated.ScrollView>
        </ThemedView>
    );
}
