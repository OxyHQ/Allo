/**
 * ContactPicker — bottom-sheet content for selecting a device contact to share
 * (F2.6).
 *
 * Requests contacts permission, lists the device address book (searchable) with
 * initials avatars, and hands the selected `{ name, phones[], emails[] }` back.
 * Permission denial and web (no device contacts) render graceful, i18n'd states.
 *
 * For encrypted conversations the chosen contact travels inside the E2E body
 * (handled by the messages store); this component only produces the `ContactData`.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  Platform,
  FlatList,
  TouchableOpacity,
  Linking,
  ActivityIndicator,
} from 'react-native';
import * as Contacts from 'expo-contacts';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ThemedText } from '@/components/ThemedText';
import { MessageAvatar } from '@/components/messages/MessageAvatar';
import { useTheme } from '@/hooks/useTheme';
import type { ContactData } from '@/stores/messagesStore';

interface ContactPickerProps {
  onSelect: (contact: ContactData) => void;
  onClose: () => void;
}

/** Load states driving which UI section renders. */
type LoadState = 'loading' | 'denied' | 'unavailable' | 'ready';

export const ContactPicker: React.FC<ContactPickerProps> = ({ onSelect, onClose }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [contacts, setContacts] = useState<ContactData[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [query, setQuery] = useState('');

  const loadContacts = useCallback(async () => {
    if (Platform.OS === 'web') {
      setState('unavailable');
      return;
    }
    setState('loading');
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') {
        setState('denied');
        return;
      }
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
        sort: Contacts.SortTypes.FirstName,
      });
      const mapped: ContactData[] = data
        .filter((contact) => (contact.name || '').trim().length > 0)
        .map((contact) => ({
          name: contact.name || '',
          phones: (contact.phoneNumbers || [])
            .map((phone) => phone.number)
            .filter((number): number is string => typeof number === 'string'),
          emails: (contact.emails || [])
            .map((entry) => entry.email)
            .filter((email): email is string => typeof email === 'string'),
        }));
      setContacts(mapped);
      setState('ready');
    } catch (error) {
      console.error('[ContactPicker] error loading contacts:', error);
      setState('unavailable');
    }
  }, []);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return contacts;
    return contacts.filter((contact) => contact.name.toLowerCase().includes(normalized));
  }, [query, contacts]);

  const handlePick = useCallback(
    (contact: ContactData) => {
      onSelect(contact);
      onClose();
    },
    [onSelect, onClose]
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { padding: 16, paddingTop: 0, flex: 1 },
        title: { fontSize: 18, fontWeight: '700', marginBottom: 12, color: theme.colors.text },
        searchRow: {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: theme.colors.card,
          borderRadius: 12,
          paddingHorizontal: 12,
          marginBottom: 12,
        },
        searchIcon: { marginRight: 8 },
        search: { flex: 1, paddingVertical: 10, color: theme.colors.text },
        item: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingVertical: 10,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        info: { flex: 1 },
        name: { fontSize: 15, color: theme.colors.text, fontWeight: '600' },
        sub: { fontSize: 13, color: theme.colors.textSecondary, marginTop: 2 },
        state: { paddingVertical: 48, alignItems: 'center', gap: 12 },
        stateText: { color: theme.colors.textSecondary, textAlign: 'center', maxWidth: 280 },
        settingsButton: {
          marginTop: 4,
          paddingHorizontal: 18,
          paddingVertical: 10,
          borderRadius: 999,
          backgroundColor: theme.colors.card,
        },
        settingsText: { color: theme.colors.primary, fontWeight: '600' },
      }),
    [theme]
  );

  const renderState = () => {
    if (state === 'loading') {
      return (
        <View style={styles.state}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      );
    }
    if (state === 'unavailable') {
      return (
        <View style={styles.state}>
          <Ionicons name="people-outline" size={36} color={theme.colors.textSecondary} />
          <ThemedText style={styles.stateText}>
            {Platform.OS === 'web' ? t('chat.contactsUnavailableWeb') : t('chat.noContactsFound')}
          </ThemedText>
        </View>
      );
    }
    if (state === 'denied') {
      return (
        <View style={styles.state}>
          <Ionicons name="people-outline" size={36} color={theme.colors.textSecondary} />
          <ThemedText style={styles.stateText}>{t('chat.contactsDeniedHelp')}</ThemedText>
          <TouchableOpacity
            style={styles.settingsButton}
            activeOpacity={0.7}
            onPress={() => {
              Linking.openSettings().catch((error) =>
                console.warn('[ContactPicker] openSettings failed:', error)
              );
            }}
          >
            <ThemedText style={styles.settingsText}>{t('chat.openSettings')}</ThemedText>
          </TouchableOpacity>
        </View>
      );
    }
    if (filtered.length === 0) {
      return (
        <View style={styles.state}>
          <ThemedText style={styles.stateText}>{t('chat.noContactsFound')}</ThemedText>
        </View>
      );
    }
    return (
      <FlatList
        data={filtered}
        keyExtractor={(item, index) => `${item.name}-${index}`}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.item}
            onPress={() => handlePick(item)}
            activeOpacity={0.7}
          >
            <MessageAvatar name={item.name} size={40} />
            <View style={styles.info}>
              <ThemedText style={styles.name}>{item.name}</ThemedText>
              {(item.phones?.[0] || item.emails?.[0]) && (
                <ThemedText style={styles.sub}>{item.phones?.[0] || item.emails?.[0]}</ThemedText>
              )}
            </View>
          </TouchableOpacity>
        )}
      />
    );
  };

  return (
    <View style={styles.container}>
      <ThemedText style={styles.title}>{t('chat.shareContact')}</ThemedText>
      {state === 'ready' && (
        <View style={styles.searchRow}>
          <Ionicons
            name="search"
            size={18}
            color={theme.colors.textSecondary}
            style={styles.searchIcon}
          />
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder={t('chat.searchContacts')}
            placeholderTextColor={theme.colors.textSecondary}
            autoCorrect={false}
          />
        </View>
      )}
      {renderState()}
    </View>
  );
};
