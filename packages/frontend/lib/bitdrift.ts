/**
 * Bitdrift Capture wrapper
 *
 * Safely initializes and exposes the @bitdrift/react-native logger.
 * The module is loaded lazily and tolerated as absent (web bundle, missing
 * native module, no client key configured, etc.) so that callers can always
 * call `logError` / `init` without worrying about the runtime environment.
 */
import { Platform } from 'react-native';

let initialized = false;
let initializing: Promise<void> | null = null;

type BitdriftModule = {
  init: (key: string, sessionStrategy: any, options?: any) => void;
  error: (message: string, fields?: Record<string, string>) => void;
  warn: (message: string, fields?: Record<string, string>) => void;
  info: (message: string, fields?: Record<string, string>) => void;
  SessionStrategy: { Activity: any; Fixed: any };
};

let bd: BitdriftModule | null = null;

async function loadBitdrift(): Promise<BitdriftModule | null> {
  if (bd) return bd;
  if (Platform.OS === 'web') return null;
  try {
    const mod = (await import('@bitdrift/react-native')) as unknown as BitdriftModule;
    if (!mod || typeof mod.init !== 'function') return null;
    bd = mod;
    return bd;
  } catch {
    return null;
  }
}

/**
 * Initialize Bitdrift Capture if a client key is configured via
 * `EXPO_PUBLIC_BITDRIFT_API_KEY`. Safe to call multiple times — only the first
 * call has effect. No-op on web, when the native module is missing, or when
 * the key is not provided.
 */
export async function initBitdrift(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;

  const key = process.env.EXPO_PUBLIC_BITDRIFT_API_KEY;
  if (!key) return;

  initializing = (async () => {
    const mod = await loadBitdrift();
    if (!mod) return;
    try {
      mod.init(key, mod.SessionStrategy.Activity);
      initialized = true;
    } catch {
      // Initialization failure must never crash the app.
    }
  })();

  try {
    await initializing;
  } finally {
    initializing = null;
  }
}

/**
 * Send an error to Bitdrift if available. NoOp when Bitdrift was not
 * initialized or the native module is unavailable.
 */
export async function logError(
  message: string,
  fields?: Record<string, unknown>
): Promise<void> {
  const mod = await loadBitdrift();
  if (!mod) return;
  if (!initialized) return;
  try {
    const stringFields: Record<string, string> = {};
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue;
        stringFields[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
    }
    mod.error(message, stringFields);
  } catch {
    // Swallow — logger must never throw.
  }
}

export function isBitdriftReady(): boolean {
  return initialized;
}
