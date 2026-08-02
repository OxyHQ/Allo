import { oxyClient } from '@oxyhq/core';
import { Platform } from 'react-native';
import { API_URL } from '@/config';
import { CircuitBreaker } from '@/lib/api/retryLogic';

// API Configuration
const API_CONFIG = {
  baseURL: API_URL,
};

// Backend client for the local Allo backend (conversations, messages, devices, etc.).
//
// This is a linked client owned by the Oxy session: it keeps its bearer token in
// lockstep with the canonical OxyServices session and delegates 401 refresh back
// to that session. No manual Authorization plumbing, no app-local token provider.
// Bearer-authenticated writes do not fetch an app-local CSRF token.
const linkedBackend = oxyClient.createLinkedClient({ baseURL: API_CONFIG.baseURL });
const backendClient = linkedBackend.client;

// Keep oxyClient reference for Oxy-specific API calls (if needed).
// Annotate with the client's own return type: `HttpService` is not re-exported
// from the package root, so an inferred type would reference an internal path.
const authenticatedClient: ReturnType<typeof oxyClient.getClient> = oxyClient.getClient();

// Circuit breakers prevent cascading failures: 5 consecutive failures open the
// circuit for 30 seconds.
//
// They are scoped PER ENDPOINT, never shared across the whole API. A single
// global breaker means any one failing endpoint disables every other one — a
// flaky settings poll would block the device-key lookups that encryption
// depends on, turning an unrelated outage into "no message can be sent at all".
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_FAILURE_WINDOW_MS = 60000;
const CIRCUIT_RESET_MS = 30000;

const circuitBreakers = new Map<string, CircuitBreaker>();

// Path segments that carry an identifier rather than naming a resource. Without
// collapsing them, every recipient would get their own breaker and the map
// would grow without bound.
const IDENTIFIER_SEGMENT = /^(\d+|[0-9a-fA-F]{16,}|[0-9A-Za-z_-]{20,})$/;

/** Groups requests to the same resource, e.g. `/devices/user/abc` -> `/devices/user/:id`. */
function circuitKeyFor(endpoint: string): string {
  const [path] = endpoint.split('?');
  return path
    .split('/')
    .map((segment) => (IDENTIFIER_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
}

function breakerFor(endpoint: string): CircuitBreaker {
  const key = circuitKeyFor(endpoint);
  const existing = circuitBreakers.get(key);
  if (existing) {
    return existing;
  }
  const breaker = new CircuitBreaker(
    CIRCUIT_FAILURE_THRESHOLD,
    CIRCUIT_FAILURE_WINDOW_MS,
    CIRCUIT_RESET_MS,
    key
  );
  circuitBreakers.set(key, breaker);
  return breaker;
}

// Request deduplication cache - prevents duplicate simultaneous requests
// WhatsApp/Telegram pattern: if same request is in flight, return same promise
const pendingRequests = new Map<string, Promise<unknown>>();

function createRequestKey(method: string, endpoint: string, params?: Record<string, unknown>): string {
  return `${method}:${endpoint}:${JSON.stringify(params || {})}`;
}

async function deduplicateRequest<T>(
  key: string,
  requestFn: () => Promise<T>
): Promise<T> {
  // Check if this exact request is already in flight
  const pending = pendingRequests.get(key) as Promise<T> | undefined;
  if (pending) {
    return pending;
  }

  // Execute new request and cache the promise
  const promise = requestFn().finally(() => {
    // Clean up after request completes (success or error)
    pendingRequests.delete(key);
  });

  pendingRequests.set(key, promise);
  return promise;
}

// API methods using the linked backend client for the local Allo backend.
//
// The linked client unwraps the backend's `{ data }` success envelope, so each
// call resolves to the payload directly. The wrapper re-exposes it under `data`
// to keep an axios-like `{ data }` shape for callers.
export const api = {
  async get<T = unknown>(endpoint: string, params?: Record<string, unknown>): Promise<{ data: T }> {
    const key = createRequestKey('GET', endpoint, params);
    const data = await deduplicateRequest(key, () =>
      breakerFor(endpoint).execute(() =>
        backendClient.get<T>(endpoint, { params })
      )
    );
    return { data };
  },

  async post<T = unknown>(endpoint: string, body?: unknown): Promise<{ data: T }> {
    // Don't deduplicate POST requests as they may have side effects
    const data = await breakerFor(endpoint).execute(() =>
      backendClient.post<T>(endpoint, body)
    );
    return { data };
  },

  async put<T = unknown>(endpoint: string, body?: unknown): Promise<{ data: T }> {
    // Don't deduplicate PUT requests as they may have side effects
    const data = await breakerFor(endpoint).execute(() =>
      backendClient.put<T>(endpoint, body)
    );
    return { data };
  },

  async delete<T = unknown>(endpoint: string): Promise<{ data: T }> {
    // Don't deduplicate DELETE requests as they may have side effects
    const data = await breakerFor(endpoint).execute(() =>
      backendClient.delete<T>(endpoint)
    );
    return { data };
  },

  async patch<T = unknown>(endpoint: string, body?: unknown): Promise<{ data: T }> {
    // Don't deduplicate PATCH requests as they may have side effects
    const data = await breakerFor(endpoint).execute(() =>
      backendClient.patch<T>(endpoint, body)
    );
    return { data };
  },
};

export class ApiError extends Error {
  constructor(message: string, public status?: number, public response?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export function webAlert(
  title: string,
  message: string,
  buttons?: Array<{ text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void }>
) {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 1) {
      const result = window.confirm(`${title}\n\n${message}`);
      if (result) {
        const confirmButton = buttons.find(btn => btn.style !== 'cancel');
        confirmButton?.onPress?.();
      } else {
        const cancelButton = buttons.find(btn => btn.style === 'cancel');
        cancelButton?.onPress?.();
      }
    } else {
      window.alert(`${title}\n\n${message}`);
      buttons?.[0]?.onPress?.();
    }
  } else {
    const { Alert } = require('react-native');
    Alert.alert(title, message, buttons);
  }
}

export { authenticatedClient };
