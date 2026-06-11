/**
 * PollComposer — bottom sheet content for creating a new poll attachment.
 * Question + 2–10 options + multi-select toggle.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, ScrollView, Switch } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import type { PollData } from '@/stores/messagesStore';

const MAX_OPTIONS = 10;
const MIN_OPTIONS = 2;

interface PollComposerProps {
  onSubmit: (poll: PollData) => void;
  onClose: () => void;
}

export const PollComposer: React.FC<PollComposerProps> = ({ onSubmit, onClose }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multi, setMulti] = useState(false);

  const updateOption = useCallback((idx: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === idx ? value : o)));
  }, []);

  const addOption = useCallback(() => {
    setOptions((prev) => (prev.length < MAX_OPTIONS ? [...prev, ''] : prev));
  }, []);

  const removeOption = useCallback((idx: number) => {
    setOptions((prev) => (prev.length > MIN_OPTIONS ? prev.filter((_, i) => i !== idx) : prev));
  }, []);

  const validOptions = options.map((o) => o.trim()).filter((o) => o.length > 0);
  const canSubmit = question.trim().length > 0 && validOptions.length >= MIN_OPTIONS;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    onSubmit({
      question: question.trim(),
      options: validOptions.map((text) => ({ text, votes: [] })),
      multi,
    });
    onClose();
  }, [canSubmit, question, validOptions, multi, onSubmit, onClose]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { padding: 16, paddingTop: 0 },
        title: { fontSize: 18, fontWeight: '700', marginBottom: 16, color: theme.colors.text },
        label: {
          fontSize: 13,
          color: theme.colors.textSecondary || '#666',
          marginBottom: 6,
          fontWeight: '600',
        },
        input: {
          backgroundColor: theme.colors.card || '#F0F0F0',
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 12,
          fontSize: 15,
          color: theme.colors.text,
          marginBottom: 16,
        },
        optionRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          marginBottom: 10,
        },
        optionInput: {
          flex: 1,
          backgroundColor: theme.colors.card || '#F0F0F0',
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 10,
          fontSize: 15,
          color: theme.colors.text,
        },
        iconButton: {
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.card || '#F0F0F0',
        },
        addRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          marginTop: 4,
          marginBottom: 16,
        },
        multiRow: {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingVertical: 8,
          marginBottom: 12,
        },
        submit: {
          backgroundColor: theme.colors.primary || '#007AFF',
          paddingVertical: 14,
          borderRadius: 14,
          alignItems: 'center',
          opacity: canSubmit ? 1 : 0.5,
        },
        submitText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
      }),
    [theme, canSubmit]
  );

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <ThemedText style={styles.title}>{t('chat.createPoll')}</ThemedText>

      <ThemedText style={styles.label}>{t('chat.pollQuestion')}</ThemedText>
      <TextInput
        style={styles.input}
        value={question}
        onChangeText={setQuestion}
        placeholder={t('chat.pollQuestionPlaceholder') || ''}
        placeholderTextColor={theme.colors.textSecondary || '#999'}
        maxLength={300}
      />

      <ThemedText style={styles.label}>{t('chat.pollOptions')}</ThemedText>
      {options.map((opt, idx) => (
        <View key={idx} style={styles.optionRow}>
          <TextInput
            style={styles.optionInput}
            value={opt}
            onChangeText={(v) => updateOption(idx, v)}
            placeholder={`${t('chat.pollOption')} ${idx + 1}`}
            placeholderTextColor={theme.colors.textSecondary || '#999'}
            maxLength={120}
          />
          {options.length > MIN_OPTIONS && (
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => removeOption(idx)}
              activeOpacity={0.7}
            >
              <Ionicons name="close" size={18} color={theme.colors.text} />
            </TouchableOpacity>
          )}
        </View>
      ))}

      {options.length < MAX_OPTIONS && (
        <TouchableOpacity style={styles.addRow} onPress={addOption} activeOpacity={0.7}>
          <Ionicons name="add-circle-outline" size={22} color={theme.colors.primary || '#007AFF'} />
          <ThemedText style={{ color: theme.colors.primary || '#007AFF', fontWeight: '600' }}>
            {t('chat.pollAddOption')}
          </ThemedText>
        </TouchableOpacity>
      )}

      <View style={styles.multiRow}>
        <ThemedText>{t('chat.pollAllowMulti')}</ThemedText>
        <Switch value={multi} onValueChange={setMulti} />
      </View>

      <TouchableOpacity
        style={styles.submit}
        onPress={handleSubmit}
        activeOpacity={0.85}
        disabled={!canSubmit}
      >
        <ThemedText style={styles.submitText}>{t('chat.pollCreate')}</ThemedText>
      </TouchableOpacity>
    </ScrollView>
  );
};
