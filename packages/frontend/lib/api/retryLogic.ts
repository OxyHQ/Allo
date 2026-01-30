/**
 * Retry Logic for API Requests
 *
 * WhatsApp/Telegram-level: Automatic retry with exponential backoff
 * Handles network failures gracefully, improves reliability
 */

export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableStatusCodes?: number[];
  shouldRetry?: (error: any, attempt: number) => boolean;
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
function isRetryableError(error: any, config: Required<RetryConfig>): boolean {
  // Network errors (no response)
  if (!error.response) {
    return true;
  }

  // Check status code
  const status = error.response?.status;
  if (status && config.retryableStatusCodes.includes(status)) {
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
  let lastError: any;

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
          error: error.message || error,
          status: error.response?.status,
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
export function withRetry<TArgs extends any[], TReturn>(
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
): Promise<Array<{ success: true; data: T } | { success: false; error: any }>> {
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
    private resetTimeout: number = 30000 // 30 seconds
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if circuit is open
    if (this.state === 'open') {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure < this.resetTimeout) {
        throw new Error('Circuit breaker is open. Service unavailable.');
      }
      // Try to transition to half-open
      this.state = 'half-open';
    }

    try {
      const result = await fn();

      // Success - reset circuit
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failures = 0;
      }

      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();

      // Open circuit if threshold exceeded
      if (this.failures >= this.threshold) {
        this.state = 'open';
        console.error(
          `[Circuit Breaker] Circuit opened after ${this.failures} failures`
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
