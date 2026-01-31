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

export default function ChatBackgroundScreen() {
  const theme = useTheme();

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: 'Chat Background',
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
          <IconComponent name="image-outline" size={48} color={theme.colors.textTertiary} />
          <Text className="text-lg font-semibold mt-4" style={{ color: theme.colors.text }}>
            Chat Background
          </Text>
          <Text
            className="text-sm text-center mt-2 leading-5"
            style={{ color: theme.colors.textSecondary }}
          >
            Choose a background for your chat conversations. Coming soon.
          </Text>
        </View>
      </View>
    </ThemedView>
  );
}
