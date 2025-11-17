import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
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
    <ThemedView style={styles.container}>
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
      <ScrollView contentContainerStyle={styles.content}>
        {/* Preview Section */}
        <View style={[styles.previewCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
          <Text style={[styles.previewLabel, { color: theme.colors.textSecondary }]}>Preview</Text>
          <View style={[styles.previewBubble, { backgroundColor: theme.colors.primary || '#007AFF' }]}>
            <Text style={[styles.previewText, { fontSize: localSize, color: '#FFFFFF' }]}>
              This is how your messages will look
            </Text>
          </View>
        </View>

        {/* Size Selection Section */}
        <View style={styles.sizeSection}>
          <View style={styles.sizeHeader}>
            <Text style={[styles.sizeLabel, { color: theme.colors.text }]}>Message Font Size</Text>
            <Text style={[styles.sizeValue, { color: theme.colors.primary || '#007AFF' }]}>
              {localSize}px
            </Text>
          </View>
          
          {/* Size Buttons */}
          <View style={styles.sizeButtons}>
            {Array.from({ length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 }, (_, i) => {
              const size = FONT_SIZE_MIN + i;
              const isSelected = localSize === size;
              return (
                <TouchableOpacity
                  key={size}
                  style={[
                    styles.sizeButton,
                    {
                      backgroundColor: isSelected
                        ? (theme.colors.primary || '#007AFF')
                        : theme.colors.card,
                      borderColor: isSelected
                        ? (theme.colors.primary || '#007AFF')
                        : theme.colors.border,
                    },
                  ]}
                  onPress={() => handleSizeChange(size)}
                >
                  <Text
                    style={[
                      styles.sizeButtonText,
                      {
                        color: isSelected ? '#FFFFFF' : theme.colors.text,
                        fontSize: size,
                      },
                    ]}
                  >
                    Aa
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Size Presets */}
        <View style={styles.presetsSection}>
          <Text style={[styles.presetsLabel, { color: theme.colors.text }]}>Quick Presets</Text>
          <View style={styles.presetsRow}>
            {[
              { label: 'Small', size: 14 },
              { label: 'Medium', size: 16 },
              { label: 'Large', size: 18 },
              { label: 'Extra Large', size: 20 },
            ].map((preset) => (
              <TouchableOpacity
                key={preset.label}
                style={[
                  styles.presetButton,
                  { 
                    backgroundColor: localSize === preset.size 
                      ? (theme.colors.primary || '#007AFF')
                      : theme.colors.card,
                    borderColor: theme.colors.border,
                  },
                  localSize === preset.size && styles.presetButtonActive,
                ]}
                onPress={() => handleSizeChange(preset.size)}
              >
                <Text
                  style={[
                    styles.presetText,
                    { 
                      color: localSize === preset.size 
                        ? '#FFFFFF'
                        : theme.colors.text,
                    },
                  ]}
                >
                  {preset.label}
                </Text>
                <Text
                  style={[
                    styles.presetSize,
                    { 
                      color: localSize === preset.size 
                        ? 'rgba(255,255,255,0.8)'
                        : theme.colors.textSecondary,
                    },
                  ]}
                >
                  {preset.size}px
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Reset Button */}
        {!isDefault && (
          <TouchableOpacity
            style={[styles.resetButton, { borderColor: theme.colors.border }]}
            onPress={handleReset}
          >
            <Text style={[styles.resetButtonText, { color: theme.colors.text }]}>Reset to Default</Text>
          </TouchableOpacity>
        )}
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
    padding: 16,
    marginBottom: 24,
  },
  previewLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  previewBubble: {
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: 'flex-end',
    maxWidth: '80%',
  },
  previewText: {
    lineHeight: 20,
  },
  sizeSection: {
    marginBottom: 32,
  },
  sizeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sizeLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
  sizeValue: {
    fontSize: 16,
    fontWeight: '700',
  },
  sizeButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
  },
  sizeButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sizeButtonText: {
    fontWeight: '600',
  },
  presetsSection: {
    marginBottom: 24,
  },
  presetsLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  presetsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  presetButton: {
    flex: 1,
    minWidth: '45%',
    paddingVertical: 16,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  presetButtonActive: {
    borderWidth: 2,
  },
  presetText: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  presetSize: {
    fontSize: 12,
  },
  resetButton: {
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    marginTop: 8,
  },
  resetButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
});

