/**
 * Retry Logic for API Requests
 *
 * WhatsApp/Telegram-level: Automatic retry with exponential backoff
 * Handles network failures gracefully, improves reliability
 */

import { getHttpStatus, getErrorMessage } from '@/utils/errors';

export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableStatusCodes?: number[];
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_CONFIG: Required<RetryConfig> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  shouldRetry: () => true,
};

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, config: Required<RetryConfig>): number {
  // Exponential backoff: delay = initialDelay * (multiplier ^ attempt)
  const exponentialDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);

  // Add jitter (±20%) to prevent thundering herd
  const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);

  // Cap at maxDelay
  return Math.min(exponentialDelay + jitter, config.maxDelayMs);
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: unknown, config: Required<RetryConfig>): boolean {
  const status = getHttpStatus(error);

  // Network errors (no response)
  if (status === undefined) {
    return true;
  }

  // Check status code
  if (config.retryableStatusCodes.includes(status)) {
    return true;
  }

  // 429 Rate Limit - always retry with backoff
  if (status === 429) {
    return true;
  }

  return false;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 *
 * @example
 * const data = await retryWithBackoff(
 *   () => api.get('/messages'),
 *   { maxRetries: 3, initialDelayMs: 1000 }
 * );
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config: RetryConfig = {}
): Promise<T> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  let lastError: unknown;

  for (let attempt = 0; attempt <= fullConfig.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on last attempt
      if (attempt === fullConfig.maxRetries) {
        break;
      }

      // Check if error is retryable
      if (!isRetryableError(error, fullConfig)) {
        throw error;
      }

      // Check custom retry logic
      if (!fullConfig.shouldRetry(error, attempt)) {
        throw error;
      }

      // Calculate delay
      const delay = calculateDelay(attempt, fullConfig);

      console.warn(
        `[Retry] Attempt ${attempt + 1}/${fullConfig.maxRetries} failed. Retrying in ${delay}ms...`,
        {
          error: getErrorMessage(error) ?? error,
          status: getHttpStatus(error),
        }
      );

      // Wait before retry
      await sleep(delay);
    }
  }

  // All retries exhausted
  console.error(
    `[Retry] All ${fullConfig.maxRetries} retry attempts failed`,
    lastError
  );
  throw lastError;
}

/**
 * Create a retryable version of an async function
 *
 * @example
 * const fetchMessagesWithRetry = withRetry(
 *   (conversationId: string) => api.get(`/messages/${conversationId}`),
 *   { maxRetries: 3 }
 * );
 */
export function withRetry<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  config: RetryConfig = {}
): (...args: TArgs) => Promise<TReturn> {
  return (...args: TArgs) => retryWithBackoff(() => fn(...args), config);
}

/**
 * Batch retry for multiple requests
 * Continues even if some fail
 *
 * @example
 * const results = await batchRetry([
 *   () => api.get('/messages/1'),
 *   () => api.get('/messages/2'),
 *   () => api.get('/messages/3'),
 * ]);
 */
export async function batchRetry<T>(
  requests: (() => Promise<T>)[],
  config: RetryConfig = {}
): Promise<Array<{ success: true; data: T } | { success: false; error: unknown }>> {
  return Promise.all(
    requests.map(async (request) => {
      try {
        const data = await retryWithBackoff(request, config);
        return { success: true as const, data };
      } catch (error) {
        return { success: false as const, error };
      }
    })
  );
}

/**
 * Circuit breaker pattern
 * Prevents cascading failures by stopping requests after too many failures
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private threshold: number = 5,
    private timeout: number = 60000, // 1 minute
    private resetTimeout: number = 30000, // 30 seconds
    /** Identifies this breaker in errors and logs, so an open circuit is diagnosable. */
    private name: string = 'api'
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.state === 'open') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure < this.resetTimeout) {
        const retryInSeconds = Math.ceil((this.resetTimeout - timeSinceLastFailure) / 1000);
        throw new Error(
          `Circuit breaker is open for ${this.name} after ${this.failures} failures. ` +
            `Retrying in ${retryInSeconds}s.`
        );
      }
      // Try to transition to half-open
      this.state = 'half-open';
    }

    try {
      const result = await fn();

      // Any success clears the count, not just one that closes a half-open
      // circuit. The breaker trips on *consecutive* failures: a request that
      // succeeds proves the service is up, so earlier isolated failures must
      // not be held against it. Without this, failures accumulate for the
      // lifetime of the app and the circuit eventually opens on a healthy
      // backend.
      this.state = 'closed';
      this.failures = 0;

      return result;
    } catch (error: unknown) {
      // A 4xx is a definitive answer from a healthy server: the request was
      // rejected, the service is fine. Counting those toward the breaker lets
      // an ordinary "not found" — a recipient with no registered device, say —
      // trip the circuit and take down unrelated calls. Only server faults
      // (5xx), an explicit back-off (429), a timeout (408), and transport
      // failures (no status at all) mean the backend is actually in trouble.
      const status = getHttpStatus(error);
      const isClientError =
        status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (isClientError) {
        throw error;
      }

      // Failures older than the window are stale evidence: a fault an hour ago
      // says nothing about the service now, so the run starts over rather than
      // accumulating across unrelated incidents.
      const now = Date.now();
      if (this.failures > 0 && now - this.lastFailureTime > this.timeout) {
        this.failures = 0;
      }

      this.failures++;
      this.lastFailureTime = now;

      // Open circuit if threshold exceeded
      if (this.failures >= this.threshold) {
        this.state = 'open';
        console.error(
          `[Circuit Breaker] Opened for ${this.name} after ${this.failures} failures. ` +
            `Last error: ${getErrorMessage(error)}`
        );
      }

      throw error;
    }
  }

  reset(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }
}
