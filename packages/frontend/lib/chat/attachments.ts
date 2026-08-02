import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { AlloOutgoingAttachment, AlloOutgoingThumbnail } from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

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
 * A bubble draws media 250pt across, so 1024 covers it at 3× with room for the
 * viewer that does not exist yet, and costs perhaps 80 KB. Smaller would show
 * visibly soft photographs on a modern phone; larger stops being a thumbnail.
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
    thumbnail: isVideo ? undefined : await renderThumbnail(asset),
  };
}

/**
 * A small copy of a picture, or `undefined` when one could not be made.
 *
 * **Only for stills.** A video's first frame needs a decoder Allo does not have
 * — `expo-image-manipulator` reads images — so a video goes without, and the
 * timeline draws the placeholder the carousel already has for one. A video from
 * another client usually arrives with a thumbnail its sender made, and that one
 * is drawn.
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
  try {
    const rendered = await ImageManipulator.manipulate(asset.uri)
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
    logger.warn('[chat] a thumbnail could not be rendered; sending without one', error);
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
 * MIME types by extension, for the pickers that do not report one.
 *
 * Deliberately short. A type that is not in here is sent as
 * `application/octet-stream`, which every client handles as "a file"; guessing
 * wrong is worse, because a receiver that trusts `image/jpeg` and finds a
 * QuickTime movie draws a broken image instead of offering a download.
 */
const MIMETYPE_BY_EXTENSION: Readonly<Partial<Record<string, string>>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

function mimetypeFromName(filename: string, isVideo: boolean): string {
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  return (
    MIMETYPE_BY_EXTENSION[extension] ??
    (isVideo ? 'video/mp4' : 'application/octet-stream')
  );
}
