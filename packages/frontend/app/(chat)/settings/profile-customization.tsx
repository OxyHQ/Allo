import React, { useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
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
    try {
      await updateMySettings({
        profileCustomization: {
          ...mySettings?.profileCustomization,
          avatarShape: shape,
        },
      } as any);
    } catch (error) {
      console.error('Error updating avatar shape:', error);
    }
  };

  return (
    <ThemedView style={styles.container}>
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
      <ScrollView contentContainerStyle={styles.content}>
        {/* Avatar Preview */}
        <View style={[styles.previewCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
          <View style={styles.previewInner}>
            <Avatar
              size={80}
              source={avatarUri ? { uri: avatarUri } : undefined}
              label={displayName.charAt(0).toUpperCase()}
              shape={currentAvatarShape}
            />
            <Text style={[styles.previewName, { color: theme.colors.text }]}>
              {displayName}
            </Text>
            {user?.username && (
              <Text style={[styles.previewUsername, { color: theme.colors.textSecondary }]}>
                @{user.username}
              </Text>
            )}
          </View>
        </View>

        {/* Avatar Shape */}
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
          Avatar Shape
        </Text>
        <View style={[styles.shapeCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
          <AvatarShapePicker
            selected={currentAvatarShape}
            onSelect={handleAvatarShapeSelect}
          />
        </View>

        {/* Info Text */}
        <Text style={[styles.infoText, { color: theme.colors.textSecondary }]}>
          {t('settings.profileCustomization.info')}
        </Text>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  previewCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 24,
    marginBottom: 24,
  },
  previewInner: {
    alignItems: 'center',
  },
  previewName: {
    fontSize: 18,
    fontWeight: '700',
    marginTop: 12,
  },
  previewUsername: {
    fontSize: 14,
    marginTop: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  shapeCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
  },
  infoText: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 16,
    paddingHorizontal: 4,
  },
});
