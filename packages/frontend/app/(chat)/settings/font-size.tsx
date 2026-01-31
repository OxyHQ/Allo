import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { useMessagePreferencesStore } from '@/stores';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';

const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 24;
const FONT_SIZE_STEP = 1;

export default function FontSizeSettingsScreen() {
  const theme = useTheme();
  const messageTextSize = useMessagePreferencesStore((state) => state.messageTextSize);
  const setMessageTextSize = useMessagePreferencesStore((state) => state.setMessageTextSize);
  const resetMessageTextSize = useMessagePreferencesStore((state) => state.resetMessageTextSize);

  const [localSize, setLocalSize] = useState(messageTextSize);

  useEffect(() => {
    setLocalSize(messageTextSize);
  }, [messageTextSize]);

  const handleSizeChange = (size: number) => {
    setLocalSize(size);
    setMessageTextSize(size);
  };

  const handleReset = () => {
    resetMessageTextSize();
    setLocalSize(MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE);
  };

  const isDefault = localSize === MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE;

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: 'Font Size',
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
        {/* Preview Section */}
        <View
          className="rounded-xl border p-4 mb-6"
          style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}
        >
          <Text
            className="text-[13px] font-semibold mb-3 uppercase tracking-wide"
            style={{ color: theme.colors.textSecondary }}
          >
            Preview
          </Text>
          <View
            className="rounded-[18px] px-3 py-2 self-end max-w-[80%]"
            style={{ backgroundColor: theme.colors.primary || '#007AFF' }}
          >
            <Text className="leading-5 text-white" style={{ fontSize: localSize }}>
              This is how your messages will look
            </Text>
          </View>
        </View>

        {/* Size Selection Section */}
        <View className="mb-8">
          <View className="flex-row justify-between items-center mb-4">
            <Text className="text-base font-semibold" style={{ color: theme.colors.text }}>
              Message Font Size
            </Text>
            <Text className="text-base font-bold" style={{ color: theme.colors.primary || '#007AFF' }}>
              {localSize}px
            </Text>
          </View>

          {/* Size Buttons */}
          <View className="flex-row flex-wrap gap-2 justify-center">
            {Array.from({ length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 }, (_, i) => {
              const size = FONT_SIZE_MIN + i;
              const isSelected = localSize === size;
              return (
                <TouchableOpacity
                  key={size}
                  className="w-12 h-12 rounded-full border-2 items-center justify-center"
                  style={{
                    backgroundColor: isSelected
                      ? (theme.colors.primary || '#007AFF')
                      : theme.colors.card,
                    borderColor: isSelected
                      ? (theme.colors.primary || '#007AFF')
                      : theme.colors.border,
                  }}
                  onPress={() => handleSizeChange(size)}
                >
                  <Text
                    className="font-semibold"
                    style={{
                      color: isSelected ? '#FFFFFF' : theme.colors.text,
                      fontSize: size,
                    }}
                  >
                    Aa
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Size Presets */}
        <View className="mb-6">
          <Text className="text-base font-semibold mb-3" style={{ color: theme.colors.text }}>
            Quick Presets
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {[
              { label: 'Small', size: 14 },
              { label: 'Medium', size: 16 },
              { label: 'Large', size: 18 },
              { label: 'Extra Large', size: 20 },
            ].map((preset) => {
              const isSelected = localSize === preset.size;
              return (
                <TouchableOpacity
                  key={preset.label}
                  className="flex-1 min-w-[45%] py-4 px-3 rounded-xl items-center"
                  style={{
                    backgroundColor: isSelected
                      ? (theme.colors.primary || '#007AFF')
                      : theme.colors.card,
                    borderColor: theme.colors.border,
                    borderWidth: isSelected ? 2 : 1,
                  }}
                  onPress={() => handleSizeChange(preset.size)}
                >
                  <Text
                    className="text-sm font-semibold mb-1"
                    style={{
                      color: isSelected ? '#FFFFFF' : theme.colors.text,
                    }}
                  >
                    {preset.label}
                  </Text>
                  <Text
                    className="text-xs"
                    style={{
                      color: isSelected
                        ? 'rgba(255,255,255,0.8)'
                        : theme.colors.textSecondary,
                    }}
                  >
                    {preset.size}px
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Reset Button */}
        {!isDefault && (
          <TouchableOpacity
            className="py-3.5 rounded-xl border items-center mt-2"
            style={{ borderColor: theme.colors.border }}
            onPress={handleReset}
          >
            <Text className="text-[15px] font-semibold" style={{ color: theme.colors.text }}>
              Reset to Default
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </ThemedView>
  );
}

