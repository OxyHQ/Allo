import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { MediaView, TimelineItemView } from '@allo/core';
import { ChatEmptyState } from '@oxy.so/bloom/chat-screen';
import { messageEntities } from '@oxy.so/bloom/message-bubble';
import { DocumentGrid, SharedMediaGrid } from '@oxy.so/bloom/message-media';
import { Item } from '@oxy.so/bloom/item';

import { useMediaUri } from '@/lib/allo/useMediaUri';

/** How many attachments a tab draws before it stops decrypting thumbnails. */
const LIMIT = 30;

interface Attachment {
  id: string;
  media: MediaView;
}

/** The newest attachments of these kinds, newest first. */
function attachmentsOf(items: readonly TimelineItemView[], kinds: readonly MediaView['kind'][]): Attachment[] {
  const found: Attachment[] = [];
  for (let index = items.length - 1; index >= 0 && found.length < LIMIT; index -= 1) {
    const content = items[index].content;
    if (content.kind === 'media' && kinds.includes(content.media.kind)) {
      found.push({ id: items[index].id, media: content.media });
    }
  }
  return found;
}

/** What a tab's count says: what the LOADED history holds, which is all this device can know. */
export function countOf(items: readonly TimelineItemView[], kinds: readonly MediaView['kind'][]): number | undefined {
  const count = items.reduce(
    (total, item) => (item.content.kind === 'media' && kinds.includes(item.content.media.kind) ? total + 1 : total),
    0,
  );
  return count > 0 ? count : undefined;
}

/**
 * Decrypts one tile's thumbnail and hands the URI up. A component rather than a
 * loop, because a hook cannot run per item of a list that changes length.
 */
function TileSource({ attachment, onReady }: { attachment: Attachment; onReady: (id: string, uri: string) => void }) {
  const ref = attachment.media.thumbnail?.ref ?? attachment.media.ref;
  const mime = attachment.media.thumbnail ? 'image/jpeg' : attachment.media.mime;
  const { uri } = useMediaUri(ref, mime);
  useEffect(() => {
    if (uri) onReady(attachment.id, uri);
  }, [attachment.id, onReady, uri]);
  return null;
}

/** The pictures and videos in the loaded history, newest first. */
export function SharedMedia({ items }: { items: readonly TimelineItemView[] }) {
  const { t } = useTranslation();
  const attachments = useMemo(() => attachmentsOf(items, ['image', 'video']), [items]);
  const [uris, setUris] = useState<Record<string, string>>({});
  const onReady = useCallback((id: string, uri: string) => {
    setUris((current) => (current[id] === uri ? current : { ...current, [id]: uri }));
  }, []);

  if (attachments.length === 0) return <ChatEmptyState title={t('chat.info.noMedia')} />;

  return (
    <View style={styles.pane}>
      {attachments.map((attachment) => (
        <TileSource key={attachment.id} attachment={attachment} onReady={onReady} />
      ))}
      <SharedMediaGrid
        items={attachments.map((attachment) => ({
          id: attachment.id,
          source: uris[attachment.id] ?? '',
          kind: attachment.media.kind === 'video' ? 'video' : 'image',
          duration: attachment.media.durationMs ? attachment.media.durationMs / 1000 : undefined,
        }))}
        columns={3}
        accessibilityLabel={t('chat.details.media')}
      />
    </View>
  );
}

/** The documents in the loaded history, newest first. */
export function SharedFiles({ items }: { items: readonly TimelineItemView[] }) {
  const { t } = useTranslation();
  const attachments = useMemo(() => attachmentsOf(items, ['file']), [items]);
  if (attachments.length === 0) return <ChatEmptyState title={t('chat.info.noFiles')} />;
  return (
    <View style={styles.pane}>
      <DocumentGrid
        items={attachments.map(({ id, media }) => ({
          id,
          name: media.filename,
          mimeType: media.mime,
          sizeBytes: media.size,
        }))}
        divider
        accessibilityLabel={t('chat.details.files')}
      />
    </View>
  );
}

/** The voice notes and audio files in the loaded history, newest first. */
export function SharedVoice({ items }: { items: readonly TimelineItemView[] }) {
  const { t } = useTranslation();
  const attachments = useMemo(() => attachmentsOf(items, ['voice', 'audio']), [items]);
  if (attachments.length === 0) return <ChatEmptyState title={t('chat.info.noVoice')} />;
  return (
    <View style={styles.pane}>
      <DocumentGrid
        items={attachments.map(({ id, media }) => ({
          id,
          name: media.kind === 'voice' ? t('chat.attachment.voice') : media.filename,
          kind: 'audio' as const,
          mimeType: media.mime,
          sizeBytes: media.size,
          metaLabel: media.durationMs ? `${Math.round(media.durationMs / 1000)}s` : undefined,
        }))}
        divider
        accessibilityLabel={t('chat.details.voice')}
      />
    </View>
  );
}

/** Every link somebody sent, newest first — found in the text the way a bubble finds it. */
export function SharedLinks({ items }: { items: readonly TimelineItemView[] }) {
  const { t } = useTranslation();
  const links = useMemo(() => {
    const found: { id: string; url: string }[] = [];
    for (let index = items.length - 1; index >= 0 && found.length < LIMIT; index -= 1) {
      const item = items[index];
      if (item.content.kind !== 'text') continue;
      for (const entity of messageEntities(item.content.body)) {
        if (entity.type === 'link') found.push({ id: `${item.id}:${entity.start}`, url: entity.text });
      }
    }
    return found;
  }, [items]);

  if (links.length === 0) return <ChatEmptyState title={t('chat.info.noLinks')} />;

  return (
    <View style={styles.pane}>
      {links.map((link) => (
        <Item key={link.id} title={link.url} onPress={() => void Linking.openURL(link.url)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pane: { paddingHorizontal: 16, paddingBottom: 16, gap: 8 },
});
