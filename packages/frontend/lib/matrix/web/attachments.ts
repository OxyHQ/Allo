import type { IContent } from 'matrix-js-sdk';
// Not exported from the root of `matrix-js-sdk@42`, only from this path inside
// the package — the same deep import `client.web.ts` already documents for
// `deriveRecoveryKeyFromPassphrase`, and a safer one: these are `import type`,
// so nothing is pulled into the runtime and a path that moves is a compile
// error rather than a silent break. Describing an `m.image` by hand instead
// would be a second, drifting copy of the spec's own shapes.
import type { EncryptedFile, VideoContent, VideoInfo } from 'matrix-js-sdk/lib/types.js';

import {
  MatrixMediaEncryptionUnknownError,
  MatrixMediaUnreadableError,
} from '@/lib/matrix/errors';
import type {
  AlloEncryptionState,
  AlloMediaContent,
  AlloMediaKind,
  AlloMediaRef,
  AlloOutgoingAttachment,
} from '@/lib/matrix/types';

/**
 * Attachments, on the web half — where encrypting them is Allo's own job.
 *
 * This is the asymmetry that decides the shape of this file. On iOS and Android
 * one call does everything: `Timeline.sendImage` reads the room's encryption
 * state inside Rust, encrypts the bytes if it is set, uploads them and sends the
 * event, and there is no argument to get wrong. `matrix-js-sdk` offers no such
 * call. `uploadContent()` uploads whatever it is handed, to a public URL, and
 * `sendMessage()` will happily put an `m.image` with a plaintext `url` into an
 * encrypted room. Nothing warns, the event body is still encrypted, the bubble
 * looks identical — and the picture is readable by anyone with the mxc URI.
 *
 * So the decision is made in one place, {@link resolveAttachmentSource}, and it
 * is made from the room's own state:
 *
 * - `encrypted` — encrypt, then upload the ciphertext, and send a `file`.
 * - `unencrypted` — upload as-is and send a `url`.
 * - `unknown` — **refuse**. See {@link MatrixMediaEncryptionUnknownError}: it is
 *   the ordinary state of a room sync has not delivered yet, and the plaintext
 *   guess is the one whose damage the user cannot see.
 *
 * Everything here is a pure function of its arguments and its injected
 * collaborators, which is what lets `__tests__/matrix/web/attachments.test.ts`
 * assert on the exact bytes that would reach a homeserver.
 */

/**
 * The MSC3245 marker that makes an `m.audio` a voice message.
 *
 * An empty object is the whole content the MSC defines; its presence is the
 * signal. Sent without the companion waveform (`org.matrix.msc3246.audio`)
 * because Allo's recorder samples no amplitudes, and a fabricated waveform is a
 * drawing of audio nobody measured.
 */
const VOICE_MARKER = 'org.matrix.msc3245.voice';

/** What Allo adds to the spec's media content. */
interface VoiceMarker {
  /** See {@link VOICE_MARKER}. Spelled out because a type cannot have a computed key. */
  'org.matrix.msc3245.voice'?: Record<string, never>;
}

/**
 * An attachment's event content, short of its `msgtype`.
 *
 * `VideoContent` is the widest of the spec's four media contents — its `info`
 * carries dimensions, duration, size and both spellings of a thumbnail — so one
 * shape covers a picture, a video, a recording and a document. The `msgtype` is
 * added by the caller, which is what turns it into one of the four; it is left
 * out here because it is the SDK's enum, and importing an enum is importing a
 * value.
 */
export type AttachmentContent = Omit<VideoContent, 'msgtype'> & VoiceMarker;

/** How an event points at bytes: one or the other, never both. */
export type AttachmentSource =
  | { readonly url: string }
  | { readonly file: EncryptedFile };

/** Bytes on their way out, already read off whatever URI held them. */
export interface AttachmentBytes {
  readonly bytes: Uint8Array;
  readonly mimetype: string;
  readonly filename: string;
}

/** Uploads bytes to the media repository and answers with the mxc URI. */
export type UploadBytes = (payload: AttachmentBytes) => Promise<string>;

/**
 * Encrypts bytes and answers with the ciphertext and the key material.
 *
 * `info` is the crypto machine's JSON: `{ v, key, iv, hashes }`, which is an
 * `EncryptedFile` short of its `url`.
 */
export type EncryptBytes = (plaintext: Uint8Array) => {
  readonly ciphertext: Uint8Array;
  readonly info: string;
};

export interface AttachmentUploadDeps {
  readonly upload: UploadBytes;
  readonly encrypt: EncryptBytes;
}

/**
 * Uploads an attachment's bytes and answers with how the event should point at
 * them.
 *
 * **The only place in the web half that hands bytes to the media repository.**
 * Whether they are encrypted is decided here, from `encryption` and nothing
 * else — no argument, no default, no caller's opinion.
 *
 * `roomId` is carried for the error message alone: a refusal that does not name
 * the conversation sends the reader looking through all of them.
 */
export async function resolveAttachmentSource(
  payload: AttachmentBytes,
  encryption: AlloEncryptionState,
  roomId: string,
  deps: AttachmentUploadDeps,
): Promise<AttachmentSource> {
  switch (encryption) {
    case 'unknown':
      throw new MatrixMediaEncryptionUnknownError(roomId);

    case 'unencrypted': {
      const url = await deps.upload(payload);
      return { url };
    }

    case 'encrypted': {
      const { ciphertext, info } = deps.encrypt(payload.bytes);
      // The ciphertext is uploaded, and its MIME type is deliberately not the
      // picture's: what lands on the homeserver is a blob, and telling the
      // server it is a JPEG invites it to thumbnail, transcode or sniff
      // something that is not one.
      const url = await deps.upload({
        bytes: ciphertext,
        mimetype: 'application/octet-stream',
        filename: payload.filename,
      });
      return { file: { ...parseEncryptionInfo(info), url } };
    }
  }
}

/**
 * The key material, checked rather than trusted.
 *
 * It comes out of the crypto machine as a JSON string, so it arrives here as
 * `unknown`. A field missing from it would otherwise produce an `EncryptedFile`
 * nobody can open, and the failure would land on the **receiver** — days later,
 * on another device, with nothing to point at the sender.
 */
function parseEncryptionInfo(info: string): Omit<EncryptedFile, 'url'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(info);
  } catch {
    throw new MatrixMediaUnreadableError(
      'the encryption machine did not describe the key as JSON',
    );
  }
  const material = toKeyMaterial(parsed);
  if (material === undefined) {
    throw new MatrixMediaUnreadableError(
      'the key material is missing one of v, key, iv or hashes',
    );
  }
  return material;
}

export interface OutgoingThumbnailSource {
  readonly source: AttachmentSource;
  readonly mimetype: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The `m.room.message` content for an attachment whose bytes are already up.
 *
 * `body` is the caption when there is one and the filename otherwise, with
 * `filename` always set alongside. That is the spec's own arrangement: a client
 * that understands captions reads `filename` and shows `body` as prose, and one
 * that does not shows the filename it always showed.
 */
export function toAttachmentContent(
  attachment: AlloOutgoingAttachment,
  source: AttachmentSource,
  thumbnail: OutgoingThumbnailSource | undefined,
  size: number,
): AttachmentContent {
  const caption = attachment.caption?.trim();
  const hasCaption = caption !== undefined && caption !== '';

  const content: AttachmentContent = {
    body: hasCaption ? caption : attachment.filename,
    filename: attachment.filename,
    info: toAttachmentInfo(attachment, thumbnail, size),
    ...source,
  };
  if (attachment.kind === 'voice') {
    content[VOICE_MARKER] = {};
  }
  return content;
}

/**
 * What the event says about the bytes without opening them.
 *
 * Fields nothing measured are left out rather than set to `undefined`. A `"w"`
 * in an event is a claim about the picture's width and other clients lay out
 * against it; an absent key is the honest way to say nothing.
 */
function toAttachmentInfo(
  attachment: AlloOutgoingAttachment,
  thumbnail: OutgoingThumbnailSource | undefined,
  size: number,
): VideoInfo {
  const info: VideoInfo = { mimetype: attachment.mimetype, size };
  if (attachment.width !== undefined) {
    info.w = attachment.width;
  }
  if (attachment.height !== undefined) {
    info.h = attachment.height;
  }
  if (attachment.durationMs !== undefined) {
    info.duration = attachment.durationMs;
  }
  if (thumbnail !== undefined) {
    info.thumbnail_info = {
      mimetype: thumbnail.mimetype,
      w: thumbnail.width,
      h: thumbnail.height,
    };
    // A thumbnail lives under its own keys — and under the encrypted one when
    // the attachment is encrypted, because a thumbnail of a private photograph
    // gives it away just as well as the photograph.
    if ('url' in thumbnail.source) {
      info.thumbnail_url = thumbnail.source.url;
    } else {
      info.thumbnail_file = thumbnail.source.file;
    }
  }
  return info;
}

/* ---------------------------------------------------------------------------
 * Incoming
 * ------------------------------------------------------------------------- */

/** What the web half puts inside an {@link AlloMediaRef}. See the native one. */
interface WebMediaRef {
  readonly source: AttachmentSource;
  readonly mimetype: string;
}

const UNKNOWN_MIMETYPE = 'application/octet-stream';

export function encodeMediaRef(
  source: AttachmentSource,
  mimetype: string | undefined,
): AlloMediaRef {
  const ref: WebMediaRef = { source, mimetype: mimetype ?? UNKNOWN_MIMETYPE };
  return JSON.stringify(ref);
}

/**
 * Reads back what {@link encodeMediaRef} wrote.
 *
 * Validated for the same reason the native half validates its own: a ref lives
 * on in a React key and in a view model, so one written by an older build — or
 * by the other platform — reaches here eventually, and the useful failure says
 * so rather than dereferencing `undefined`.
 */
export function decodeMediaRef(ref: AlloMediaRef): WebMediaRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ref);
  } catch {
    throw new MatrixMediaUnreadableError('it is not a reference this browser wrote');
  }
  const record = asRecord(parsed);
  if (record === undefined || typeof record.mimetype !== 'string') {
    throw new MatrixMediaUnreadableError('the reference does not say what the bytes are');
  }
  const decoded = asRecord(record.source);
  const source = decoded === undefined ? undefined : toSource(decoded.url, decoded.file);
  if (source === undefined) {
    throw new MatrixMediaUnreadableError(
      'the reference names neither an unencrypted URL nor an encrypted file',
    );
  }
  return { source, mimetype: record.mimetype };
}

/**
 * The key material an encrypted source carries, in the shape the crypto machine
 * takes it back in — or `undefined` for a source that is not encrypted.
 */
export function encryptionInfoOf(source: AttachmentSource): string | undefined {
  if ('url' in source) {
    return undefined;
  }
  const { url: _url, ...info } = source.file;
  return JSON.stringify(info);
}

/** The mxc URI to fetch, whichever kind of source this is. */
export function mxcUriOf(source: AttachmentSource): string {
  return 'url' in source ? source.url : source.file.url;
}

/**
 * An attachment, from an `m.room.message` content, or `undefined` for a message
 * that is not one.
 *
 * `content` is whatever the homeserver sent — `matrix-js-sdk` types it with an
 * index signature of `any` — so every field is read through `unknown` and
 * checked. That is not ceremony: an event arrives from another user's client
 * over the network, and `info.w` being a string is enough to lay out a bubble
 * against nonsense.
 */
export function toMediaContent(content: IContent): AlloMediaContent | undefined {
  const kind = KIND_BY_MSGTYPE[asString(content.msgtype) ?? ''];
  if (kind === undefined) {
    return undefined;
  }
  const source = toSource(content.url, content.file);
  if (source === undefined) {
    return undefined;
  }

  const info = asRecord(content.info) ?? {};
  const filename = asString(content.filename) ?? asString(content.body) ?? 'attachment';
  // The spec's own rule for captions: a `filename` that differs from `body`
  // means `body` is prose. Equal, or absent, means `body` is the name.
  const body = asString(content.body);
  const caption =
    body !== undefined && body !== '' && body !== filename ? body : undefined;

  return {
    // A voice note and an audio file share a msgtype; only the marker tells
    // them apart, and the sender is the only one who can set it.
    kind: kind === 'audio' && content[VOICE_MARKER] !== undefined ? 'voice' : kind,
    filename,
    caption,
    source: encodeMediaRef(source, asString(info.mimetype)),
    thumbnail: toThumbnailRef(info),
    width: asCount(info.w),
    height: asCount(info.h),
    durationMs: asCount(info.duration),
    size: asCount(info.size),
  };
}

const KIND_BY_MSGTYPE: Readonly<Partial<Record<string, AlloMediaKind>>> = {
  'm.image': 'image',
  'm.video': 'video',
  'm.audio': 'audio',
  'm.file': 'file',
};

function toThumbnailRef(info: Record<string, unknown>): AlloMediaRef | undefined {
  const source = toSource(info.thumbnail_url, info.thumbnail_file);
  if (source === undefined) {
    return undefined;
  }
  const thumbnailInfo = asRecord(info.thumbnail_info) ?? {};
  return encodeMediaRef(source, asString(thumbnailInfo.mimetype));
}

/**
 * One source from an event's two spellings of it.
 *
 * `file` wins when both are present, which is the spec's instruction and the
 * safe reading besides: an event carrying both is one where the plaintext `url`
 * cannot be trusted to hold the same bytes.
 *
 * **An encrypted attachment whose key material is malformed yields nothing**,
 * rather than falling through to `url`. That fallback would be the silent
 * plaintext path this whole module exists to prevent — and there is no
 * plaintext at that URL to fall back to anyway.
 */
function toSource(url: unknown, file: unknown): AttachmentSource | undefined {
  const encrypted = asRecord(file);
  if (encrypted !== undefined) {
    const material = toKeyMaterial(encrypted);
    return material === undefined || typeof encrypted.url !== 'string'
      ? undefined
      : { file: { ...material, url: encrypted.url } };
  }
  return typeof url === 'string' ? { url } : undefined;
}

/**
 * The four fields that open an encrypted attachment, checked one by one.
 *
 * The JWK inside is checked field by field too. It is the key: a `k` that is
 * not a string, or `key_ops` that is not an array of them, produces an object
 * the crypto machine rejects deep inside WebAssembly with an error that names
 * none of this.
 */
function toKeyMaterial(value: unknown): Omit<EncryptedFile, 'url'> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const { v, iv, hashes } = record;
  const key = asRecord(record.key);
  if (
    typeof v !== 'string' ||
    typeof iv !== 'string' ||
    !isStringMap(hashes) ||
    key === undefined ||
    typeof key.alg !== 'string' ||
    typeof key.kty !== 'string' ||
    typeof key.k !== 'string' ||
    typeof key.ext !== 'boolean' ||
    !isStringArray(key.key_ops)
  ) {
    return undefined;
  }
  return {
    v,
    iv,
    hashes,
    key: { alg: key.alg, kty: key.kty, k: key.k, ext: key.ext, key_ops: key.key_ops },
  };
}

function isStringMap(value: unknown): value is Record<string, string> {
  const record = asRecord(value);
  return (
    record !== undefined && Object.values(record).every((entry) => typeof entry === 'string')
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...value }
    : undefined;
}

/** A positive whole number, or nothing. See the native half's `toCount`. */
function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}
