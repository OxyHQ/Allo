import React from 'react';
import { View, Text } from 'react-native';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { Ionicons } from '@expo/vector-icons';

const IconComponent = Ionicons as any;

export default function AutoNightModeScreen() {
  const theme = useTheme();

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: 'Auto-Night Mode',
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      <View className="flex-1 p-4 justify-center items-center">
        <View
          className="rounded-2xl border p-8 items-center w-full"
          style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}
        >
          <IconComponent name="moon-outline" size={48} color={theme.colors.textTertiary} />
          <Text className="text-lg font-semibold mt-4" style={{ color: theme.colors.text }}>
            Auto-Night Mode
          </Text>
          <Text
            className="text-sm text-center mt-2 leading-5"
            style={{ color: theme.colors.textSecondary }}
          >
            Automatically switch to dark theme based on time of day or ambient light. Coming soon.
          </Text>
        </View>
      </View>
    </ThemedView>
  );
}
