import { oxyClient } from '@oxyhq/core';
import { Platform } from 'react-native';
import axios from 'axios';
import { API_URL } from '@/config';
import { CircuitBreaker } from '@/lib/api/retryLogic';

// API Configuration
const API_CONFIG = {
  baseURL: API_URL,
};

// IMPORTANT: Create dedicated client for local backend API (conversations, messages, etc.)
// This is separate from oxyClient which is for Oxy-specific API calls
const backendClient = axios.create({
  baseURL: API_CONFIG.baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 10000, // 10 second timeout
});

// Add request interceptor to backend client to include auth token from Oxy
backendClient.interceptors.request.use((config) => {
  try {
    // Get token from Oxy client's TokenStore (not axios headers)
    const token = oxyClient.getAccessToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  } catch (error) {
    console.warn('[API] Could not get auth token for backend request:', error);
  }
  return config;
});

// Keep oxyClient reference for Oxy-specific API calls (if needed)
const authenticatedClient = oxyClient.getClient();

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

// API methods using backendClient for local backend (conversations, messages, etc.)
// NOTE: This calls your local backend at http://localhost:3000/api, NOT the Oxy API
export const api = {
  async get<T = any>(endpoint: string, params?: Record<string, any>): Promise<{ data: T }> {
    const key = createRequestKey('GET', endpoint, params);
    const response = await deduplicateRequest(key, () =>
      apiCircuitBreaker.execute(() =>
        backendClient.get(endpoint, { params })
      )
    );
    return { data: response.data };
  },

  async post<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    // Don't deduplicate POST requests as they may have side effects
    const response = await apiCircuitBreaker.execute(() =>
      backendClient.post(endpoint, body)
    );
    return { data: response.data };
  },

  async put<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    // Don't deduplicate PUT requests as they may have side effects
    const response = await apiCircuitBreaker.execute(() =>
      backendClient.put(endpoint, body)
    );
    return { data: response.data };
  },

  async delete<T = any>(endpoint: string): Promise<{ data: T }> {
    // Don't deduplicate DELETE requests as they may have side effects
    const response = await apiCircuitBreaker.execute(() =>
      backendClient.delete(endpoint)
    );
    return { data: response.data };
  },

  async patch<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    // Don't deduplicate PATCH requests as they may have side effects
    const response = await apiCircuitBreaker.execute(() =>
      backendClient.patch(endpoint, body)
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

// Profiles API - Telegram-style: Frontend calls backend, backend calls Oxy
export const profilesApi = {
  async getByUsername(username: string) {
    const response = await api.get(`/api/profiles/username/${username}`);
    return response.data;
  },

  async getById(id: string) {
    const response = await api.get(`/api/profiles/${id}`);
    return response.data;
  },

  async search(query: string, limit: number = 20) {
    const response = await api.get('/api/profiles/search', { q: query, limit });
    return response.data;
  },

  async getRecommendations() {
    const response = await api.get('/api/profiles/recommendations');
    return response.data;
  },
};

// Files API - Telegram-style: Frontend calls backend, backend calls Oxy
export const filesApi = {
  async getFileUrl(fileId: string, size: 'thumb' | 'full' | string = 'full'): Promise<string> {
    const response = await api.get(`/api/files/url/${fileId}`, { size });
    return response.data.url;
  },

  async uploadFile(file: any, options?: any) {
    const response = await api.post('/api/files/upload', { file, options });
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
