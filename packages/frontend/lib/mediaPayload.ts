/**
 * Versioned message-body serialization for end-to-end-encrypted attachments
 * (Fase 1D + F2.6).
 *
 * The Signal fan-out (`encryptForConversation`) encrypts a single plaintext
 * STRING per recipient device. To carry attachment references end-to-end without
 * inventing new crypto or a new wire field, attachment messages serialize a small
 * versioned JSON object as that plaintext string. The object holds:
 *   - an optional caption,
 *   - zero or more `MediaRef`s (encrypted blob: media key, ciphertext URL, MIME,
 *     size — so the key only ever travels inside the E2E ciphertext and the
 *     server never sees it),
 *   - an optional structured `location` (coordinates + label/address), and
 *   - an optional structured `contact` (name + phones/emails).
 *
 * Location and contact payloads contain personal data, so for end-to-end
 * encrypted conversations they travel INSIDE this encrypted body rather than as
 * plaintext POST metadata (the backend never sees the coordinates / contact
 * details). The deviceless / bridged plaintext path keeps sending them as public
 * metadata, since there is no encryption to carry them.
 *
 * Backward compatibility: plain text messages stay plain strings. Detection is
 * structural — `parseMessageBody` attempts a JSON parse and only treats the
 * result as an attachment payload when it carries the exact `{__allo, v}` marker
 * AND at least one recognizable attachment field; anything else (including
 * legitimate user text that happens to be valid JSON) is returned verbatim as
 * plain text. Version 1 payloads (media-only) parse unchanged: the added
 * `location`/`contact` fields are optional.
 */

/** Magic marker distinguishing an attachment payload from user text that is valid JSON. */
const MEDIA_PAYLOAD_MARKER = 'allo.media';

/**
 * Current attachment-payload schema version.
 *  - v1: caption + mediaRefs only (Fase 1D).
 *  - v2: adds optional structured `location` / `contact` (F2.6).
 */
export const MEDIA_PAYLOAD_VERSION = 2;

/** Attachment kinds carried in an encrypted-media payload (mirrors MediaItem.type). */
export type MediaRefType = 'image' | 'video' | 'gif' | 'audio' | 'file';

/**
 * One encrypted-media attachment reference, embedded in the E2E message body.
 * The `key`/`mime`/`size` triple is the secret material needed to decrypt the
 * blob downloaded from `url`; it exists ONLY inside the encrypted body.
 */
export interface MediaRef {
  /** Stable media id (also the on-disk upload id / filename). */
  mediaId: string;
  /** Absolute or backend-relative URL of the uploaded CIPHERTEXT blob. */
  url: string;
  /** Base64 ChaCha20-Poly1305 key for this blob (secret — E2E only). */
  key: string;
  /** Plaintext MIME type bound into the blob's AEAD. */
  mime: string;
  /** Plaintext byte size bound into the blob's AEAD. */
  size: number;
  /** Display type for the renderer. */
  type: MediaRefType;
  /** Optional original file name (display only). */
  fileName?: string;
  /** Optional intrinsic width (images / video). */
  width?: number;
  /** Optional intrinsic height (images / video). */
  height?: number;
  /** Optional duration in seconds (audio / video). */
  duration?: number;
}

/**
 * A geographic location shared inside an encrypted attachment body. Mirrors the
 * store's `LocationData` (kept local to this leaf module to avoid importing the
 * store, which imports this file).
 */
export interface LocationPayload {
  latitude: number;
  longitude: number;
  /** Optional reverse-geocoded street address. */
  address?: string;
  /** Optional user-supplied label / place name. */
  label?: string;
}

/**
 * A shared contact card inside an encrypted attachment body. Mirrors the store's
 * `ContactData`.
 */
export interface ContactPayload {
  name: string;
  phones?: string[];
  emails?: string[];
  /** Optional Allo user id, if the contact is a known Allo user. */
  userId?: string;
}

/**
 * A decoded encrypted attachment message body: optional caption plus any
 * combination of media refs, a location, or a contact. At least one attachment
 * field is present (a caption-only message is sent as plain text, not a payload).
 */
export interface MediaMessageBody {
  /** Optional text caption shown alongside the attachment. */
  text?: string;
  /** Zero or more encrypted-media references. */
  mediaRefs: MediaRef[];
  /** Optional structured location (E2E for encrypted chats). */
  location?: LocationPayload;
  /** Optional structured contact card (E2E for encrypted chats). */
  contact?: ContactPayload;
}

/** On-the-wire shape of a serialized attachment payload (what gets E2E-encrypted). */
interface SerializedMediaPayload {
  /** Marker proving this is an Allo attachment payload and not user JSON text. */
  __allo: typeof MEDIA_PAYLOAD_MARKER;
  /** Schema version for forward/backward compatibility. */
  v: number;
  /** Optional caption. */
  text?: string;
  /** Encrypted-media references (always present, possibly empty). */
  mediaRefs: MediaRef[];
  /** Optional structured location. */
  location?: LocationPayload;
  /** Optional structured contact. */
  contact?: ContactPayload;
}

/**
 * Serialize an encrypted attachment message body into the plaintext STRING that
 * the Signal fan-out will encrypt per recipient device. Empty/absent optional
 * fields are omitted to keep the ciphertext compact.
 */
export function serializeMediaBody(body: MediaMessageBody): string {
  const payload: SerializedMediaPayload = {
    __allo: MEDIA_PAYLOAD_MARKER,
    v: MEDIA_PAYLOAD_VERSION,
    mediaRefs: body.mediaRefs,
    ...(body.text && body.text.length > 0 ? { text: body.text } : {}),
    ...(body.location ? { location: body.location } : {}),
    ...(body.contact ? { contact: body.contact } : {}),
  };
  return JSON.stringify(payload);
}

/** A parsed message body: either an attachment payload or plain text. */
export type ParsedMessageBody =
  | { kind: 'media'; body: MediaMessageBody }
  | { kind: 'text'; text: string };

/** Narrow an unknown value to a single MediaRef, dropping malformed entries. */
function asMediaRef(value: unknown): MediaRef | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.mediaId !== 'string' ||
    typeof v.url !== 'string' ||
    typeof v.key !== 'string' ||
    typeof v.mime !== 'string' ||
    typeof v.size !== 'number' ||
    typeof v.type !== 'string'
  ) {
    return null;
  }
  const type = v.type as MediaRefType;
  const ref: MediaRef = {
    mediaId: v.mediaId,
    url: v.url,
    key: v.key,
    mime: v.mime,
    size: v.size,
    type,
  };
  if (typeof v.fileName === 'string') ref.fileName = v.fileName;
  if (typeof v.width === 'number') ref.width = v.width;
  if (typeof v.height === 'number') ref.height = v.height;
  if (typeof v.duration === 'number') ref.duration = v.duration;
  return ref;
}

/** Narrow an unknown value to a LocationPayload (requires numeric coordinates). */
function asLocationPayload(value: unknown): LocationPayload | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.latitude !== 'number' || typeof v.longitude !== 'number') return null;
  if (!Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) return null;
  const location: LocationPayload = { latitude: v.latitude, longitude: v.longitude };
  if (typeof v.address === 'string') location.address = v.address;
  if (typeof v.label === 'string') location.label = v.label;
  return location;
}

/** Narrow an unknown value to a ContactPayload (requires a name). */
function asContactPayload(value: unknown): ContactPayload | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== 'string' || v.name.length === 0) return null;
  const contact: ContactPayload = { name: v.name };
  if (Array.isArray(v.phones)) {
    contact.phones = v.phones.filter((p): p is string => typeof p === 'string');
  }
  if (Array.isArray(v.emails)) {
    contact.emails = v.emails.filter((e): e is string => typeof e === 'string');
  }
  if (typeof v.userId === 'string') contact.userId = v.userId;
  return contact;
}

/**
 * Decode a decrypted message body. Tries to recognize an Allo attachment payload
 * by its exact structural marker; anything else is returned as plain text
 * verbatim (so legacy plain messages — and user text that merely looks like JSON
 * — are never misinterpreted).
 */
export function parseMessageBody(decrypted: string): ParsedMessageBody {
  // Fast path: a media payload is always a JSON object starting with '{'. Skip
  // the parse attempt for anything that obviously isn't one.
  const trimmed = decrypted.trimStart();
  if (!trimmed.startsWith('{')) {
    return { kind: 'text', text: decrypted };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch {
    // Not JSON → ordinary text that happens to begin with '{'.
    return { kind: 'text', text: decrypted };
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Record<string, unknown>).__allo !== MEDIA_PAYLOAD_MARKER
  ) {
    return { kind: 'text', text: decrypted };
  }

  const obj = parsed as Record<string, unknown>;
  const mediaRefs = Array.isArray(obj.mediaRefs)
    ? obj.mediaRefs.map(asMediaRef).filter((ref): ref is MediaRef => ref !== null)
    : [];
  const location = asLocationPayload(obj.location);
  const contact = asContactPayload(obj.contact);

  // A marked payload with no usable attachment of any kind degrades to its
  // caption (or empty text) rather than rendering a broken bubble.
  if (mediaRefs.length === 0 && !location && !contact) {
    const text = typeof obj.text === 'string' ? obj.text : '';
    return { kind: 'text', text };
  }

  const body: MediaMessageBody = { mediaRefs };
  if (typeof obj.text === 'string' && obj.text.length > 0) body.text = obj.text;
  if (location) body.location = location;
  if (contact) body.contact = contact;
  return { kind: 'media', body };
}

/** A renderable media item reconstructed from a decrypted MediaRef. */
export interface DecryptedMediaItem {
  id: string;
  type: MediaRefType;
  url: string;
  encrypted: true;
  encryptionKey: string;
  mimeType: string;
  fileSize: number;
  fileName?: string;
  width?: number;
  height?: number;
  duration?: number;
}

/**
 * Convert the key-bearing media refs recovered from a decrypted message body into
 * renderable media items. The key stays attached so the display layer can fetch
 * the ciphertext and decrypt it locally; it is never sent back to the server.
 */
export function mediaRefsToItems(refs: MediaRef[]): DecryptedMediaItem[] {
  return refs.map((ref) => {
    const item: DecryptedMediaItem = {
      id: ref.mediaId,
      type: ref.type,
      url: ref.url,
      encrypted: true,
      encryptionKey: ref.key,
      mimeType: ref.mime,
      fileSize: ref.size,
    };
    if (ref.fileName) item.fileName = ref.fileName;
    if (ref.width !== undefined) item.width = ref.width;
    if (ref.height !== undefined) item.height = ref.height;
    if (ref.duration !== undefined) item.duration = ref.duration;
    return item;
  });
}
