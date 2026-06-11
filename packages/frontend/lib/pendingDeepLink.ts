/**
 * Pending deep-link continuation.
 *
 * When an unauthenticated user opens a deep link (e.g. a shared conversation),
 * we want to send them to the welcome screen, and then — once they sign in —
 * forward them to where they were originally headed instead of the chat list.
 *
 * Two-slot design:
 * - `capturedDeepLink` holds the cold-start path, captured eagerly (web: at
 *   module load before Expo Router rewrites the URL; native: via
 *   `captureInitialDeepLink()`). This is captured UNCONDITIONALLY because the
 *   information is only available at startup, before we know the auth outcome.
 * - `pendingDeepLink` holds a path that should actually be replayed after
 *   sign-in. It is only populated when `AppGate` observes that the user is
 *   unauthenticated (i.e. they will see the welcome screen) by promoting the
 *   captured slot via `stashCapturedDeepLink()`.
 *
 * This split ensures an already-authenticated cold start — where Expo Router has
 * already navigated to the deep link natively — never stashes anything, so the
 * replay effect is a no-op and we avoid a redundant `router.replace`.
 */
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';

let capturedDeepLink: string | null = null;
let pendingDeepLink: string | null = null;

/**
 * Whether `path` is a safe in-app destination. We only ever navigate to
 * internal absolute paths, never to the root (nothing to restore) and never to
 * anything carrying a scheme/protocol (open-redirect guard).
 */
function isInternalPath(path: string | null | undefined): path is string {
  if (!path) return false;
  if (!path.startsWith('/')) return false;
  if (path === '/') return false;
  // Reject protocol-relative ("//host") and any scheme-bearing value.
  if (path.startsWith('//')) return false;
  if (path.includes('://')) return false;
  return true;
}

// Snapshot the web entry path at module load, before Expo Router mounts.
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  const initialPath = `${window.location.pathname}${window.location.search}`;
  if (isInternalPath(initialPath)) {
    capturedDeepLink = initialPath;
  }
}

/**
 * Capture the requested cold-start path into the captured slot. No-op on web
 * (already snapshotted at module load) and for any non-internal path.
 */
export async function captureInitialDeepLink(): Promise<void> {
  if (Platform.OS === 'web') {
    return;
  }
  try {
    const url = await Linking.getInitialURL();
    if (!url) return;
    const { path, queryParams } = Linking.parse(url);
    if (!path) return;
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const query = buildQueryString(queryParams);
    const candidate = `${normalized}${query}`;
    if (isInternalPath(candidate)) {
      capturedDeepLink = candidate;
    }
  } catch (error) {
    console.warn('[pendingDeepLink] Failed to read initial URL:', error);
  }
}

function buildQueryString(
  queryParams: Record<string, string | string[] | undefined> | null
): string {
  if (!queryParams) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(queryParams)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/**
 * Promote the captured cold-start path into the pending slot so it will be
 * replayed after sign-in. Called by `AppGate` only when the user is confirmed
 * unauthenticated. Idempotent and a no-op if nothing was captured.
 */
export function stashCapturedDeepLink(): void {
  if (capturedDeepLink) {
    pendingDeepLink = capturedDeepLink;
    capturedDeepLink = null;
  }
}

/** Explicitly stash a pending path (must be an internal absolute path). */
export function setPendingDeepLink(path: string | null | undefined): void {
  if (isInternalPath(path)) {
    pendingDeepLink = path;
  }
}

/** Read and clear the pending path, returning it if one is set. */
export function consumePendingDeepLink(): string | null {
  const value = pendingDeepLink;
  pendingDeepLink = null;
  return value;
}
