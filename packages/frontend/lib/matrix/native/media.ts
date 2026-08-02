import {
  MessageType_Tags,
  UploadSource,
} from '@unomed/react-native-matrix-sdk';
import type {
  AudioInfo,
  FileInfo,
  ImageInfo,
  MediaSourceLike,
  MessageType,
  ThumbnailInfo,
  UploadParameters,
  VideoInfo,
} from '@unomed/react-native-matrix-sdk';

import type {
  AlloMediaContent,
  AlloMediaRef,
  AlloOutgoingAttachment,
  AlloOutgoingThumbnail,
} from '@/lib/matrix/types';

/**
 * Attachments, on the native half.
 *
 * Two directions, and they are not symmetrical. **Outgoing** is thin on purpose:
 * `Timeline.sendImage` and its siblings do the whole job — read the file,
 * encrypt it if the room is encrypted, upload it, and send the event — so
 * everything here does is describe the file in the records the binding wants.
 * Encryption is therefore not this module's decision and cannot be got wrong
 * from here; the Rust SDK reads it from the room. **Incoming** is a translation
 * of the binding's message content into the port's, plus the encoding of the
 * opaque ref the UI carries around.
 *
 * Everything is a pure function of SDK records, so it is testable without a
 * device — which is the same rule `native/translate.ts` follows and the reason
 * the two are separate files rather than one.
 */

/**
 * What the native half puts inside an {@link AlloMediaRef}.
 *
 * A serialized `MediaSource` and nothing else would not be enough:
 * `Client.getMediaFile` needs a MIME type to name the file it writes, and the
 * MIME type lives on the message's `info`, which the ref has to travel without.
 */
interface NativeMediaRef {
  /** `MediaSource.toJson()`. Carries the mxc URI and, for encrypted media, the key. */
  readonly source: string;
  readonly mimetype: string;
  readonly filename: string;
}

/** The fallback when a sender's client did not say what the bytes are. */
const UNKNOWN_MIMETYPE = 'application/octet-stream';

export function encodeMediaRef(
  source: MediaSourceLike,
  mimetype: string | undefined,
  filename: string,
): AlloMediaRef {
  const ref: NativeMediaRef = {
    source: source.toJson(),
    mimetype: mimetype ?? UNKNOWN_MIMETYPE,
    filename,
  };
  return JSON.stringify(ref);
}

/**
 * Reads back what {@link encodeMediaRef} wrote.
 *
 * Validated rather than trusted even though this half wrote it: a ref survives
 * in a React key and in a view model, so a ref from an older build of Allo — or
 * one that crossed platforms — reaches here eventually, and the useful failure
 * is one that says so.
 */
export function decodeMediaRef(ref: AlloMediaRef): NativeMediaRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ref);
  } catch {
    throw new Error('This is not a media reference this device can read.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !hasString(parsed, 'source') ||
    !hasString(parsed, 'mimetype') ||
    !hasString(parsed, 'filename')
  ) {
    throw new Error('This media reference is missing the fields needed to fetch it.');
  }
  return { source: parsed.source, mimetype: parsed.mimetype, filename: parsed.filename };
}

function hasString<K extends string>(
  value: object,
  key: K,
): value is Record<K, string> {
  return key in value && typeof (value as Record<string, unknown>)[key] === 'string';
}

/**
 * An attachment, from the binding's message content, or `undefined` for a
 * message that is not one.
 *
 * `filename` comes from the binding's own computed field rather than from
 * `body`: the SDK already resolves the spec's two spellings — `filename` when
 * there is a caption, `body` when there is not — and reading `body` directly
 * would show the caption as the filename on every captioned attachment.
 */
export function toMediaContent(msgType: MessageType): AlloMediaContent | undefined {
  switch (msgType.tag) {
    case MessageType_Tags.Image: {
      const content = msgType.inner.content;
      const info: ImageInfo | undefined = content.info;
      return {
        kind: 'image',
        filename: content.filename,
        caption: content.caption,
        source: encodeMediaRef(content.source, info?.mimetype, content.filename),
        thumbnail: toThumbnailRef(info?.thumbnailSource, info?.thumbnailInfo, content.filename),
        width: toCount(info?.width),
        height: toCount(info?.height),
        durationMs: undefined,
        size: toCount(info?.size),
      };
    }

    case MessageType_Tags.Video: {
      const content = msgType.inner.content;
      const info: VideoInfo | undefined = content.info;
      return {
        kind: 'video',
        filename: content.filename,
        caption: content.caption,
        source: encodeMediaRef(content.source, info?.mimetype, content.filename),
        thumbnail: toThumbnailRef(info?.thumbnailSource, info?.thumbnailInfo, content.filename),
        width: toCount(info?.width),
        height: toCount(info?.height),
        durationMs: info?.duration,
        size: toCount(info?.size),
      };
    }

    case MessageType_Tags.Audio: {
      const content = msgType.inner.content;
      const info: AudioInfo | undefined = content.info;
      return {
        // `voice` is present only when the sender's client marked the recording
        // as a voice note (MSC3245). An ordinary audio file has the same
        // msgtype and is not one, and the two are drawn differently.
        kind: content.voice === undefined ? 'audio' : 'voice',
        filename: content.filename,
        caption: content.caption,
        source: encodeMediaRef(content.source, info?.mimetype, content.filename),
        thumbnail: undefined,
        width: undefined,
        height: undefined,
        durationMs: info?.duration,
        size: toCount(info?.size),
      };
    }

    case MessageType_Tags.File: {
      const content = msgType.inner.content;
      const info: FileInfo | undefined = content.info;
      return {
        kind: 'file',
        filename: content.filename,
        caption: content.caption,
        source: encodeMediaRef(content.source, info?.mimetype, content.filename),
        thumbnail: toThumbnailRef(info?.thumbnailSource, info?.thumbnailInfo, content.filename),
        width: undefined,
        height: undefined,
        durationMs: undefined,
        size: toCount(info?.size),
      };
    }

    default:
      return undefined;
  }
}

function toThumbnailRef(
  source: MediaSourceLike | undefined,
  info: ThumbnailInfo | undefined,
  filename: string,
): AlloMediaRef | undefined {
  return source === undefined
    ? undefined
    : encodeMediaRef(source, info?.mimetype, `thumb-${filename}`);
}

/**
 * A `u64` from the binding as a number.
 *
 * `undefined` for an absent value, and for zero: a picture zero pixels wide is
 * a field the sender's client filled in with a default, and passing it on would
 * have the UI lay out a bubble against it.
 */
function toCount(value: bigint | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const count = Number(value);
  return count > 0 ? count : undefined;
}

/**
 * The upload parameters for an outgoing attachment.
 *
 * `UploadSource.File` and not `UploadSource.Data`: it hands the SDK a path and
 * lets Rust stream the file, so a video never exists as an `ArrayBuffer` in the
 * JavaScript heap. The spike proved both variants work (`spikes/matrix-rn`,
 * C6); this is the one that does not put a phone's whole camera roll through
 * the bridge.
 */
export function toUploadParameters(attachment: AlloOutgoingAttachment): UploadParameters {
  return {
    source: new UploadSource.File({ filename: toFilesystemPath(attachment.uri) }),
    caption: attachment.caption,
  };
}

export function toThumbnailSource(
  thumbnail: AlloOutgoingThumbnail | undefined,
): UploadSource | undefined {
  return thumbnail === undefined
    ? undefined
    : new UploadSource.File({ filename: toFilesystemPath(thumbnail.uri) });
}

export function toThumbnailInfo(
  thumbnail: AlloOutgoingThumbnail | undefined,
): ThumbnailInfo | undefined {
  return thumbnail === undefined
    ? undefined
    : {
        width: BigInt(thumbnail.width),
        height: BigInt(thumbnail.height),
        mimetype: thumbnail.mimetype,
      };
}

/**
 * The path the Rust SDK wants, from the URI the platform's picker gave.
 *
 * The binding takes filesystem paths, and everything on a phone hands over
 * `file://` URIs. Passing one through unchanged fails inside Rust with an error
 * about a file that does not exist — naming a path that visibly does.
 */
export function toFilesystemPath(uri: string): string {
  if (!uri.startsWith('file://')) {
    return uri;
  }
  // Percent-decoded, not passed through: a picker returns a URI, and a photo
  // named `holiday #2.jpg` arrives as `holiday%20%232.jpg`. Rust would look for
  // a file with those characters in its name.
  return decodeURIComponent(uri.slice('file://'.length));
}
