import * as DocumentPicker from 'expo-document-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { createVideoPlayer } from 'expo-video';

import type { AlloOutgoingAttachment, AlloOutgoingThumbnail } from '@/lib/matrix/types';
import { logger } from '@/utils/logger';
import { mimetypeFromFilename } from '@/utils/mimetypes';

/**
 * Choosing something to send, and describing it well enough that the person
 * receiving it does not have to download it to find out what it is.
 *
 * Everything here is platform-neutral on purpose: the port takes a URI, and a
 * URI is what `expo-image-picker` hands over on all three platforms — a
 * `file://` path on a phone, a `blob:` URL in a browser. Neither this module nor
 * `ConversationView` has to know which one it is on.
 *
 * **This is not `utils/mediaVariant.ts`.** That resolves rendition variants for
 * Oxy Cloud, which is where avatars come from. An attachment sent through here
 * goes to the homeserver's own media repository and never touches Oxy.
 */

/**
 * How wide a thumbnail is made.
 *
 * A bubble draws media 250pt across, so 1024 covers it at 3× and costs perhaps
 * 80 KB. Smaller would show visibly soft photographs on a modern phone; larger
 * stops being a thumbnail. It is also what the full-screen viewer shows while
 * the original downloads, which is the other reason not to go below it.
 */
const THUMBNAIL_WIDTH = 1024;

/**
 * How hard the thumbnail is compressed.
 *
 * It is never the picture the user sent — the original is uploaded alongside it
 * — so artefacts here cost a little quality in the timeline and nothing at all
 * in what was actually delivered.
 */
const THUMBNAIL_QUALITY = 0.7;

/** What a picker call answered. `undefined` for a user who backed out. */
export type PickedAttachments = readonly AlloOutgoingAttachment[];

/**
 * Opens the photo library and describes what came back.
 *
 * An empty array means the user cancelled or denied access, which are the same
 * thing to the caller: nothing to send, and nothing to apologise for.
 */
export async function pickMediaAttachments(): Promise<PickedAttachments> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return [];
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    // The original bytes. Re-encoding here would cost quality twice — once for
    // the copy that is sent and again for the thumbnail made from it — and the
    // thumbnail is what the timeline actually draws.
    quality: 1,
    exif: false,
  });
  if (result.canceled) {
    return [];
  }
  return describeAll(result.assets);
}

/**
 * Opens the document picker and describes what came back.
 *
 * `copyToCacheDirectory` is left on, and it is not an optimisation: on Android a
 * picked document arrives as a `content://` URI owned by whichever app provided
 * it, and that URI is not a path the Matrix SDK — which reads files through
 * Rust, on another thread, some time later — can open. The copy the picker makes
 * is in Allo's own cache directory and is a file both halves of the port can
 * read.
 *
 * A document has no thumbnail. An `m.file` may carry one and Allo makes none:
 * rendering the first page of a PDF is a document engine, and the row draws an
 * icon and a filename either way.
 */
export async function pickDocumentAttachments(): Promise<PickedAttachments> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) {
    return [];
  }
  return result.assets.map(describeDocument);
}

function describeDocument(asset: DocumentPicker.DocumentPickerAsset): AlloOutgoingAttachment {
  const filename = asset.name !== '' ? asset.name : fallbackFilename(asset.uri, false, 'document');
  return {
    kind: 'file',
    filename,
    mimetype: asset.mimeType ?? mimetypeFromFilename(filename) ?? UNKNOWN_MIMETYPE,
    uri: asset.uri,
    size: asset.size,
  };
}

/** Opens the camera and describes the photograph or video it produced. */
export async function captureMediaAttachment(): Promise<PickedAttachments> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    return [];
  }
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images', 'videos'],
    quality: 1,
    exif: false,
  });
  if (result.canceled) {
    return [];
  }
  return describeAll(result.assets);
}

async function describeAll(
  assets: readonly ImagePicker.ImagePickerAsset[],
): Promise<PickedAttachments> {
  // Sequential rather than `Promise.all`: each one renders a thumbnail through
  // a native image pipeline, and a dozen photographs started at once is how a
  // mid-range phone runs out of memory choosing an album.
  const described: AlloOutgoingAttachment[] = [];
  for (const asset of assets) {
    described.push(await describe(asset));
  }
  return described;
}

async function describe(
  asset: ImagePicker.ImagePickerAsset,
): Promise<AlloOutgoingAttachment> {
  const isVideo = asset.type === 'video';
  const filename = asset.fileName ?? fallbackFilename(asset.uri, isVideo);
  return {
    kind: isVideo ? 'video' : 'image',
    filename,
    mimetype: asset.mimeType ?? mimetypeFromName(filename, isVideo),
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    size: asset.fileSize,
    // `duration` is milliseconds on an `ImagePickerAsset`, and `null` for a
    // still. The port's field is milliseconds too, so nothing is converted.
    durationMs: asset.duration ?? undefined,
    thumbnail: isVideo ? await renderVideoThumbnail(asset) : await renderThumbnail(asset),
  };
}

/**
 * A small copy of a picture, or `undefined` when one could not be made.
 *
 * A failure here is not a failure to send. The attachment goes anyway; what is
 * lost is that receivers download the whole picture to draw the row.
 */
async function renderThumbnail(
  asset: ImagePicker.ImagePickerAsset,
): Promise<AlloOutgoingThumbnail | undefined> {
  if (asset.width > 0 && asset.width <= THUMBNAIL_WIDTH) {
    // Already small enough to be its own thumbnail. Uploading a second copy of
    // the same picture would double what the sender pays to send it.
    return undefined;
  }
  return saveThumbnail(asset.uri, 'a picture');
}

/**
 * The first frame of a video, as a thumbnail — and `undefined` where that is
 * not possible.
 *
 * **No new dependency.** `expo-image-manipulator` reads images and not frames,
 * which is why videos used to go without one; `expo-video` — already a
 * dependency, already a config plugin in `app.config.js`, and already the thing
 * that plays them back — will decode a frame out of a file on iOS and Android
 * through `generateThumbnailsAsync`, and its result is a `SharedRef<'image'>`,
 * which is exactly what `ImageManipulator.manipulate` takes. So one decode and
 * the resize that already existed produce the JPEG the port wants, with no
 * native module Allo did not already ship.
 *
 * **Web still goes without.** `generateThumbnailsAsync` throws there — the
 * browser player has no frame extraction — and doing it by hand means a hidden
 * `<video>`, a `<canvas>` and a seek that resolves differently in every browser.
 * The failure lands in the `catch` below and the video is sent with no
 * thumbnail, which is what happened on every platform before this.
 *
 * `SEEK_TO_FIRST_FRAME` is zero seconds: some encoders put a black or fade-in
 * frame at exactly 0, but seeking further in costs a decode of everything up to
 * it and picks a frame the person who shot it did not choose either.
 */
async function renderVideoThumbnail(
  asset: ImagePicker.ImagePickerAsset,
): Promise<AlloOutgoingThumbnail | undefined> {
  const player = createVideoPlayer(asset.uri);
  try {
    const [frame] = await player.generateThumbnailsAsync(SEEK_TO_FIRST_FRAME, {
      maxWidth: THUMBNAIL_WIDTH,
    });
    if (frame === undefined) {
      return undefined;
    }
    return await saveThumbnail(frame, 'a video frame');
  } catch (error) {
    logger.warn('[chat] a video thumbnail could not be taken; sending without one', error);
    return undefined;
  } finally {
    // A player holds a decoder and, on Android, a surface. One left behind for
    // every video ever sent is a leak the user experiences as the app slowing
    // down after a while of sending holiday clips.
    player.release();
  }
}

const SEEK_TO_FIRST_FRAME = 0;

/**
 * Resizes and writes a thumbnail, from either a file or a decoded frame.
 *
 * `ImageManipulator.manipulate` takes a URI **or** a native image reference,
 * which is what lets one function serve a photograph from the library and a
 * frame `expo-video` just decoded.
 */
async function saveThumbnail(
  source: Parameters<typeof ImageManipulator.manipulate>[0],
  description: string,
): Promise<AlloOutgoingThumbnail | undefined> {
  try {
    const rendered = await ImageManipulator.manipulate(source)
      .resize({ width: THUMBNAIL_WIDTH })
      .renderAsync();
    const saved = await rendered.saveAsync({
      format: SaveFormat.JPEG,
      compress: THUMBNAIL_QUALITY,
    });
    return {
      uri: saved.uri,
      mimetype: 'image/jpeg',
      width: saved.width,
      height: saved.height,
    };
  } catch (error) {
    logger.warn(
      `[chat] a thumbnail could not be rendered from ${description}; sending without one`,
      error,
    );
    return undefined;
  }
}

/**
 * A recording from the composer's microphone, as an attachment.
 *
 * `durationSeconds` is what `MicSendButton` reports; the port speaks
 * milliseconds, which is also what Matrix's `info.duration` is. Getting that
 * conversion wrong would put "0:00" under every voice message in every client.
 */
export function toVoiceAttachment(
  uri: string,
  durationSeconds: number,
): AlloOutgoingAttachment {
  const filename = fallbackFilename(uri, false, 'voice');
  return {
    kind: 'voice',
    filename,
    mimetype: mimetypeFromName(filename, false),
    uri,
    durationMs: Math.round(durationSeconds * 1000),
  };
}

/**
 * A name for a file the picker did not name.
 *
 * Android's document picker and every browser leave `fileName` empty often
 * enough that this is the normal path, not the exceptional one. The extension is
 * taken from the URI so the MIME type can be guessed from it afterwards.
 */
function fallbackFilename(uri: string, isVideo: boolean, prefix = 'attachment'): string {
  const withoutQuery = uri.split(/[?#]/)[0];
  const lastSegment = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  const dot = lastSegment.lastIndexOf('.');
  const extension =
    dot > 0 ? lastSegment.slice(dot + 1).toLowerCase() : isVideo ? 'mp4' : 'jpg';
  return `${prefix}-${Date.now().toString(36)}.${extension}`;
}

/**
 * What Matrix calls bytes nobody could name.
 *
 * Every client treats it as "a file" and offers a download, which is the honest
 * outcome. Guessing is worse: a receiver told `image/jpeg` about a QuickTime
 * movie draws a broken image instead.
 */
const UNKNOWN_MIMETYPE = 'application/octet-stream';

/**
 * A MIME type for a picker that did not report one.
 *
 * The table lives in `utils/mimetypes.ts` because the viewer's share sheet needs
 * the same answers from the same filenames, and two tables would drift.
 */
function mimetypeFromName(filename: string, isVideo: boolean): string {
  return mimetypeFromFilename(filename) ?? (isVideo ? 'video/mp4' : UNKNOWN_MIMETYPE);
}
