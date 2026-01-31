import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
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

const IconComponent = Ionicons as any;

// Color themes: each supports both light and dark modes
const COLOR_THEMES = [
  {
    id: 'classic',
    label: 'Classic',
    primaryColor: '#21C063',
    light: {
      bubbleSent: '#21C063',
      bubbleReceived: '#FFFFFF',
      textSent: '#FFFFFF',
      textReceived: '#000000',
      background: '#E5DDD5',
    },
    dark: {
      bubbleSent: '#21C063',
      bubbleReceived: '#1E1E2E',
      textSent: '#FFFFFF',
      textReceived: '#E0E0E0',
      background: '#0D0D1A',
    },
  },
  {
    id: 'day',
    label: 'Day',
    primaryColor: '#1D9BF0',
    light: {
      bubbleSent: '#1D9BF0',
      bubbleReceived: '#FFFFFF',
      textSent: '#FFFFFF',
      textReceived: '#000000',
      background: '#C8DCF0',
    },
    dark: {
      bubbleSent: '#1D9BF0',
      bubbleReceived: '#1E1E2E',
      textSent: '#FFFFFF',
      textReceived: '#E0E0E0',
      background: '#0D1A24',
    },
  },
  {
    id: 'purple',
    label: 'Purple',
    primaryColor: '#8B5CF6',
    light: {
      bubbleSent: '#8B5CF6',
      bubbleReceived: '#FFFFFF',
      textSent: '#FFFFFF',
      textReceived: '#000000',
      background: '#E9D5FF',
    },
    dark: {
      bubbleSent: '#8B5CF6',
      bubbleReceived: '#1E1E2E',
      textSent: '#FFFFFF',
      textReceived: '#E0E0E0',
      background: '#0D0D1A',
    },
  },
  {
    id: 'teal',
    label: 'Teal',
    primaryColor: '#005c67',
    light: {
      bubbleSent: '#005c67',
      bubbleReceived: '#FFFFFF',
      textSent: '#FFFFFF',
      textReceived: '#000000',
      background: '#B2D8D8',
    },
    dark: {
      bubbleSent: '#005c67',
      bubbleReceived: '#1E1E2E',
      textSent: '#FFFFFF',
      textReceived: '#E0E0E0',
      background: '#0A1414',
    },
  },
];

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
    <ThemedView style={styles.container}>
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
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* THEME MODE */}
        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>
          THEME MODE
        </Text>
        <View style={styles.themeModeRow}>
          {(['light', 'dark', 'system'] as const).map((mode) => {
            const isSelected = selectedThemeMode === mode;
            const modeLabels = { light: 'Light', dark: 'Dark', system: 'System' };
            return (
              <TouchableOpacity
                key={mode}
                style={[
                  styles.themeModeButton,
                  {
                    backgroundColor: isSelected ? selectedColorTheme.primaryColor : theme.colors.card,
                    borderColor: theme.colors.border,
                  },
                ]}
                onPress={() => onSelectThemeMode(mode)}
                activeOpacity={0.8}
              >
                <Text
                  style={[
                    styles.themeModeLabel,
                    {
                      color: isSelected ? '#FFFFFF' : theme.colors.text,
                      fontWeight: isSelected ? '600' : '400',
                    },
                  ]}
                >
                  {modeLabels[mode]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* COLOR THEME */}
        <Text style={[styles.sectionTitle, styles.sectionTitleSpaced, { color: theme.colors.textSecondary }]}>
          COLOR THEME
        </Text>

        {/* Live chat preview using real MessageBubble components */}
        <View
          style={[
            styles.previewCard,
            { backgroundColor: selectedVariant.background, borderColor: theme.colors.border },
          ]}
        >
          <MessageBubble
            id="preview-received"
            text="Good morning! 👋&#10;Do you know what time it is?"
            timestamp={new Date(2025, 0, 1, 0, 20)}
            isSent={false}
            senderName="Bob Harris"
            showSenderName={true}
            showTimestamp={true}
            readStatus="read"
          />
          <View style={{ height: 6 }} />
          <MessageBubble
            id="preview-sent"
            text="It's morning in Tokyo 😎"
            timestamp={new Date(2025, 0, 1, 0, 20)}
            isSent={true}
            showSenderName={false}
            showTimestamp={true}
            readStatus="read"
          />
        </View>

        {/* Color theme picker */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.themePicker}
        >
          {COLOR_THEMES.map((colorTheme) => {
            const isSelected = selectedColorThemeId === colorTheme.id;
            const variant = colorTheme[effectiveMode];
            return (
              <TouchableOpacity
                key={colorTheme.id}
                style={[
                  styles.themeCard,
                  {
                    borderColor: isSelected ? colorTheme.primaryColor : theme.colors.border,
                    borderWidth: isSelected ? 2.5 : 1,
                  },
                ]}
                onPress={() => onSelectColorTheme(colorTheme)}
                activeOpacity={0.8}
              >
                {/* Mini preview */}
                <View style={[styles.themeCardPreview, { backgroundColor: variant.background }]}>
                  <View
                    style={[
                      styles.themeCardBubbleLeft,
                      { backgroundColor: variant.bubbleReceived },
                    ]}
                  />
                  <View
                    style={[
                      styles.themeCardBubbleRight,
                      { backgroundColor: variant.bubbleSent },
                    ]}
                  />
                </View>
                <Text
                  style={[
                    styles.themeCardLabel,
                    {
                      color: isSelected ? colorTheme.primaryColor : theme.colors.text,
                      fontWeight: isSelected ? '600' : '400',
                    },
                  ]}
                >
                  {colorTheme.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Chat Background + Auto-Night Mode */}
        <View
          style={[
            styles.settingsCard,
            { backgroundColor: theme.colors.card, borderColor: theme.colors.border },
          ]}
        >
          <TouchableOpacity
            style={[styles.settingRow, styles.firstRow]}
            onPress={() => router.push('/settings/chat-background' as any)}
          >
            <Text style={[styles.settingRowLabel, { color: theme.colors.text }]}>
              Chat Background
            </Text>
            <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
          </TouchableOpacity>
          <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
          <TouchableOpacity
            style={[styles.settingRow, styles.lastRow]}
            onPress={() => router.push('/settings/auto-night-mode' as any)}
          >
            <Text style={[styles.settingRowLabel, { color: theme.colors.text }]}>
              Auto-Night Mode
            </Text>
            <View style={styles.settingRowRight}>
              <Text style={[styles.settingRowValue, { color: theme.colors.textTertiary }]}>
                Disabled
              </Text>
              <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
            </View>
          </TouchableOpacity>
        </View>

        {/* TEXT SIZE */}
        <Text style={[styles.sectionTitle, styles.sectionTitleSpaced, { color: theme.colors.textSecondary }]}>
          TEXT SIZE
        </Text>
        <View
          style={[
            styles.settingsCard,
            styles.sliderCard,
            { backgroundColor: theme.colors.card, borderColor: theme.colors.border },
          ]}
        >
          <Text style={[styles.sliderLabelSmall, { color: theme.colors.text }]}>A</Text>
          <Slider
            style={styles.slider}
            minimumValue={FONT_SIZE_MIN}
            maximumValue={FONT_SIZE_MAX}
            step={1}
            value={messageTextSize}
            onValueChange={onTextSizeChange}
            minimumTrackTintColor={selectedColorTheme.primaryColor}
            maximumTrackTintColor={theme.colors.border}
            thumbTintColor={selectedColorTheme.primaryColor}
          />
          <Text style={[styles.sliderLabelLarge, { color: theme.colors.text }]}>A</Text>
        </View>

        {/* APP ICON */}
        <Text style={[styles.sectionTitle, styles.sectionTitleSpaced, { color: theme.colors.textSecondary }]}>
          APP ICON
        </Text>
        <View style={styles.iconRow}>
          {APP_ICONS.map((appIcon) => {
            const isSelected = selectedIconId === appIcon.id;
            return (
              <TouchableOpacity
                key={appIcon.id}
                style={styles.iconOption}
                onPress={() => setSelectedIconId(appIcon.id)}
                activeOpacity={0.8}
              >
                <View
                  style={[
                    styles.iconBox,
                    {
                      backgroundColor: appIcon.bgColor,
                      borderColor: isSelected ? theme.colors.primary : 'transparent',
                      borderWidth: isSelected ? 2.5 : 0,
                    },
                  ]}
                >
                  <LogoIcon size={28} color={appIcon.logoColor} />
                </View>
                <Text
                  style={[
                    styles.iconLabel,
                    {
                      color: isSelected ? theme.colors.primary : theme.colors.textSecondary,
                      fontWeight: isSelected ? '600' : '400',
                    },
                  ]}
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

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 40 },

  // Section titles
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  sectionTitleSpaced: {
    marginTop: 28,
  },

  // Live preview
  previewCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    marginBottom: 16,
  },

  // Theme mode toggle
  themeModeRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  themeModeButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeModeLabel: {
    fontSize: 15,
  },

  // Theme picker
  themePicker: {
    paddingBottom: 20,
    gap: 12,
  },
  themeCard: {
    width: 90,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
  },
  themeCardPreview: {
    width: '100%',
    height: 60,
    padding: 10,
    justifyContent: 'space-between',
  },
  themeCardBubbleLeft: {
    width: '60%',
    height: 14,
    borderRadius: 7,
    alignSelf: 'flex-start',
  },
  themeCardBubbleRight: {
    width: '50%',
    height: 14,
    borderRadius: 7,
    alignSelf: 'flex-end',
  },
  themeCardLabel: {
    fontSize: 13,
    paddingVertical: 8,
  },

  // Settings card (Chat Background, Auto-Night)
  settingsCard: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  firstRow: {
    paddingTop: 16,
  },
  lastRow: {
    paddingBottom: 16,
  },
  settingRowLabel: {
    fontSize: 16,
    fontWeight: '400',
  },
  settingRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  settingRowValue: {
    fontSize: 16,
  },
  divider: {
    height: 1,
    marginHorizontal: 16,
  },

  // Text size slider
  sliderCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  slider: {
    flex: 1,
    marginHorizontal: 8,
  },
  sliderLabelSmall: {
    fontSize: 14,
    fontWeight: '400',
  },
  sliderLabelLarge: {
    fontSize: 22,
    fontWeight: '400',
  },

  // App icon
  iconRow: {
    flexDirection: 'row',
    gap: 16,
    paddingVertical: 4,
  },
  iconOption: {
    alignItems: 'center',
  },
  iconBox: {
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconLabel: {
    fontSize: 12,
    marginTop: 6,
  },
});
