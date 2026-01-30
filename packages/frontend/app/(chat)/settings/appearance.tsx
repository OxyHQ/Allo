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

// Theme presets: each defines a themeMode + primaryColor combination
const THEME_PRESETS = [
  {
    id: 'classic',
    label: 'Classic',
    themeMode: 'light' as const,
    primaryColor: '#21C063',
    bubbleSent: '#21C063',
    bubbleReceived: '#FFFFFF',
    textSent: '#FFFFFF',
    textReceived: '#000000',
    background: '#E5DDD5',
  },
  {
    id: 'day',
    label: 'Day',
    themeMode: 'light' as const,
    primaryColor: '#1D9BF0',
    bubbleSent: '#1D9BF0',
    bubbleReceived: '#FFFFFF',
    textSent: '#FFFFFF',
    textReceived: '#000000',
    background: '#C8DCF0',
  },
  {
    id: 'night',
    label: 'Night',
    themeMode: 'dark' as const,
    primaryColor: '#8B5CF6',
    bubbleSent: '#8B5CF6',
    bubbleReceived: '#1E1E2E',
    textSent: '#FFFFFF',
    textReceived: '#E0E0E0',
    background: '#0D0D1A',
  },
  {
    id: 'teal',
    label: 'Teal',
    themeMode: 'light' as const,
    primaryColor: '#005c67',
    bubbleSent: '#005c67',
    bubbleReceived: '#FFFFFF',
    textSent: '#FFFFFF',
    textReceived: '#000000',
    background: '#B2D8D8',
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

  const [selectedThemeId, setSelectedThemeId] = useState('classic');
  const [selectedIconId, setSelectedIconId] = useState('default');

  useEffect(() => {
    loadMySettings();
  }, [loadMySettings]);

  // Derive selected theme from current settings
  useEffect(() => {
    if (mySettings) {
      const mode = mySettings.appearance?.themeMode || 'system';
      const color = mySettings.appearance?.primaryColor || '';
      // Find matching preset
      const match = THEME_PRESETS.find(
        (p) => p.themeMode === (mode === 'system' ? 'light' : mode) && p.primaryColor === color
      );
      if (match) {
        setSelectedThemeId(match.id);
      }
    }
  }, [mySettings]);

  const selectedPreset = useMemo(
    () => THEME_PRESETS.find((p) => p.id === selectedThemeId) || THEME_PRESETS[0],
    [selectedThemeId]
  );

  const onSelectTheme = useCallback(
    async (preset: (typeof THEME_PRESETS)[0]) => {
      setSelectedThemeId(preset.id);
      await updateMySettings({
        appearance: {
          themeMode: preset.themeMode,
          primaryColor: preset.primaryColor,
        },
      } as any);
    },
    [updateMySettings]
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
        {/* COLOR THEME */}
        <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>
          COLOR THEME
        </Text>

        {/* Live chat preview using real MessageBubble components */}
        <View
          style={[
            styles.previewCard,
            { backgroundColor: selectedPreset.background, borderColor: theme.colors.border },
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

        {/* Theme preset picker */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.themePicker}
        >
          {THEME_PRESETS.map((preset) => {
            const isSelected = selectedThemeId === preset.id;
            return (
              <TouchableOpacity
                key={preset.id}
                style={[
                  styles.themeCard,
                  {
                    borderColor: isSelected ? preset.primaryColor : theme.colors.border,
                    borderWidth: isSelected ? 2.5 : 1,
                  },
                ]}
                onPress={() => onSelectTheme(preset)}
                activeOpacity={0.8}
              >
                {/* Mini preview */}
                <View style={[styles.themeCardPreview, { backgroundColor: preset.background }]}>
                  <View
                    style={[
                      styles.themeCardBubbleLeft,
                      { backgroundColor: preset.bubbleReceived },
                    ]}
                  />
                  <View
                    style={[
                      styles.themeCardBubbleRight,
                      { backgroundColor: preset.bubbleSent },
                    ]}
                  />
                </View>
                <Text
                  style={[
                    styles.themeCardLabel,
                    {
                      color: isSelected ? preset.primaryColor : theme.colors.text,
                      fontWeight: isSelected ? '600' : '400',
                    },
                  ]}
                >
                  {preset.label}
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
            minimumTrackTintColor={selectedPreset.primaryColor}
            maximumTrackTintColor={theme.colors.border}
            thumbTintColor={selectedPreset.primaryColor}
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
