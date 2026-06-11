/**
 * Klipy GIF API client (F2.6).
 *
 * Thin, dependency-free wrapper over the Klipy REST API for GIF trending +
 * search. The app key is interpolated into the request path
 * (`/api/v1/{app_key}/gifs/...`) per Klipy's contract.
 *
 * Responses are narrowed defensively: Klipy nests each item's renditions under
 * `file.{hd,md,sm}.gif`, but field availability varies per asset, so this module
 * walks the response with explicit type guards and silently drops items that
 * lack a usable GIF url rather than trusting a fixed shape. Callers receive a
 * flat, typed `KlipyGif[]` plus the next page cursor for infinite scrolling.
 */

import { KLIPY_API_URL, KLIPY_APP_KEY, KLIPY_PAGE_SIZE } from '@/config';

/** A single GIF result reduced to what the picker grid and send path need. */
export interface KlipyGif {
  /** Stable Klipy asset id (used as the local React key). */
  id: string;
  /** Direct URL to the full-quality animated GIF (used for download + send). */
  url: string;
  /** URL to a smaller preview rendition for the grid (falls back to `url`). */
  previewUrl: string;
  /** Intrinsic width in pixels, when reported. */
  width?: number;
  /** Intrinsic height in pixels, when reported. */
  height?: number;
  /** Optional human title (used for accessibility labels). */
  title?: string;
}

/** A page of GIF results plus the cursor for the next page (null when exhausted). */
export interface KlipyGifPage {
  gifs: KlipyGif[];
  nextPage: number | null;
}

/** True when a usable Klipy app key is configured. */
export function isKlipyConfigured(): boolean {
  return KLIPY_APP_KEY.length > 0;
}

/** A single rendition's `{ url, width, height }` once narrowed from unknown JSON. */
interface KlipyRendition {
  url: string;
  width?: number;
  height?: number;
}

/** Narrow an unknown value to a `{ gif: { url, ... } }` rendition url + dims. */
function extractRendition(value: unknown): KlipyRendition | null {
  if (!value || typeof value !== 'object') return null;
  const gif = (value as Record<string, unknown>).gif;
  if (!gif || typeof gif !== 'object') return null;
  const g = gif as Record<string, unknown>;
  if (typeof g.url !== 'string' || g.url.length === 0) return null;
  const rendition: KlipyRendition = { url: g.url };
  if (typeof g.width === 'number') rendition.width = g.width;
  if (typeof g.height === 'number') rendition.height = g.height;
  return rendition;
}

/** Narrow a single Klipy item to a `KlipyGif`, or null when it has no usable url. */
function extractGif(value: unknown): KlipyGif | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const file = item.file;
  if (!file || typeof file !== 'object') return null;
  const f = file as Record<string, unknown>;

  // Prefer the highest quality for the actual send; smallest for the preview.
  const full = extractRendition(f.hd) || extractRendition(f.md) || extractRendition(f.sm);
  const preview = extractRendition(f.sm) || extractRendition(f.md) || full;
  if (!full) return null;

  const id =
    typeof item.id === 'string'
      ? item.id
      : typeof item.id === 'number'
        ? String(item.id)
        : full.url;

  const gif: KlipyGif = {
    id,
    url: full.url,
    previewUrl: preview?.url || full.url,
  };
  if (full.width !== undefined) gif.width = full.width;
  if (full.height !== undefined) gif.height = full.height;
  if (typeof item.title === 'string' && item.title.length > 0) gif.title = item.title;
  return gif;
}

/** Walk an unknown Klipy response to the `{ data: [...], has_next }` envelope. */
function extractPage(payload: unknown, requestedPage: number): KlipyGifPage {
  const root = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  // Klipy wraps the list in `data.data`; tolerate a flat `data` array too.
  const container = (root.data && typeof root.data === 'object' ? root.data : root) as Record<
    string,
    unknown
  >;
  const list = Array.isArray(container.data)
    ? container.data
    : Array.isArray(root.data)
      ? (root.data as unknown[])
      : [];

  const gifs = list.map(extractGif).filter((g): g is KlipyGif => g !== null);
  const hasNext = container.has_next === true && gifs.length > 0;
  return { gifs, nextPage: hasNext ? requestedPage + 1 : null };
}

/** Build a fully-qualified Klipy endpoint URL with the app key in the path. */
function endpoint(path: string): string {
  const base = KLIPY_API_URL.replace(/\/$/, '');
  return `${base}/${KLIPY_APP_KEY}/gifs/${path}`;
}

/** GET + JSON-parse a Klipy endpoint, surfacing non-2xx as a thrown error. */
async function fetchKlipy(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Klipy request failed (${response.status})`);
  }
  return response.json();
}

/**
 * Fetch one page of trending GIFs. `page` is 1-based (Klipy's convention).
 */
export async function fetchTrendingGifs(
  page: number,
  signal?: AbortSignal
): Promise<KlipyGifPage> {
  if (!isKlipyConfigured()) return { gifs: [], nextPage: null };
  const url = `${endpoint('trending')}?page=${page}&per_page=${KLIPY_PAGE_SIZE}`;
  const payload = await fetchKlipy(url, signal);
  return extractPage(payload, page);
}

/**
 * Fetch one page of GIF search results for `query`. `page` is 1-based.
 */
export async function searchGifs(
  query: string,
  page: number,
  signal?: AbortSignal
): Promise<KlipyGifPage> {
  if (!isKlipyConfigured()) return { gifs: [], nextPage: null };
  const url = `${endpoint('search')}?q=${encodeURIComponent(query)}&page=${page}&per_page=${KLIPY_PAGE_SIZE}`;
  const payload = await fetchKlipy(url, signal);
  return extractPage(payload, page);
}
