import React, { useEffect, useMemo } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useAppearanceStore } from '@/store/appearanceStore';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import AvatarShapePicker from '@/components/avatar/AvatarShapePicker';
import { useMyAvatarShape } from '@/hooks/useAvatarShape';
import type { AvatarShapeKey } from '@/components/avatar/avatarShapes';
import Avatar from '@/components/Avatar';
import { useOxy } from '@oxyhq/services';

export default function ProfileCustomizationScreen() {
  const { t } = useTranslation();
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const theme = useTheme();
  const currentAvatarShape = useMyAvatarShape();
  const { user, oxyServices } = useOxy();

  useEffect(() => {
    loadMySettings();
  }, [loadMySettings]);

  const avatarUri = useMemo(() => {
    if (!user?.avatar) return undefined;
    return oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb');
  }, [user?.avatar, oxyServices]);

  const displayName = useMemo(() => {
    if (user?.name?.first) {
      return `${user.name.first}${user.name.last ? ` ${user.name.last}` : ''}`;
    }
    return user?.username || 'You';
  }, [user]);

  const handleAvatarShapeSelect = async (shape: AvatarShapeKey) => {
    console.log('[ProfileCustomization] Avatar shape selected:', shape);
    console.log('[ProfileCustomization] Current mySettings:', mySettings);
    console.log('[ProfileCustomization] Current avatar shape:', currentAvatarShape);
    try {
      const result = await updateMySettings({
        profileCustomization: {
          ...mySettings?.profileCustomization,
          avatarShape: shape,
        },
      } as any);
      console.log('[ProfileCustomization] Update result:', result);
    } catch (error) {
      console.error('Error updating avatar shape:', error);
    }
  };

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.profileCustomization.title'),
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
      <ScrollView contentContainerClassName="p-4">
        {/* Avatar Preview */}
        <View
          className="rounded-xl border p-6 mb-6"
          style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}
        >
          <View className="items-center">
            <Avatar
              size={80}
              source={avatarUri ? { uri: avatarUri } : undefined}
              label={displayName.charAt(0).toUpperCase()}
              shape={currentAvatarShape}
            />
            <Text className="text-lg font-bold mt-3" style={{ color: theme.colors.text }}>
              {displayName}
            </Text>
            {user?.username && (
              <Text className="text-sm mt-0.5" style={{ color: theme.colors.textSecondary }}>
                @{user.username}
              </Text>
            )}
          </View>
        </View>

        {/* Avatar Shape */}
        <Text className="text-lg font-bold mb-3" style={{ color: theme.colors.text }}>
          Avatar Shape
        </Text>
        <View
          className="rounded-xl border p-4"
          style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}
        >
          <AvatarShapePicker
            selected={currentAvatarShape}
            onSelect={handleAvatarShapeSelect}
          />
        </View>

        {/* Info Text */}
        <Text
          className="text-[13px] leading-[18px] mt-4 px-1"
          style={{ color: theme.colors.textSecondary }}
        >
          {t('settings.profileCustomization.info')}
        </Text>
      </ScrollView>
    </ThemedView>
  );
}
