import { oxyClient } from '@oxyhq/core';
import { Platform } from 'react-native';
import axios from 'axios';
import { API_URL } from '@/config';
import { CircuitBreaker } from '@/lib/api/retryLogic';

// API Configuration
const API_CONFIG = {
  baseURL: API_URL,
};

// Use oxyClient singleton for authenticated requests
const authenticatedClient = oxyClient.getClient();

// Add timeout to authenticated client to prevent indefinite hangs
// Use try-catch in case defaults is not available at initialization time
try {
  if (authenticatedClient?.defaults) {
    authenticatedClient.defaults.timeout = 10000; // 10 second timeout
  }
} catch (error) {
  console.warn('[API] Could not set timeout on authenticated client:', error);
}

// Add request interceptor to ensure timeout is set for all requests
authenticatedClient?.interceptors?.request?.use((config) => {
  // Set timeout if not already set
  if (!config.timeout) {
    config.timeout = 10000; // 10 second timeout
  }
  return config;
});

// Circuit breaker to prevent cascading failures
// Opens after 5 consecutive failures, stays open for 30 seconds
const apiCircuitBreaker = new CircuitBreaker(5, 60000, 30000);

// Request deduplication cache - prevents duplicate simultaneous requests
// WhatsApp/Telegram pattern: if same request is in flight, return same promise
const pendingRequests = new Map<string, Promise<any>>();

function createRequestKey(method: string, endpoint: string, params?: any): string {
  return `${method}:${endpoint}:${JSON.stringify(params || {})}`;
}

async function deduplicateRequest<T>(
  key: string,
  requestFn: () => Promise<T>
): Promise<T> {
  // Check if this exact request is already in flight
  const pending = pendingRequests.get(key);
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

// Public API client (no authentication required)
const publicClient = axios.create({
  baseURL: API_CONFIG.baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 10000, // 10 second timeout to prevent indefinite hangs
});

// API methods using authenticatedClient (with token handling, circuit breaker, and deduplication)
export const api = {
  async get<T = any>(endpoint: string, params?: Record<string, any>): Promise<{ data: T }> {
    const key = createRequestKey('GET', endpoint, params);
    const response = await deduplicateRequest(key, () =>
      apiCircuitBreaker.execute(() =>
        authenticatedClient.get(endpoint, { params })
      )
    );
    return { data: response.data };
  },

  async post<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    // Don't deduplicate POST requests as they may have side effects
    const response = await apiCircuitBreaker.execute(() =>
      authenticatedClient.post(endpoint, body)
    );
    return { data: response.data };
  },

  async put<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    // Don't deduplicate PUT requests as they may have side effects
    const response = await apiCircuitBreaker.execute(() =>
      authenticatedClient.put(endpoint, body)
    );
    return { data: response.data };
  },

  async delete<T = any>(endpoint: string): Promise<{ data: T }> {
    // Don't deduplicate DELETE requests as they may have side effects
    const response = await apiCircuitBreaker.execute(() =>
      authenticatedClient.delete(endpoint)
    );
    return { data: response.data };
  },

  async patch<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    // Don't deduplicate PATCH requests as they may have side effects
    const response = await apiCircuitBreaker.execute(() =>
      authenticatedClient.patch(endpoint, body)
    );
    return { data: response.data };
  },
};

export class ApiError extends Error {
  constructor(message: string, public status?: number, public response?: any) {
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

export const healthApi = {
  async checkHealth() {
    const response = await api.get('/api/health');
    return response.data;
  },
};

// Public API methods (no authentication required)
export const publicApi = {
  async get<T = any>(endpoint: string, params?: Record<string, any>): Promise<{ data: T }> {
    const response = await publicClient.get(endpoint, { params });
    return { data: response.data };
  },
};

export { API_CONFIG, authenticatedClient, publicClient };
