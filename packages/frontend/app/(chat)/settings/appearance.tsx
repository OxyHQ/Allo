import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Switch,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { useAppearanceStore } from '@/store/appearanceStore';
import { colors as baseColors } from '@/styles/colors';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { useMessagePreferencesStore } from '@/stores';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';
import { MessageBubble } from '@/components/messages/MessageBubble';
import { LogoIcon } from '@/assets/logo';
import { COLOR_THEMES } from '@/styles/colorThemes';

const IconComponent = Ionicons as any;

// App icon options (visual only for now)
const APP_ICONS = [
  { id: 'default', label: 'Default', bgColor: '#1D9BF0', logoColor: '#FFFFFF' },
  { id: 'default-x', label: 'Default X', bgColor: '#000000', logoColor: '#FFFFFF' },
  { id: 'classic', label: 'Classic', bgColor: '#21C063', logoColor: '#FFFFFF' },
  { id: 'classic-x', label: 'Classic X', bgColor: '#718096', logoColor: '#FFFFFF' },
];

const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 24;

export default function AppearanceSettingsScreen() {
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loading = useAppearanceStore((state) => state.loading);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const theme = useTheme();

  const messageTextSize = useMessagePreferencesStore((state) => state.messageTextSize);
  const setMessageTextSize = useMessagePreferencesStore((state) => state.setMessageTextSize);

  const [selectedColorThemeId, setSelectedColorThemeId] = useState('classic');
  const [selectedThemeMode, setSelectedThemeMode] = useState<'light' | 'dark' | 'system'>('system');
  const [selectedIconId, setSelectedIconId] = useState('default');
  const [autoNightMode, setAutoNightMode] = useState(false);

  useEffect(() => {
    loadMySettings();
  }, [loadMySettings]);

  // Derive selected color theme and mode from current settings
  useEffect(() => {
    if (mySettings) {
      const mode = mySettings.appearance?.themeMode || 'system';
      const colorTheme = mySettings.appearance?.colorTheme || 'classic';
      setSelectedThemeMode(mode);
      setSelectedColorThemeId(colorTheme);
    }
  }, [mySettings]);

  // Get the effective theme mode (resolve 'system' to light or dark based on device settings)
  const effectiveMode = useMemo(() => {
    if (selectedThemeMode === 'system') {
      return theme.isDark ? 'dark' : 'light';
    }
    return selectedThemeMode;
  }, [selectedThemeMode, theme.isDark]);

  const selectedColorTheme = useMemo(
    () => COLOR_THEMES.find((t) => t.id === selectedColorThemeId) || COLOR_THEMES[0],
    [selectedColorThemeId]
  );

  const selectedVariant = useMemo(
    () => selectedColorTheme[effectiveMode],
    [selectedColorTheme, effectiveMode]
  );

  const onSelectColorTheme = useCallback(
    async (colorTheme: (typeof COLOR_THEMES)[0]) => {
      setSelectedColorThemeId(colorTheme.id);
      await updateMySettings({
        appearance: {
          themeMode: selectedThemeMode,
          colorTheme: colorTheme.id,
          primaryColor: colorTheme.primaryColor,
        },
      } as any);
    },
    [updateMySettings, selectedThemeMode]
  );

  const onSelectThemeMode = useCallback(
    async (mode: 'light' | 'dark' | 'system') => {
      setSelectedThemeMode(mode);
      await updateMySettings({
        appearance: {
          themeMode: mode,
          colorTheme: selectedColorThemeId,
          primaryColor: selectedColorTheme.primaryColor,
        },
      } as any);
    },
    [updateMySettings, selectedColorThemeId, selectedColorTheme]
  );

  const onTextSizeChange = useCallback(
    (value: number) => {
      setMessageTextSize(Math.round(value));
    },
    [setMessageTextSize]
  );

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: 'Appearance',
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView className="px-4 pt-2 pb-10" showsVerticalScrollIndicator={false}>
        {/* THEME MODE */}
        <Text className="text-[13px] font-semibold uppercase tracking-wide mb-2 px-1" style={{ color: theme.colors.textSecondary }}>
          THEME MODE
        </Text>
        <View className="flex-row gap-2.5 mb-5">
          {(['light', 'dark', 'system'] as const).map((mode) => {
            const isSelected = selectedThemeMode === mode;
            const modeLabels = { light: 'Light', dark: 'Dark', system: 'System' };
            return (
              <TouchableOpacity
                key={mode}
                className="flex-1 py-3 px-4 rounded-xl border items-center justify-center"
                style={{
                  backgroundColor: isSelected ? selectedColorTheme.primaryColor : theme.colors.card,
                  borderColor: theme.colors.border,
                }}
                onPress={() => onSelectThemeMode(mode)}
                activeOpacity={0.8}
              >
                <Text
                  className="text-[15px]"
                  style={{
                    color: isSelected ? '#FFFFFF' : theme.colors.text,
                    fontWeight: isSelected ? '600' : '400',
                  }}
                >
                  {modeLabels[mode]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* COLOR THEME */}
        <Text className="text-[13px] font-semibold uppercase tracking-wide mb-2 px-1 mt-7" style={{ color: theme.colors.textSecondary }}>
          COLOR THEME
        </Text>

        {/* Live chat preview using real MessageBubble components */}
        <View
          className="rounded-[14px] border p-3 mb-4"
          style={{ backgroundColor: selectedVariant.chatBackground, borderColor: theme.colors.border }}
        >
          <MessageBubble
            key={`preview-received-${selectedColorThemeId}-${effectiveMode}`}
            id="preview-received"
            text="Good morning! 👋&#10;Do you know what time it is?"
            timestamp={new Date(2025, 0, 1, 0, 20)}
            isSent={false}
            senderName="Bob Harris"
            showSenderName={true}
            showTimestamp={true}
            readStatus="read"
            bubbleColor={selectedVariant.bubbleReceived}
            textColor={selectedVariant.textReceived}
          />
          <View className="h-1.5" />
          <MessageBubble
            key={`preview-sent-${selectedColorThemeId}-${effectiveMode}`}
            id="preview-sent"
            text="It's morning in Tokyo 😎"
            timestamp={new Date(2025, 0, 1, 0, 20)}
            isSent={true}
            showSenderName={false}
            showTimestamp={true}
            readStatus="read"
            bubbleColor={selectedVariant.bubbleSent}
            textColor={selectedVariant.textSent}
          />
        </View>

        {/* Color theme picker */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          className="pb-5 gap-3"
        >
          {COLOR_THEMES.map((colorTheme) => {
            const isSelected = selectedColorThemeId === colorTheme.id;
            const variant = colorTheme[effectiveMode];
            return (
              <TouchableOpacity
                key={colorTheme.id}
                className="w-[90px] rounded-xl overflow-hidden items-center"
                style={{
                  borderColor: isSelected ? colorTheme.primaryColor : theme.colors.border,
                  borderWidth: isSelected ? 2.5 : 1,
                }}
                onPress={() => onSelectColorTheme(colorTheme)}
                activeOpacity={0.8}
              >
                {/* Mini preview */}
                <View className="w-full h-[60px] p-2.5 justify-between" style={{ backgroundColor: variant.chatBackground }}>
                  <View
                    className="w-[60%] h-3.5 rounded-[7px] self-start"
                    style={{ backgroundColor: variant.bubbleReceived }}
                  />
                  <View
                    className="w-[50%] h-3.5 rounded-[7px] self-end"
                    style={{ backgroundColor: variant.bubbleSent }}
                  />
                </View>
                <Text
                  className="text-[13px] py-2"
                  style={{
                    color: isSelected ? colorTheme.primaryColor : theme.colors.text,
                    fontWeight: isSelected ? '600' : '400',
                  }}
                >
                  {colorTheme.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Chat Background + Auto-Night Mode */}
        <View
          className="rounded-2xl border overflow-hidden"
          style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}
        >
          <TouchableOpacity
            className="flex-row items-center justify-between px-4 py-3.5 pt-4"
            onPress={() => router.push('/settings/chat-background' as any)}
          >
            <Text className="text-base" style={{ color: theme.colors.text }}>
              Chat Background
            </Text>
            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
          </TouchableOpacity>
          <View className="h-[1px] mx-4" style={{ backgroundColor: theme.colors.border }} />
          <View className="flex-row items-center justify-between px-4 py-3.5 pb-4">
            <Text className="text-base" style={{ color: theme.colors.text }}>
              Auto-Night Mode
            </Text>
            <Switch
              value={autoNightMode}
              onValueChange={setAutoNightMode}
              trackColor={{ false: theme.colors.border, true: selectedColorTheme.primaryColor }}
              thumbColor="#FFFFFF"
              ios_backgroundColor={theme.colors.border}
            />
          </View>
        </View>

        {/* TEXT SIZE */}
        <Text className="text-[13px] font-semibold uppercase tracking-wide mb-2 px-1 mt-7" style={{ color: theme.colors.textSecondary }}>
          TEXT SIZE
        </Text>
        <View
          className="rounded-2xl border flex-row items-center px-4 py-3.5"
          style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}
        >
          <Text className="text-sm" style={{ color: theme.colors.text }}>A</Text>
          <Slider
            style={{ flex: 1, marginHorizontal: 8 }}
            minimumValue={FONT_SIZE_MIN}
            maximumValue={FONT_SIZE_MAX}
            step={1}
            value={messageTextSize}
            onValueChange={onTextSizeChange}
            minimumTrackTintColor={selectedColorTheme.primaryColor}
            maximumTrackTintColor={theme.colors.border}
            thumbTintColor={selectedColorTheme.primaryColor}
          />
          <Text className="text-[22px]" style={{ color: theme.colors.text }}>A</Text>
        </View>

        {/* APP ICON */}
        <Text className="text-[13px] font-semibold uppercase tracking-wide mb-2 px-1 mt-7" style={{ color: theme.colors.textSecondary }}>
          APP ICON
        </Text>
        <View className="flex-row gap-4 py-1">
          {APP_ICONS.map((appIcon) => {
            const isSelected = selectedIconId === appIcon.id;
            return (
              <TouchableOpacity
                key={appIcon.id}
                className="items-center"
                onPress={() => setSelectedIconId(appIcon.id)}
                activeOpacity={0.8}
              >
                <View
                  className="w-16 h-16 rounded-2xl items-center justify-center"
                  style={{
                    backgroundColor: appIcon.bgColor,
                    borderColor: isSelected ? theme.colors.primary : 'transparent',
                    borderWidth: isSelected ? 2.5 : 0,
                  }}
                >
                  <LogoIcon size={28} color={appIcon.logoColor} />
                </View>
                <Text
                  className="text-xs mt-1.5"
                  style={{
                    color: isSelected ? theme.colors.primary : theme.colors.textSecondary,
                    fontWeight: isSelected ? '600' : '400',
                  }}
                >
                  {appIcon.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>
    </ThemedView>
  );
}

