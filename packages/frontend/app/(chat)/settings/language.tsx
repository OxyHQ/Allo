import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { storeData, getData } from '@/utils/storage';

const IconComponent = Ionicons;

const LANGUAGE_OPTIONS = [
    { code: 'en-US', name: 'English', nativeName: 'English', flag: '🇺🇸' },
    { code: 'es-ES', name: 'Spanish', nativeName: 'Español', flag: '🇪🇸' },
    { code: 'it-IT', name: 'Italian', nativeName: 'Italiano', flag: '🇮🇹' },
];

const LANGUAGE_STORAGE_KEY = 'user_language_preference';

export default function LanguageSettingsScreen() {
    const { t } = useTranslation();
    const theme = useTheme();
    const [currentLanguage, setCurrentLanguage] = useState<string>('en-US');
    const [saving, setSaving] = useState(false);

    const loadLanguage = useCallback(async () => {
        try {
            const savedLanguage = await getData<string>(LANGUAGE_STORAGE_KEY);
            const language = savedLanguage || i18n.language || 'en-US';
            setCurrentLanguage(language);
        } catch (error) {
            console.error('Error loading language:', error);
            setCurrentLanguage(i18n.language || 'en-US');
        }
    }, []);

    // Reads the stored preference, which lives outside React.
    useEffect(() => {
        void loadLanguage();
    }, [loadLanguage]);

    const handleLanguageChange = useCallback(async (languageCode: string) => {
        if (languageCode === currentLanguage) return;

        try {
            setSaving(true);
            setCurrentLanguage(languageCode);
            
            // Save to storage
            await storeData(LANGUAGE_STORAGE_KEY, languageCode);
            
            // Change i18n language
            await i18n.changeLanguage(languageCode);
            
            // Small delay to show feedback
            await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
            console.error('Error changing language:', error);
            // Revert on error
            setCurrentLanguage(i18n.language || 'en-US');
        } finally {
            setSaving(false);
        }
    }, [currentLanguage]);

    const getLanguageDisplayName = (option: typeof LANGUAGE_OPTIONS[0]) => {
        return `${option.flag} ${option.nativeName} (${option.name})`;
    };

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('Language'),
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
                {saving && (
                    <View className="flex-row items-center justify-center py-3 mb-4 gap-2">
                        <ActivityIndicator size="small" color={theme.colors.primary} />
                        <Text className="text-sm" style={{ color: theme.colors.textSecondary }}>
                            {t('common.saving')}
                        </Text>
                    </View>
                )}

                <SettingsListGroup title={t('settings.language.selectLanguage')}>
                    {LANGUAGE_OPTIONS.map((option) => {
                        const isSelected = currentLanguage === option.code;
                        const isChanging = saving && isSelected;

                        return (
                            <SettingsListItem
                                key={option.code}
                                title={getLanguageDisplayName(option)}
                                onPress={() => handleLanguageChange(option.code)}
                                disabled={saving}
                                showChevron={false}
                                rightElement={
                                    isSelected ? (
                                        isChanging ? (
                                            <ActivityIndicator size="small" color={theme.colors.primary} />
                                        ) : (
                                            <IconComponent name="checkmark-circle" size={24} color={theme.colors.primary} />
                                        )
                                    ) : null
                                }
                            />
                        );
                    })}
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}

