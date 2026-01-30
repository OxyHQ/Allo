import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
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
    <ThemedView style={styles.container}>
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
      <View style={styles.content}>
        <View style={[styles.placeholder, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
          <IconComponent name="moon-outline" size={48} color={theme.colors.textTertiary} />
          <Text style={[styles.placeholderTitle, { color: theme.colors.text }]}>
            Auto-Night Mode
          </Text>
          <Text style={[styles.placeholderDesc, { color: theme.colors.textSecondary }]}>
            Automatically switch to dark theme based on time of day or ambient light. Coming soon.
          </Text>
        </View>
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, padding: 16, justifyContent: 'center', alignItems: 'center' },
  placeholder: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 32,
    alignItems: 'center',
    width: '100%',
  },
  placeholderTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
  },
  placeholderDesc: {
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
});
