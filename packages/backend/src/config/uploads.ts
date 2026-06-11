import path from "path";

/**
 * Single source of truth for the local-disk upload fallback.
 *
 * Security model: uploaded files are opaque attachments. The backend never
 * serves them as active content — see the `/uploads` static handler in
 * server.ts (Content-Disposition: attachment, nosniff, sandboxed CSP) and the
 * multer fileFilter below (MIME allowlist + extension blocklist + extension
 * re-derived from the validated MIME, never the client filename).
 */

/** Absolute path to the on-disk uploads directory. */
export const UPLOAD_DIR = path.resolve(process.cwd(), "uploads");

/** Max accepted file size for the local-disk fallback (50 MB). */
export const UPLOAD_MAX_FILE_SIZE = 50 * 1024 * 1024;

/**
 * Allowed MIME types. Prefixes ending in "/" match any subtype (e.g. image/*);
 * exact strings match exactly. Anything else is rejected.
 *
 * `application/octet-stream` is allowed for END-TO-END-ENCRYPTED media blobs
 * (Fase 1D): the client encrypts a blob with ChaCha20-Poly1305 and uploads the
 * opaque ciphertext as octet-stream. It is stored with a `.bin` extension and
 * served (like every upload) with attachment + nosniff + sandbox headers, so it
 * can never execute in the app origin; the server never sees the key.
 */
const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/"] as const;
const ALLOWED_MIME_EXACT = new Set<string>([
  "application/pdf",
  "application/octet-stream",
]);

/**
 * MIME types that must be rejected even though they match an allowed prefix.
 * `image/svg+xml` is an image MIME but SVG is an active document that can carry
 * scripts, so it can never be trusted as a passive image.
 */
const DENIED_MIME_EXACT = new Set<string>([
  "image/svg+xml",
  "image/svg",
]);

/**
 * Extensions that must never be written to disk even if the MIME looks benign.
 * These can execute in the app origin if ever served inline.
 */
export const DANGEROUS_EXTENSIONS = new Set<string>([
  ".html",
  ".htm",
  ".svg",
  ".xhtml",
  ".xml",
  ".js",
  ".mjs",
  ".css",
]);

/**
 * Map a validated MIME type to a safe file extension. The stored extension is
 * derived from the (allowlisted) MIME, NOT the client-supplied filename, so a
 * malicious "image.svg" reported as image/png is stored as ".png".
 */
const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/3gpp": ".3gp",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/webm": ".weba",
  "application/pdf": ".pdf",
  // End-to-end-encrypted media ciphertext (opaque bytes).
  "application/octet-stream": ".bin",
};

/** True when the MIME type is in the allowlist (image/video/audio or pdf). */
export function isAllowedMime(mime: string | undefined): boolean {
  if (!mime) return false;
  const normalized = mime.toLowerCase().trim();
  if (DENIED_MIME_EXACT.has(normalized)) return false;
  if (ALLOWED_MIME_EXACT.has(normalized)) return true;
  return ALLOWED_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Resolve the safe stored extension for a validated upload. Prefers the
 * MIME→extension map; for an allowlisted image/video/audio MIME with no explicit
 * mapping, falls back to the MIME subtype (e.g. image/x-foo → ".x-foo"). Never
 * trusts the client filename. Returns "" if nothing safe can be derived.
 */
export function safeExtensionForMime(mime: string | undefined): string {
  if (!mime) return "";
  const normalized = mime.toLowerCase().trim();
  const mapped = MIME_TO_EXTENSION[normalized];
  if (mapped) return mapped;
  if (!isAllowedMime(normalized)) return "";
  const subtype = normalized.split("/")[1];
  if (!subtype) return "";
  const candidate = `.${subtype.replace(/[^a-z0-9.-]/g, "")}`;
  return DANGEROUS_EXTENSIONS.has(candidate) ? "" : candidate;
}

/**
 * Build a unique, safe on-disk filename. The base name is sanitized and any
 * client extension is stripped; the stored extension comes from the validated
 * MIME so dangerous extensions can never be persisted.
 */
export function buildSafeStoredFilename(originalName: string, mime: string | undefined): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const base = path
    .basename(originalName || "file", path.extname(originalName || ""))
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 100);
  const ext = safeExtensionForMime(mime);
  const safeBase = base.length > 0 ? base : "file";
  return `${unique}-${safeBase}${ext}`;
}
