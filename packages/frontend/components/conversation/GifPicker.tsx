/**
 * GifPicker — bottom-sheet content for searching + sending GIFs (F2.6).
 *
 * Shows trending GIFs by default and live search results as the user types
 * (debounced). Results paginate with infinite scroll via `useKlipyGifs`.
 *
 * On select, the chosen GIF is DOWNLOADED to a local file and sent through the
 * standard attachment pipeline as a `gif`-type media source carrying a
 * `localUri`. This routes it through the same encrypt-once path as photos/videos
 * (Fase 1D): for encrypted chats the bytes are encrypted before upload and the
 * Klipy URL is never exposed; for deviceless chats it uploads the plaintext blob.
 * GIFs are never hotlinked from Klipy in messages, so the third party never sees
 * who received which GIF.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import { toast } from '@/lib/sonner';
import { useKlipyGifs } from '@/hooks/useKlipyGifs';
import { isKlipyConfigured, type KlipyGif } from '@/lib/klipy';
import { downloadToCache } from '@/lib/downloadToCache';
import type { OutgoingMediaSource } from '@/lib/outgoingMedia';
import type { AttachmentPayload } from '@/stores/messagesStore';

interface GifPickerProps {
  onSend: (payload: AttachmentPayload) => void;
  onClose: () => void;
}

/** Columns in the GIF grid. */
const GRID_COLUMNS = 2;
/** Debounce for the search input before issuing a query (ms). */
const SEARCH_DEBOUNCE_MS = 350;
/** MIME type for every GIF (Klipy serves animated GIFs). */
const GIF_MIME = 'image/gif';

export const GifPicker: React.FC<GifPickerProps> = ({ onSend, onClose }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const [query, setQuery] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const configured = isKlipyConfigured();
  const { gifs, isLoading, isError, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useKlipyGifs(query);

  // Debounce the committed query so each keystroke doesn't fire a request. A
  // single timer keyed off the latest input; cleared on unmount.
  useEffect(() => {
    const handle = setTimeout(() => setQuery(inputValue), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [inputValue]);

  const handleSelect = useCallback(
    async (gif: KlipyGif) => {
      if (downloadingId) return;
      setDownloadingId(gif.id);
      const pending = toast.loading(t('chat.uploadingMedia'));
      try {
        const localUri = await downloadToCache(gif.url, `gif-${gif.id}.gif`);
        const source: OutgoingMediaSource = {
          id: `local-gif-${Date.now()}`,
          type: 'gif',
          localUri,
          fileName: `gif-${gif.id}.gif`,
          mimeType: GIF_MIME,
          width: gif.width,
          height: gif.height,
        };
        onSend({ attachmentType: 'gif', media: [source] });
        onClose();
      } catch (error) {
        console.error('[GifPicker] Failed to prepare GIF:', error);
        toast.error(t('chat.gifSendFailed'));
      } finally {
        toast.dismiss(pending);
        setDownloadingId(null);
      }
    },
    [downloadingId, onSend, onClose, t]
  );

  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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
        search: {
          flex: 1,
          paddingVertical: 10,
          color: theme.colors.text,
        },
        cell: {
          flex: 1,
          margin: 4,
          aspectRatio: 1,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: theme.colors.backgroundSecondary,
        },
        image: { width: '100%', height: '100%' },
        cellOverlay: {
          ...StyleSheet.absoluteFill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.overlay,
        },
        state: { paddingVertical: 48, alignItems: 'center', gap: 8 },
        stateText: { color: theme.colors.textSecondary, textAlign: 'center' },
        footer: { paddingVertical: 16, alignItems: 'center' },
      }),
    [theme]
  );

  const renderItem = useCallback(
    ({ item }: { item: KlipyGif }) => (
      <TouchableOpacity
        style={styles.cell}
        activeOpacity={0.7}
        onPress={() => {
          void handleSelect(item);
        }}
        accessibilityRole="imagebutton"
        accessibilityLabel={item.title || t('chat.gifSearch')}
      >
        <Image
          source={{ uri: item.previewUrl }}
          style={styles.image}
          contentFit="cover"
          transition={120}
        />
        {downloadingId === item.id && (
          <View style={styles.cellOverlay}>
            <ActivityIndicator color={theme.colors.primaryForeground} />
          </View>
        )}
      </TouchableOpacity>
    ),
    [styles, handleSelect, downloadingId, theme.colors.primaryForeground, t]
  );

  const renderBody = () => {
    if (!configured) {
      return (
        <View style={styles.state}>
          <Ionicons name="cloud-offline-outline" size={32} color={theme.colors.textSecondary} />
          <ThemedText style={styles.stateText}>{t('chat.gifUnavailable')}</ThemedText>
        </View>
      );
    }
    if (isError) {
      return (
        <View style={styles.state}>
          <Ionicons name="warning-outline" size={32} color={theme.colors.textSecondary} />
          <ThemedText style={styles.stateText}>{t('chat.gifError')}</ThemedText>
        </View>
      );
    }
    if (isLoading) {
      return (
        <View style={styles.state}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      );
    }
    if (gifs.length === 0) {
      return (
        <View style={styles.state}>
          <Ionicons name="search-outline" size={32} color={theme.colors.textSecondary} />
          <ThemedText style={styles.stateText}>{t('chat.gifNoResults')}</ThemedText>
        </View>
      );
    }
    return (
      <FlashList
        data={gifs}
        keyExtractor={(item) => item.id}
        numColumns={GRID_COLUMNS}
        renderItem={renderItem}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.6}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={styles.footer}>
              <ActivityIndicator color={theme.colors.primary} />
            </View>
          ) : null
        }
      />
    );
  };

  return (
    <View style={styles.container}>
      <ThemedText style={styles.title}>{t('chat.gifLabel')}</ThemedText>
      <View style={styles.searchRow}>
        <Ionicons
          name="search"
          size={18}
          color={theme.colors.textSecondary}
          style={styles.searchIcon}
        />
        <TextInput
          style={styles.search}
          value={inputValue}
          onChangeText={setInputValue}
          placeholder={t('chat.gifSearch')}
          placeholderTextColor={theme.colors.textSecondary}
          editable={configured}
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>
      {renderBody()}
    </View>
  );
};
