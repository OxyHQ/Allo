import React, { useState, useEffect } from 'react';
import { View, ScrollView, ActivityIndicator } from 'react-native';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useOxy } from '@oxyhq/services';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';

const IconComponent = Ionicons;

interface PrivacySettings {
    profileVisibility?: 'public' | 'private' | 'followers_only';
    showContactInfo?: boolean;
    allowTags?: boolean;
    allowallos?: boolean;
    showOnlineStatus?: boolean;
    hideLikeCounts?: boolean;
    hideShareCounts?: boolean;
    hiddenWords?: string[];
    restrictedUsers?: string[];
}

export default function PrivacySettingsScreen() {
    const { t } = useTranslation();
    const theme = useTheme();
    const { user } = useOxy();

    const [privacySettings, setPrivacySettings] = useState<PrivacySettings>({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadPrivacySettings();
    }, []);

    const loadPrivacySettings = async () => {
        try {
            const response = await authenticatedClient.get<{ data?: { privacy?: PrivacySettings } }>('/profile/settings/me');
            const settings = response.data;
            setPrivacySettings(settings?.privacy || { profileVisibility: 'public' });
            setLoading(false);
        } catch (error) {
            console.error('Error loading privacy settings:', error);
            setPrivacySettings({ profileVisibility: 'public' });
            setLoading(false);
        }
    };

    const updatePrivacySettings = async (updates: Partial<PrivacySettings>) => {
        try {
            const newSettings = { ...privacySettings, ...updates };
            await authenticatedClient.put('/profile/settings', {
                privacy: newSettings
            });
            setPrivacySettings(newSettings);
        } catch (error) {
            console.error('Error updating privacy settings:', error);
        }
    };

    const handlePrivateProfilePress = () => {
        router.push('/settings/privacy/profile-visibility');
    };

    const handleTagsallosPress = () => {
        router.push('/settings/privacy/tags-allos');
    };

    const handleOnlineStatusPress = () => {
        router.push('/settings/privacy/online-status');
    };

    const handleRestrictedProfilesPress = () => {
        router.push('/settings/privacy/restricted');
    };

    const handleBlockedProfilesPress = () => {
        router.push('/settings/privacy/blocked');
    };

    const handleHiddenWordsPress = () => {
        router.push('/settings/privacy/hidden-words');
    };

    const handleHideLikeShareCountsPress = () => {
        router.push('/settings/privacy/hide-counts');
    };

    const getProfileVisibilityText = () => {
        const visibility = privacySettings.profileVisibility || 'public';
        if (visibility === 'private') return t('settings.privacy.private');
        if (visibility === 'followers_only') return t('settings.privacy.followersOnly');
        return t('settings.privacy.public');
    };

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.title'),
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
                <View className="flex-1 justify-center items-center">
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                </View>
            </ThemedView>
        );
    }

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.privacy.title'),
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

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-4 pt-5 pb-6"
                showsVerticalScrollIndicator={false}
            >
                <SettingsListGroup>
                    <SettingsListItem
                        icon={<IconComponent name="lock-closed" size={20} color={theme.colors.text} />}
                        title={t('settings.privacy.privateProfile')}
                        value={getProfileVisibilityText()}
                        onPress={handlePrivateProfilePress}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="at" size={20} color={theme.colors.text} />}
                        title={t('settings.privacy.tagsAndallos')}
                        onPress={handleTagsallosPress}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="ellipse" size={20} color={theme.colors.text} />}
                        title={t('settings.privacy.onlineStatus')}
                        onPress={handleOnlineStatusPress}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="people" size={20} color={theme.colors.text} />}
                        title={t('settings.privacy.restrictedProfiles')}
                        onPress={handleRestrictedProfilesPress}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="close-circle" size={20} color={theme.colors.text} />}
                        title={t('settings.privacy.blockedProfiles')}
                        onPress={handleBlockedProfilesPress}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="eye-off" size={20} color={theme.colors.text} />}
                        title={t('settings.privacy.hiddenWords')}
                        onPress={handleHiddenWordsPress}
                    />
                    <SettingsListItem
                        icon={<IconComponent name="heart-outline" size={20} color={theme.colors.text} />}
                        title={t('settings.privacy.hideLikeShareCounts')}
                        onPress={handleHideLikeShareCountsPress}
                    />
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}

