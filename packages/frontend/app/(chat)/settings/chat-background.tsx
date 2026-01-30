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

export default function ChatBackgroundScreen() {
  const theme = useTheme();

  return (
    <ThemedView style={styles.container}>
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
      <View style={styles.content}>
        <View style={[styles.placeholder, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
          <IconComponent name="image-outline" size={48} color={theme.colors.textTertiary} />
          <Text style={[styles.placeholderTitle, { color: theme.colors.text }]}>
            Chat Background
          </Text>
          <Text style={[styles.placeholderDesc, { color: theme.colors.textSecondary }]}>
            Choose a background for your chat conversations. Coming soon.
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
