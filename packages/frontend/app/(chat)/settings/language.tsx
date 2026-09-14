import React, { useCallback } from 'react';
import { ScrollView } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { getNativeLanguageName } from '@oxy.so/core';

const IconComponent = Ionicons;

/**
 * The app's UI language is an Oxy-account concern, not Allo's: Oxy already
 * resolves it (account locales when signed in, a device/guest locale
 * otherwise) and ships the picker that reads and writes it
 * (`LanguageSelectorScreen`, opened here the same way every other Oxy-owned
 * surface is — `showBottomSheet('LanguageSelector')`, exactly like
 * `ManageAccount`/`FileManagement` elsewhere in Settings). This screen was
 * purely that picker, so it now just opens the shared sheet.
 */
export default function LanguageSettingsScreen() {
    const { t } = useTranslation();
    const theme = useTheme();
    const { showBottomSheet, currentLanguage, currentLanguages } = useOxy();

    const openLanguageSelector = useCallback(() => {
        showBottomSheet?.('LanguageSelector');
    }, [showBottomSheet]);

    // Account locales when there are any (signed in, or a guest override was
    // set), else the single resolved device/fallback locale — the same
    // fallback `LanguageSelectorScreen` itself uses.
    const selectedLanguages = currentLanguages.length > 0 ? currentLanguages : [currentLanguage];
    const languageDescription = selectedLanguages.map((code) => getNativeLanguageName(code)).join(', ');

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
                <SettingsListGroup title={t('settings.language.selectLanguage')}>
                    <SettingsListItem
                        icon={<IconComponent name="language" size={20} color={theme.colors.textSecondary} />}
                        title={t('Language')}
                        description={languageDescription}
                        onPress={openLanguageSelector}
                    />
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}

