/**
 * What a file is, guessed from what it is called.
 *
 * The last resort, and the only one available in several places: a picker on
 * Android or in a browser often reports no MIME type, and an attachment that
 * arrived over Matrix carries its type inside an opaque media ref that nothing
 * outside `lib/matrix/` may open. The filename is what is left.
 *
 * **Deliberately short.** An extension that is not in here yields `undefined`,
 * and every caller has its own right answer for that: an upload sends
 * `application/octet-stream`, which every client treats as "a file"; a share
 * sheet passes nothing and lets the platform decide. Guessing wrong is worse
 * than not guessing — a receiver told `image/jpeg` about a QuickTime movie
 * draws a broken image instead of offering to open it.
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
  pdf: 'application/pdf',
  txt: 'text/plain',
  zip: 'application/zip',
};

/** The extension of a filename, lower-cased, or `''` when it has none. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  // `> 0`, not `>= 0`: a dotfile is all name and no extension.
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/** The MIME type for a filename, or `undefined` when its extension is unknown. */
export function mimetypeFromFilename(filename: string): string | undefined {
  return MIMETYPE_BY_EXTENSION[extensionOf(filename)];
}
