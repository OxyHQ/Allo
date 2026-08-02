import React, { memo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useTranslation } from 'react-i18next';

export interface AttachmentViewerVideoProps {
  /** The decrypted file, or `''` while it is still being fetched. */
  readonly uri: string;
  /** The sender's thumbnail, or `''`. Drawn while there is no video yet. */
  readonly previewUri: string;
  /** Whether this is the page on screen. */
  readonly isActive: boolean;
}

/**
 * A video, in the viewer.
 *
 * **Only the page on screen has a player.** Nothing here pauses playback when a
 * swipe moves on, and nothing needs to: the neighbouring pages render a still,
 * so turning the page unmounts this component and `useVideoPlayer` releases the
 * player with it. An Effect watching `isActive` to call `pause()` would be a
 * second mechanism for the same fact, and the one that leaks when it is wrong.
 *
 * Native controls rather than Allo's own. A video player is scrubbing, volume,
 * captions, fullscreen, AirPlay and picture-in-picture, all of it different on
 * each platform and all of it already built into the one the platform ships.
 *
 * Its own file, and not a branch inside `ViewerPage`, because `useVideoPlayer`
 * is a hook: a component that sometimes has a player and sometimes does not
 * cannot call it conditionally.
 */
export const AttachmentViewerVideo = memo<AttachmentViewerVideoProps>(
  ({ uri, previewUri, isActive }) => {
    const { t } = useTranslation();
    // `null` and not `''` for a video that has not arrived: an empty string is a
    // source the player tries and fails to open, and it reports that failure as
    // an error on a video that is merely still downloading.
    const player = useVideoPlayer(isActive && uri !== '' ? uri : null);

    if (!isActive || uri === '') {
      return (
        <View style={styles.container}>
          {previewUri !== '' && (
            <Image
              source={{ uri: previewUri }}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              accessibilityLabel={t('Video thumbnail')}
            />
          )}
          {isActive && <ActivityIndicator color={SPINNER_COLOR} />}
        </View>
      );
    }

    return (
      <VideoView
        player={player}
        style={styles.container}
        contentFit="contain"
        nativeControls
        allowsPictureInPicture={false}
      />
    );
  },
);

AttachmentViewerVideo.displayName = 'AttachmentViewerVideo';

/** See the note on `CHROME_FOREGROUND` in `AttachmentViewer.tsx`. */
const SPINNER_COLOR = '#FFFFFF';

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
