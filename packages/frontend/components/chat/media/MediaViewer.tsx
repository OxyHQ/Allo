import React, { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useVideoPlayer } from 'expo-video';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import {
  ZoomableMediaGallery,
  type ZoomableMediaGalleryHandle,
} from '@oxy.so/bloom/zoomable-media-gallery';

import { useMediaUri } from '@/lib/allo/useMediaUri';
import type { ViewerItem } from '@/lib/chat/attachmentViewer';

export interface MediaViewerHandle {
  open: (item: ViewerItem) => void;
}

/**
 * Full-screen pictures and videos, on Bloom's gallery.
 *
 * The gallery wants a URI when it opens, and an original only exists once it
 * has been downloaded and decrypted — so a tap first fetches the original (a
 * spinner over the screen meanwhile), then opens the gallery on it. The last
 * opened item stays mounted: it owns the decrypted file and, for a video, the
 * player the gallery is showing.
 */
export function MediaViewer({ ref }: { ref: Ref<MediaViewerHandle> }) {
  const gallery = useRef<ZoomableMediaGalleryHandle>(null);
  // The nonce makes every press a new mount: the same picture reopens, which a
  // key of the message id alone would not (React would reuse the open guard).
  const [request, setRequest] = useState<{ item: ViewerItem; nonce: number } | null>(null);
  useImperativeHandle(
    ref,
    () => ({ open: (item: ViewerItem) => setRequest((current) => ({ item, nonce: (current?.nonce ?? 0) + 1 })) }),
    [],
  );

  return (
    <>
      <ZoomableMediaGallery ref={gallery} videoControls />
      {request && <OpenItem key={`${request.item.key}:${request.nonce}`} item={request.item} gallery={gallery} />}
    </>
  );
}

function OpenItem({ item, gallery }: { item: ViewerItem; gallery: RefObject<ZoomableMediaGalleryHandle | null> }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { uri, error } = useMediaUri(item.ref, item.mime);
  const player = useVideoPlayer(item.kind === 'video' && uri ? uri : null);
  const opened = useRef(false);

  useEffect(() => {
    if (!uri || opened.current) return;
    opened.current = true;
    gallery.current?.open(item.kind === 'video' ? [{ kind: 'video', id: item.key, player }] : [{ uri }], 0);
  }, [uri, item, player, gallery]);

  useEffect(() => {
    if (error) toast.error(t('media.downloadFailed'));
  }, [error, t]);

  if (uri || error) return null;
  return (
    <View style={[StyleSheet.absoluteFill, styles.loading, { backgroundColor: theme.colors.overlay }]}>
      <ActivityIndicator color={theme.colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', justifyContent: 'center' },
});
